import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../history/database.ts";
import {
  briefSchema,
  conceptsSchema,
  idSchema,
  ownerIdSchema,
  type Concept,
  type CreativeBrief,
  type ProjectContext,
} from "../creative/schema.ts";

// Owner-private written asset plans. A plan is the written record a model
// proposed for a project: a title, a brief and one to three concepts, saved
// against the exact project revision it was written for. Plans reuse the
// creative_workflows table so later work can share one lineage, but a plan row
// reserves no credits, queues no job and needs no approval. Every read and
// write is scoped to an opaque owner ID, and a project's archived state never
// hides the plans already written for it. This module is server-only: import
// its types into the browser with `import type`, never as a value.

/** Plans one project may keep. */
export const MAX_PLANS = 50;
/** A plan row is recognised by its title; internal workflows leave it null. */
const PLAN_MARKER = "plan_title IS NOT NULL";

export class PlanError extends Error {
  readonly code: "not_found" | "conflict" | "limit" | "invalid_input";
  constructor(code: PlanError["code"], message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

/**
 * The written plan a model proposes. Ownership, budget and permissions are
 * supplied by the server and never accepted here. A UI plan describes assets
 * for a later render, so each concept carries at least one; a thumbnail plan
 * describes a complete composition rather than separate assets.
 */
export const planInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  kind: z.enum(["thumbnail", "ui"]),
  brief: briefSchema,
  concepts: conceptsSchema,
}).strict().superRefine((plan, ctx) => {
  if (plan.kind === "ui" && plan.concepts.some((concept) => concept.assets.length === 0)) {
    ctx.addIssue({ code: "custom", message: "A UI plan needs at least one asset per concept.", path: ["concepts"] });
  }
  if (plan.kind === "thumbnail" && plan.concepts.some((concept) => concept.assets.length > 0)) {
    ctx.addIssue({ code: "custom", message: "A thumbnail plan describes concepts only; it lists no assets.", path: ["concepts"] });
  }
});

export type AssetPlan = {
  id: string;
  projectId: string;
  sourceChatId: string | null;
  title: string;
  kind: "thumbnail" | "ui";
  brief: CreativeBrief;
  concepts: Concept[];
  projectRevision: number;
  projectContext: ProjectContext;
  createdAt: string;
};
export type AssetPlanSummary = {
  id: string;
  projectId: string;
  title: string;
  kind: "thumbnail" | "ui";
  conceptCount: number;
  createdAt: string;
};

type PlanRow = {
  id: string;
  project_id: string;
  source_chat_id: string | null;
  plan_title: string;
  kind: "thumbnail" | "ui";
  brief: CreativeBrief;
  concepts: Concept[];
  project_revision: number;
  project_context: ProjectContext;
  created_at: Date | string;
};
type SavedCallRow = PlanRow & { source_input_hash: string };
type PlanSummaryRow = { id: string; project_id: string; plan_title: string; kind: "thumbnail" | "ui"; concept_count: number; created_at: Date | string };

const PLAN_COLUMNS = "id, project_id, source_chat_id, plan_title, kind, brief, concepts, project_revision, project_context, created_at";
const callIdSchema = z.string().trim().min(1).max(200);
const revisionSchema = z.number().int().positive();

const assetPlan = (row: PlanRow): AssetPlan => ({
  id: row.id,
  projectId: row.project_id,
  sourceChatId: row.source_chat_id,
  title: row.plan_title,
  kind: row.kind,
  brief: row.brief,
  concepts: row.concepts,
  projectRevision: row.project_revision,
  projectContext: row.project_context,
  createdAt: new Date(row.created_at).toISOString(),
});

/** A stable JSON form, so the same parsed call always hashes the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The fingerprint of one call: its project, expected revision and written plan. */
function inputHash(payload: { projectId: string; projectRevision: number } & z.infer<typeof planInputSchema>): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

/**
 * Saves a written plan. The server supplies the owner, project, chat, call ID
 * and revision; the model supplies only the plan itself. The project row is
 * locked so the cap and duplicate calls are serialised, the project must be
 * active at exactly the given revision, and the chat must belong to the same
 * owner and project. A repeated call (same owner, chat and call ID) returns the
 * plan already saved for it when the payload, project and revision match, even
 * after the project was edited or archived; any other retry is a conflict.
 */
export async function createProjectPlan(
  database: Database,
  input: { ownerId: string; projectId: string; chatId: string; callId: string; projectRevision: number; input: unknown },
): Promise<AssetPlan> {
  const owner = ownerIdSchema.safeParse(input.ownerId);
  const callId = callIdSchema.safeParse(input.callId);
  const revision = revisionSchema.safeParse(input.projectRevision);
  if (!owner.success || !callId.success || !revision.success) throw new PlanError("invalid_input", "The plan call is invalid.");
  if (!idSchema.safeParse(input.projectId).success) throw new PlanError("not_found", "Project not found.");
  const chat = idSchema.safeParse(input.chatId);
  if (!chat.success) throw new PlanError("not_found", "Chat not found.");
  const parsed = planInputSchema.safeParse(input.input);
  if (!parsed.success) throw new PlanError("invalid_input", "A plan needs a title of up to 100 characters, a kind, a brief and one to three matching concepts.");
  const plan = parsed.data;
  const chatKey = chat.data;
  const hash = inputHash({ projectId: input.projectId, projectRevision: revision.data, ...plan });

  return database.transaction(async (sql) => {
    const { rows: projects } = await sql.query<{ context: ProjectContext; revision: number; archived: boolean }>(
      "SELECT context, revision, archived FROM creative_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [input.projectId, owner.data],
    );
    const project = projects[0];
    if (!project) throw new PlanError("not_found", "Project not found.");
    // The saved call comes first: a replay must still resolve after the project
    // has moved on, and the chat link is checked through its immutable key.
    const { rows: saved } = await sql.query<SavedCallRow>(
      `SELECT ${PLAN_COLUMNS}, source_input_hash FROM creative_workflows WHERE owner_id=$1 AND source_chat_key=$2 AND source_call_id=$3`,
      [owner.data, chatKey, callId.data],
    );
    if (saved[0]) {
      if (saved[0].source_input_hash !== hash) throw new PlanError("conflict", "This call was already saved with a different plan.");
      return assetPlan(saved[0]);
    }
    if (project.archived) throw new PlanError("conflict", "Restore this project to save a new plan.");
    if (project.revision !== revision.data) throw new PlanError("conflict", "This project changed since the plan was written. Reload and try again.");
    const { rows: chats } = await sql.query("SELECT 1 AS found FROM chats WHERE id=$1 AND owner_id=$2 AND project_id=$3", [chat.data, owner.data, input.projectId]);
    if (!chats[0]) throw new PlanError("not_found", "Chat not found in this project.");
    const { rows: counts } = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM creative_workflows WHERE owner_id=$1 AND project_id=$2 AND ${PLAN_MARKER}`,
      [owner.data, input.projectId],
    );
    if (counts[0].count >= MAX_PLANS) throw new PlanError("limit", `You can keep up to ${MAX_PLANS} plans per project.`);
    const { rows: created } = await sql.query<PlanRow>(
      `INSERT INTO creative_workflows(id, owner_id, project_id, kind, brief, concepts, credit_budget, allow_agent_review, plan_title, project_revision, project_context, source_chat_id, source_chat_key, source_call_id, source_input_hash)
       VALUES ($1,$2,$3,$4,$5,$6,0,false,$7,$8,$9,$10,$11,$12,$13) RETURNING ${PLAN_COLUMNS}`,
      [
        randomUUID(), owner.data, input.projectId, plan.kind, JSON.stringify(plan.brief), JSON.stringify(plan.concepts),
        plan.title, revision.data, JSON.stringify(project.context), chat.data, chatKey, callId.data, hash,
      ],
    );
    return assetPlan(created[0]);
  });
}

/** Reads one owner's written plan, archived projects included. A malformed ID is simply not found. */
export async function readProjectPlan(database: Database, ownerId: string, projectId: string, id: string): Promise<AssetPlan | null> {
  const owner = ownerIdSchema.safeParse(ownerId);
  if (!owner.success || !idSchema.safeParse(projectId).success || !idSchema.safeParse(id).success) return null;
  const { rows } = await database.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM creative_workflows WHERE id=$1 AND project_id=$2 AND owner_id=$3 AND ${PLAN_MARKER}`,
    [id, projectId, owner.data],
  );
  return rows[0] ? assetPlan(rows[0]) : null;
}

/** Lists one project's written plans, newest first, at most {@link MAX_PLANS}. */
export async function listProjectPlans(database: Database, ownerId: string, projectId: string): Promise<AssetPlanSummary[]> {
  const owner = ownerIdSchema.safeParse(ownerId);
  if (!owner.success || !idSchema.safeParse(projectId).success) return [];
  const { rows } = await database.query<PlanSummaryRow>(
    `SELECT id, project_id, plan_title, kind, jsonb_array_length(concepts)::int AS concept_count, created_at
     FROM creative_workflows WHERE owner_id=$1 AND project_id=$2 AND ${PLAN_MARKER}
     ORDER BY created_at DESC, id LIMIT ${MAX_PLANS}`,
    [owner.data, projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.plan_title,
    kind: row.kind,
    conceptCount: row.concept_count,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
