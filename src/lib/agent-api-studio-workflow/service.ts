import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StudioBridge, BridgeError } from "../../../packages/studio-bridge/src/index.ts";
import type { ActionProposal, Discovery, JsonObject, StudioTarget } from "../../../packages/studio-bridge/src/index.ts";
import { MockStudioTransport, validateFixtureInput, STATE_SCHEMA, EDIT_SCHEMA } from "../../../packages/studio-bridge/fixtures/mock-studio.ts";
import type { Database, Sql } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { StudioWorkflowError, workflowRequest } from "./contracts.ts";
import type { Selection, WorkflowAction, WorkflowRequest, WorkflowStatus } from "./contracts.ts";

type ActionRow = {
  id: string; selection_id: string; inspection_id: string | null;
  project_revision: number; proposal: ActionProposal; digest: string;
  effect: "read" | "write"; status: WorkflowStatus; dispatch_phase: "pending" | "dispatching";
  result: JsonObject | null; error_code: string | null; expires_at: Date;
  claim_id: string | null; lease_until: Date | null; unexpired: boolean; lease_active: boolean;
};
const localControllers = new Map<string, AbortController>();
const ACTION_COLUMNS = "*, expires_at > clock_timestamp() AS unexpired, lease_until > clock_timestamp() AS lease_active";
const TTL_MS = 30_000, LEASE_MS = 60_000, MAX_RECORDS = 256, MAX_REQUESTS = 2048;

function hash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const iso = (date: Date) => new Date(date).toISOString();
function view(row: ActionRow): WorkflowAction {
  return structuredClone({
    actionId: row.id, selectionId: row.selection_id, inspectionId: row.inspection_id,
    proposal: row.proposal, digest: row.digest, status: row.status, dispatchPhase: row.dispatch_phase,
    result: row.result, errorCode: row.error_code, expiresAt: iso(row.expires_at),
  });
}

/** Fixture-only agent integration. The signed-in owner is server-resolved context.
 * Durable SQL state is authoritative; bridge/controller memory is never recovery proof.
 * No model, worker, server, credential, grant or listener is created here.
 */
export async function createFixtureStudioWorkflow(options: {
  enabled?: boolean; database: Database; ownerId: string; transport: MockStudioTransport;
}): Promise<StudioWorkflow> {
  if (options.enabled !== true || !(options.transport instanceof MockStudioTransport)) throw new StudioWorkflowError("unavailable");
  const bridge = new StudioBridge(options.transport, { validateInput: validateFixtureInput });
  try {
    await bridge.initialize();
    const discovery = await bridge.discover();
    if (discovery.capabilities.length !== 2 || !discovery.capabilities.every(capability => isDeepStrictEqual(capability.inputSchema, capability.name === "get_studio_state" ? STATE_SCHEMA : EDIT_SCHEMA))) throw new StudioWorkflowError("unavailable");
    return new StudioWorkflow(options.database, ownerIdSchema.parse(options.ownerId), bridge);
  } catch (error) { bridge.close(); throw error; }
}

export class StudioWorkflow {
  #database: Database;
  #ownerId: string;
  #bridge: StudioBridge;
  #activeTarget: StudioTarget | undefined;
  constructor(database: Database, ownerId: string, bridge: StudioBridge) {
    this.#database = database; this.#ownerId = ownerIdSchema.parse(ownerId); this.#bridge = bridge;
  }
  get ownerId(): string { return this.#ownerId; }
  close(): void { this.#bridge.close(); }

  async #project(sql: Sql, projectId: string, active = false, lock = false) {
    const { rows } = await sql.query<{ revision: number; archived: boolean }>(`SELECT revision,archived FROM creative_projects WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [idSchema.parse(projectId), this.#ownerId]);
    if (!rows[0]) throw new StudioWorkflowError("not_found");
    if (active && rows[0].archived) throw new StudioWorkflowError("conflict");
    return rows[0];
  }
  async #ownerLock(sql: Sql): Promise<void> {
    // Projects are bounded to 100 per owner. Lock in a stable order so another
    // project cannot race the same owner's Studio uncertainty fence. No new
    // persistent lock/access record or database-wide lock is needed.
    await sql.query("SELECT id FROM creative_projects WHERE owner_id=$1 ORDER BY id FOR UPDATE", [this.#ownerId]);
  }
  async #action(sql: Sql, projectId: string, actionId: string, lock = false): Promise<ActionRow> {
    const { rows } = await sql.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM studio_workflow_actions WHERE id=$1 AND project_id=$2 AND owner_id=$3${lock ? " FOR UPDATE" : ""}`, [idSchema.parse(actionId), projectId, this.#ownerId]);
    if (!rows[0]) throw new StudioWorkflowError("not_found");
    return rows[0];
  }
  async #selection(sql: Sql, projectId: string, selectionId: string): Promise<Selection> {
    const { rows } = await sql.query<{ id: string; target: StudioTarget }>("SELECT id,target FROM studio_workflow_selections WHERE id=$1 AND project_id=$2 AND owner_id=$3", [selectionId, projectId, this.#ownerId]);
    if (!rows[0]) throw new StudioWorkflowError("not_found");
    return { selectionId: rows[0].id, target: rows[0].target };
  }
  #current(target: StudioTarget) {
    if (target.connectionId !== this.#bridge.connectionId || !isDeepStrictEqual(target, this.#activeTarget)) throw new StudioWorkflowError("stale_selection");
  }
  async read(projectId: string, actionId: string): Promise<WorkflowAction> {
    await this.#project(this.#database, projectId);
    return view(await this.#action(this.#database, projectId, actionId));
  }
  async studios(projectId: string): Promise<Discovery> {
    await this.#project(this.#database, projectId);
    return this.#bridge.discover();
  }

  // Serialize idempotency and state changes with the existing owner's project.
  // The key namespace spans all operations, so reuse for a different operation fails.
  async #mutate<T>(request: WorkflowRequest, operation: (sql: Sql) => Promise<{ id: string; value: T }>, replay: (sql: Sql, id: string) => Promise<T>): Promise<T> {
    return this.#database.transaction(async sql => {
      await this.#ownerLock(sql);
      await this.#project(sql, request.projectId, false, true);
      const requestHash = hash(request);
      const prior = (await sql.query<{ request_hash: string; resource_id: string }>("SELECT request_hash,resource_id FROM studio_workflow_requests WHERE owner_id=$1 AND project_id=$2 AND request_key=$3", [this.#ownerId, request.projectId, request.key])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new StudioWorkflowError("conflict");
        return replay(sql, prior.resource_id);
      }
      const count = (await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM studio_workflow_requests WHERE owner_id=$1 AND project_id=$2", [this.#ownerId, request.projectId])).rows[0].count;
      if (count >= MAX_REQUESTS) throw new StudioWorkflowError("limit");
      const result = await operation(sql);
      await sql.query("INSERT INTO studio_workflow_requests(owner_id,project_id,request_key,request_hash,resource_id) VALUES($1,$2,$3,$4,$5)", [this.#ownerId, request.projectId, request.key, requestHash, result.id]);
      return result.value;
    });
  }
  async #writeFence(sql: Sql, projectId: string, target: StudioTarget, inspectionId: string, exceptId: string | null = null) {
    const blocked = await sql.query(`SELECT id FROM studio_workflow_actions
      WHERE owner_id=$1 AND effect='write' AND ($5::uuid IS NULL OR id<>$5::uuid)
      AND ((project_id=$2 AND status IN ('proposed','approved','running','uncertain'))
        OR ((proposal->'target'->>'studioId'=$3 OR ($4::text IS NOT NULL AND proposal->'target'->>'placeId'=$4))
          AND (status IN ('running','uncertain') OR (status='succeeded' AND updated_at >=
            (SELECT created_at FROM studio_workflow_actions WHERE id=$6))))) LIMIT 1`,
    [this.#ownerId, projectId, target.studioId, target.placeId ?? null, exceptId, inspectionId]);
    if (blocked.rows.length) throw new StudioWorkflowError("conflict");
  }
  async #insert(sql: Sql, request: WorkflowRequest, selection: Selection, input: JsonObject, inspection?: ActionRow): Promise<ActionRow> {
    const project = await this.#project(sql, request.projectId, true);
    if (inspection && inspection.project_revision !== project.revision) throw new StudioWorkflowError("conflict");
    if (inspection) {
      // A new key/selection cannot bypass an unresolved write. Even a known
      // success requires a new inspection before another proposed mutation.
      await this.#writeFence(sql, request.projectId, selection.target, inspection.id);
    }
    this.#current(selection.target);
    const count = (await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM studio_workflow_actions WHERE owner_id=$1 AND project_id=$2", [this.#ownerId, request.projectId])).rows[0].count;
    if (count >= MAX_RECORDS) throw new StudioWorkflowError("limit");
    const tool = inspection ? "multi_edit" : "get_studio_state";
    const discovery = await this.#bridge.discover();
    const capability = discovery.capabilities.find(item => item.name === tool);
    if (!capability) throw new StudioWorkflowError("unavailable");
    const actionId = randomUUID();
    const proposal = this.#bridge.prepareAction({ actionId, target: selection.target, tool, version: capability.version, input });
    // Owner review binds its project revision and exact preceding read as well
    // as the bridge's complete selection/tool/input digest.
    const digest = hash({ owner: this.#ownerId, project: request.projectId, revision: project.revision, proposal: proposal.digest, inspection: inspection ? { id: inspection.id, digest: inspection.digest, result: hash(inspection.result) } : null });
    await sql.query("INSERT INTO studio_workflow_actions(id,owner_id,project_id,selection_id,inspection_id,project_revision,proposal,digest,effect,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11*interval '1 millisecond')", [actionId, this.#ownerId, request.projectId, selection.selectionId, inspection?.id ?? null, project.revision, JSON.stringify(proposal), digest, proposal.effect, inspection ? "proposed" : "approved", TTL_MS]);
    return this.#action(sql, request.projectId, actionId);
  }

  async request(input: unknown): Promise<Selection | WorkflowAction> {
    const parsed = workflowRequest.safeParse(input);
    if (!parsed.success) throw new StudioWorkflowError("invalid");
    const request = parsed.data;
    const projectId = request.projectId;
    const replayAction = async (sql: Sql, id: string) => view(await this.#action(sql, projectId, id));
    if (request.operation === "select") {
      return this.#mutate(request, async sql => {
        await this.#project(sql, projectId, true);
        const count = (await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM studio_workflow_selections WHERE owner_id=$1 AND project_id=$2", [this.#ownerId, projectId])).rows[0].count;
        if (count >= MAX_RECORDS) throw new StudioWorkflowError("limit");
        await this.#bridge.discover();
        const target = this.#bridge.selectStudio(request.studioId);
        this.#activeTarget = target;
        const selectionId = randomUUID();
        await sql.query("INSERT INTO studio_workflow_selections(id,owner_id,project_id,target) VALUES($1,$2,$3,$4)", [selectionId, this.#ownerId, projectId, JSON.stringify(target)]);
        return { id: selectionId, value: { selectionId, target } };
      }, (sql, id) => this.#selection(sql, projectId, id));
    }
    if (request.operation === "inspect" || request.operation === "propose") {
      const action = await this.#mutate(request, async sql => {
        let inspection: ActionRow | undefined;
        if (request.operation === "propose") {
          inspection = await this.#action(sql, projectId, request.inspectionId);
          if (inspection.effect !== "read" || inspection.status !== "succeeded" || !inspection.unexpired) throw new StudioWorkflowError("conflict");
        }
        const selection = await this.#selection(sql, projectId, request.operation === "inspect" ? request.selectionId : inspection!.selection_id);
        const row = await this.#insert(sql, request, selection, request.operation === "inspect" ? {} : request.input, inspection);
        return { id: row.id, value: view(row) };
      }, replayAction);
      // Only reads may safely resume the gap between creation and durable claim.
      if (request.operation === "inspect" && action.status === "approved") return this.#dispatch(projectId, action.actionId);
      return action;
    }
    if (request.operation === "execute") {
      // The receipt and dispatch claim commit together. Replaying any persisted
      // receipt, including running/uncertain, never creates a second attempt.
      const claimed = await this.#mutate(request, async sql => {
        const row = await this.#claim(sql, projectId, request.actionId);
        return { id: row.id, value: { action: view(row), claim: row.claim_id } };
      }, async (sql, id) => ({ action: await replayAction(sql, id), claim: null as string | null }));
      return claimed.claim ? this.#run(projectId, claimed.action.actionId, claimed.claim) : claimed.action;
    }
    const result = await this.#mutate(request, async sql => {
      const row = await this.#action(sql, projectId, request.actionId, true);
      if (request.operation === "review") {
        const project = await this.#project(sql, projectId, true);
        this.#current(row.proposal.target);
        if (!row.unexpired) throw new StudioWorkflowError("approval_expired");
        if (row.effect !== "write" || row.status !== "proposed" || row.digest !== request.digest || row.project_revision !== project.revision) throw new StudioWorkflowError("conflict");
        // Durable review is the sole owner decision. The in-memory bridge gate
        // is applied by the executor only after its SQL claim commits.
        await sql.query("UPDATE studio_workflow_actions SET status=$2,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [row.id, request.approve ? "approved" : "rejected"]);
      } else {
        if (request.operation === "recover" && (row.status !== "running" || row.lease_active)) throw new StudioWorkflowError("conflict");
        if (["proposed", "approved", "running"].includes(row.status)) {
          const uncertain = row.effect === "write" && row.dispatch_phase === "dispatching";
          await sql.query("UPDATE studio_workflow_actions SET status=$2,error_code=$3,claim_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [row.id, uncertain ? "uncertain" : "cancelled", uncertain ? "reconciliation_required" : request.operation === "recover" ? "interrupted" : "cancelled"]);
        }
      }
      return { id: row.id, value: await replayAction(sql, row.id) };
    }, replayAction);
    if (request.operation === "cancel" || request.operation === "recover") localControllers.get(request.actionId)?.abort();
    return result;
  }

  async #claim(sql: Sql, projectId: string, actionId: string): Promise<ActionRow> {
    const project = await this.#project(sql, projectId, true);
    const row = await this.#action(sql, projectId, actionId, true);
    this.#current(row.proposal.target);
    if (row.status !== "approved" || row.project_revision !== project.revision) throw new StudioWorkflowError("conflict");
    if (!row.unexpired) throw new StudioWorkflowError("approval_expired");
    if (row.effect === "write") await this.#writeFence(sql, projectId, row.proposal.target, row.inspection_id!, row.id);
    await sql.query("UPDATE studio_workflow_actions SET status='running',claim_id=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1", [row.id, randomUUID(), LEASE_MS]);
    return this.#action(sql, projectId, actionId);
  }
  async #dispatch(projectId: string, actionId: string): Promise<WorkflowAction> {
    const row = await this.#database.transaction(async sql => {
      await this.#ownerLock(sql);
      await this.#project(sql, projectId, false, true);
      const current = await this.#action(sql, projectId, actionId);
      return current.status === "approved" ? { row: await this.#claim(sql, projectId, actionId), claimed: true } : { row: current, claimed: false };
    });
    return row.claimed ? this.#run(projectId, actionId, row.row.claim_id!) : view(row.row);
  }
  async #run(projectId: string, actionId: string, claim: string): Promise<WorkflowAction> {
    const controller = new AbortController();
    localControllers.set(actionId, controller);
    let result: JsonObject | null = null;
    let failure: BridgeError | undefined;
    try {
      const row = await this.#action(this.#database, projectId, actionId);
      if (row.claim_id !== claim || row.status !== "running") return view(row);
      // Approval memory can lag a committed SQL review, but cannot broaden it.
      if (row.effect === "write" && this.#bridge.actionStatus(actionId) === "proposed") this.#bridge.reviewAction(actionId, row.proposal.digest, true);
      result = await this.#bridge.execute(actionId, {
        signal: controller.signal,
        beforeDispatch: () => this.#database.transaction(async sql => {
          await this.#ownerLock(sql);
          const project = await this.#project(sql, projectId, true, true);
          const current = await this.#action(sql, projectId, actionId, true);
          this.#current(current.proposal.target);
          if (current.status !== "running" || current.claim_id !== claim || !current.lease_active || project.revision !== current.project_revision) throw new StudioWorkflowError("conflict");
          if (!current.unexpired) throw new StudioWorkflowError("approval_expired");
          if (current.effect === "write") await this.#writeFence(sql, projectId, current.proposal.target, current.inspection_id!, current.id);
          // Persist before send. Crash in the small commit→send gap is ambiguous
          // and deliberately requires reconciliation rather than a retry.
          await sql.query("UPDATE studio_workflow_actions SET dispatch_phase='dispatching',updated_at=clock_timestamp() WHERE id=$1", [actionId]);
        }),
      });
    } catch (error) {
      failure = error instanceof BridgeError ? error : new BridgeError("protocol_error", "unknown");
    } finally {
      if (localControllers.get(actionId) === controller) localControllers.delete(actionId);
    }
    await this.#database.transaction(async sql => {
      await this.#ownerLock(sql);
      await this.#project(sql, projectId, false, true);
      const row = await this.#action(sql, projectId, actionId, true);
      if (row.status !== "running" || row.claim_id !== claim) return; // cancelled/recovered; reject late completion
      const uncertain = row.effect === "write" && row.dispatch_phase === "dispatching" && (!row.lease_active || failure?.outcome === "unknown");
      const status = uncertain ? "uncertain" : result && row.lease_active ? "succeeded" : "failed";
      await sql.query("UPDATE studio_workflow_actions SET status=$2,result=$3,error_code=$4,claim_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [actionId, status, status === "succeeded" ? JSON.stringify(result) : null, uncertain ? "reconciliation_required" : failure?.code ?? (status === "failed" ? "interrupted" : null)]);
    });
    return this.read(projectId, actionId);
  }
}
