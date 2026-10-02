import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { StudioBridge, BridgeError } from "../../../packages/studio-bridge/src/index.ts";
import type { ActionProposal, ActionStatus, BridgeCapability, BridgeErrorCode, DispatchOutcome, Discovery, StudioTarget } from "../../../packages/studio-bridge/src/index.ts";
import { MockStudioTransport, STATE_SCHEMA, EDIT_SCHEMA, validateFixtureInput } from "../../../packages/studio-bridge/fixtures/mock-studio.ts";
import { createLocalAgentApi } from "../agent-api/index.ts";
import type { LocalAgentApi } from "../agent-api/index.ts";
import { ownerIdSchema, idSchema } from "../creative/schema.ts";
import { requireProject } from "../creative/storage.ts";
import { readAgentRun } from "../harness/runner.ts";
import type { HarnessModel, HarnessTool, ToolContext } from "../harness/types.ts";
import type { Database } from "../history/database.ts";

export class StudioJobAdapterError extends Error {
  readonly outcome = "not_dispatched";
  readonly code: "unavailable" | "invalid" | "not_found" | "review_required" | "approval_expired" | "write_denied" | "review_mismatch";
  constructor(code: StudioJobAdapterError["code"]) {
    super(`Mock Studio job adapter: ${code}.`);
    this.code = code;
    this.name = "StudioJobAdapterError";
  }
}
export type StudioWriteReview = { runId: string; runnerDigest: string; bridge: ActionProposal; expiresAt: number };
export type StudioActionEvidence = {
  status: ActionStatus | undefined;
  expiresAt: number | null;
  lastFailure: { code: BridgeErrorCode; outcome: DispatchOutcome } | null;
};
export interface MockStudioJobAdapter {
  api: LocalAgentApi;
  discovery: Discovery;
  target: StudioTarget;
  tools: HarnessTool[];
  run: LocalAgentApi["run"];
  prepareWrite(runId: string, actionId: string): Promise<StudioWriteReview>;
  reviewBridge(runId: string, actionId: string, digest: string, approve: boolean): Promise<void>;
  evidence(runId: string, actionId: string): Promise<StudioActionEvidence>;
  close(): void;
}

const readInput = z.object({}).strict();
const writeInput = z.object({
  datamodel_type: z.literal("Edit"),
  edits: z.array(z.object({
    path: z.string().min(1).max(300), oldText: z.string().max(4000), newText: z.string().max(4000),
  }).strict()).min(1).max(10),
}).strict();
const names = { get_studio_state: "studio_get_studio_state", multi_edit: "studio_multi_edit" } as const;

/** Proof fixture only: accepts the existing in-memory mock, never a live channel.
 * Owner/project binding is trusted context, not a new authentication system.
 */
export async function createMockStudioJobAdapter(options: {
  enabled?: boolean;
  database: Database;
  ownerId: string;
  projectId: string;
  studioId: string;
  model: HarnessModel;
  transport: MockStudioTransport;
  approvalTtlMs?: number;
  now?: () => number;
}): Promise<MockStudioJobAdapter> {
  if (options.enabled !== true || options.model.mode !== "test" || !(options.transport instanceof MockStudioTransport)) throw new StudioJobAdapterError("unavailable");
  const { database, model, transport } = options;
  const ownerId = ownerIdSchema.parse(options.ownerId), projectId = idSchema.parse(options.projectId);
  const ttl = z.number().int().min(1).max(30000).parse(options.approvalTtlMs ?? 5000);
  const now = options.now ?? Date.now;
  await requireProject(database, ownerId, projectId);
  const bridge = new StudioBridge(transport, { validateInput: validateFixtureInput });
  try {
    await bridge.initialize();
    const discovery = await bridge.discover();
    const target = bridge.selectStudio(options.studioId); // Explicit trusted choice.
    const reviews = new Map<string, StudioWriteReview>();
    const failures = new Map<string, StudioActionEvidence["lastFailure"]>();
    const catalog = new Map<string, { capability: BridgeCapability; tool: HarnessTool }>();
    async function ownedRun(runId: string) {
      const run = await readAgentRun(database, ownerId, runId);
      if (run.project_id !== projectId || run.auto_project_writes) throw new StudioJobAdapterError("not_found");
      return run;
    }
    async function ownedAction(runId: string, actionId: string) {
      const run = await ownedRun(runId);
      const action = run.actions.find(item => item.id === actionId);
      const entry = action && catalog.get(action.tool_name);
      if (!action || !entry || !run.allowed_tools.includes(action.tool_name)) throw new StudioJobAdapterError("not_found");
      if (action.tool_scope !== "studio" || action.target?.studioId !== target.studioId || action.tool_version !== entry.tool.version || action.effect !== entry.tool.effect) throw new StudioJobAdapterError("invalid");
      return { run, action, entry };
    }
    function approved(actionId: string) {
      const review = reviews.get(actionId);
      if (!review) throw new StudioJobAdapterError("review_required");
      if (now() >= review.expiresAt) throw new StudioJobAdapterError("approval_expired");
      const status = bridge.actionStatus(actionId);
      if (status === "rejected") throw new StudioJobAdapterError("write_denied");
      if (status !== "approved") throw new StudioJobAdapterError("review_required");
      return review;
    }
    for (const capability of discovery.capabilities) {
      const expected = capability.name === "get_studio_state" ? STATE_SCHEMA : EDIT_SCHEMA;
      // Known fixture schemas only. Do not project or guess a live schema.
      if (!isDeepStrictEqual(capability.inputSchema, expected)) throw new StudioJobAdapterError("invalid");
      const schema = capability.name === "get_studio_state" ? readInput : writeInput;
      const tool: HarnessTool = {
        name: names[capability.name], description: `Mock-only Studio ${capability.effect}: ${capability.name}`,
        version: capability.version, scope: "studio", effect: capability.effect,
        target: { studioId: target.studioId }, inputSchema: z.toJSONSchema(schema),
        parse: input => schema.parse(input),
        async execute(input, context: ToolContext) {
          if (context.ownerId !== ownerId || context.projectId !== projectId) throw new StudioJobAdapterError("not_found");
          const { run, action } = await ownedAction(context.runId, context.actionId);
          if (run.status !== "running" || action.status !== "running" || action.tool_name !== tool.name || !isDeepStrictEqual(tool.parse(action.input), input)) throw new StudioJobAdapterError("invalid");
          context.signal.throwIfAborted();
          let timeoutMs = 5000;
          if (capability.effect === "write") {
            const review = approved(action.id); // Runner approval is insufficient.
            if (review.runId !== run.id || !isDeepStrictEqual(review.bridge.input, input)) throw new StudioJobAdapterError("review_mismatch");
            timeoutMs = Math.min(5000, review.expiresAt - now());
            if (timeoutMs < 1) throw new StudioJobAdapterError("approval_expired");
          } else {
            bridge.prepareAction({ actionId: action.id, target, tool: capability.name, version: capability.version, input: readInput.parse(input) });
          }
          try {
            return await bridge.execute(action.id, { signal: context.signal, timeoutMs });
          } catch (error) {
            if (error instanceof BridgeError) failures.set(action.id, { code: error.code, outcome: error.outcome });
            throw error;
          }
        },
      };
      catalog.set(tool.name, { capability, tool });
    }
    const tools = [...catalog.values()].map(entry => entry.tool);
    const api = createLocalAgentApi({ enabled: true, database, ownerId, model, tools });
    return {
      api, tools, discovery: structuredClone(discovery), target: { ...target },
      async run(runId, requestOptions) {
        const run = await ownedRun(runId);
        // Abort must reach durable cancellation even when review is missing.
        if (!requestOptions?.signal?.aborted && run.status === "ready") {
          const pending = run.actions.find(action => action.status === "approved" && action.effect === "write");
          if (pending) { await ownedAction(runId, pending.id); approved(pending.id); }
        }
        return api.run(runId, requestOptions);
      },
      async prepareWrite(runId, actionId) {
        const { run, action, entry } = await ownedAction(runId, actionId);
        if (action.effect !== "write" || !["proposed", "approved"].includes(action.status) || !["awaiting_approval", "ready"].includes(run.status)) throw new StudioJobAdapterError("invalid");
        const prior = reviews.get(action.id);
        if (prior) return structuredClone(prior); // Never refresh expiry/replay.
        const proposal = bridge.prepareAction({
          actionId: action.id, target, tool: entry.capability.name, version: entry.capability.version,
          input: writeInput.parse(action.input),
        });
        const review = { runId, runnerDigest: action.digest, bridge: proposal, expiresAt: now() + ttl };
        reviews.set(action.id, review);
        return structuredClone(review);
      },
      async reviewBridge(runId, actionId, digest, approve) {
        const { run, action } = await ownedAction(runId, actionId);
        const review = reviews.get(actionId);
        if (!review || review.runId !== runId || !["proposed", "approved"].includes(action.status) || !["awaiting_approval", "ready"].includes(run.status)) throw new StudioJobAdapterError("invalid");
        if (now() >= review.expiresAt) throw new StudioJobAdapterError("approval_expired");
        bridge.reviewAction(actionId, digest, approve);
      },
      async evidence(runId, actionId) {
        await ownedAction(runId, actionId);
        return { status: bridge.actionStatus(actionId), expiresAt: reviews.get(actionId)?.expiresAt ?? null, lastFailure: structuredClone(failures.get(actionId) ?? null) };
      },
      close: () => bridge.close(),
    };
  } catch (error) {
    bridge.close();
    throw error;
  }
}
