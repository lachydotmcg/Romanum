import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../history/database.ts";
import { contextSchema, idSchema, ownerIdSchema, type ProjectContext } from "../creative/schema.ts";
import { MAX_PROJECTS, projectInputSchema, type ProjectBrief } from "./store.ts";

// Chat-first project context. A signed-in account chats first and saves the
// resulting brief onto the chat that produced it, in one transaction: the chat,
// its messages and its images are never deleted, recreated or reassigned. The
// chat's linked project is the only thing written, and only the account that
// signed in may write it. This module is server-only: import its types into the
// browser with `import type`, never as a value.

export class ConversationContextError extends Error {
  readonly code: "invalid_input" | "not_found" | "conflict" | "limit";
  constructor(code: ConversationContextError["code"], message: string) {
    super(message);
    this.name = "ConversationContextError";
    this.code = code;
  }
}

// Ownership, the chat and the question that asked for this save are all supplied
// by the server. The server-supplied scope is strict so a model or caller cannot
// smuggle in a different project id or extra identity fields. The expected
// revision is the model's last-read version and is checked against storage.
const scopeSchema = z.object({
  ownerId: ownerIdSchema,
  chatId: idSchema,
  questionId: idSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

/**
 * The full save request: the server-scoped envelope plus the project content the
 * chat decided on. The name and context reuse {@link projectInputSchema} exactly,
 * so the content rules never drift from the project store, and todo ids must be
 * distinct even though each id is bounded on its own.
 */
export const chatProjectContextSchema = scopeSchema.extend(projectInputSchema.shape).superRefine((value, ctx) => {
  const todos = value.context.todos;
  if (todos && new Set(todos.map((todo) => todo.id)).size !== todos.length) {
    ctx.addIssue({ code: "custom", message: "Todo ids must be distinct.", path: ["context", "todos"] });
  }
});

type ProjectRow = { id: string; name: string; context: ProjectContext; revision: number; archived: boolean; updated_at: Date | string };
const COLUMNS = "id, name, context, revision, archived, updated_at";

const brief = (row: ProjectRow): ProjectBrief => ({
  id: row.id, name: row.name, context: row.context, revision: row.revision, archived: row.archived,
  updatedAt: new Date(row.updated_at).toISOString(),
});

// A stable JSON form with optional-but-absent keys dropped, so a legacy context
// written before plan/roadmap/todos existed still compares equal to the same
// brief written today. Array order is meaningful and preserved.
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

// True only when the brief already stored reads back as the same normalized
// content, which makes a repeated save an idempotent no-op.
const sameContent = (stored: unknown, incoming: ProjectContext): boolean => {
  const parsed = contextSchema.safeParse(stored);
  return parsed.success && stable(parsed.data) === stable(incoming);
};

/**
 * Saves the chat's decided project context onto the chat that produced it.
 *
 * The chat is locked for the whole transaction, the caller must be the signed-in
 * account that owns it, and the request must be the chat's most recent question,
 * so an old request cannot overwrite a newer decision. When the chat has no
 * project, one is created and linked to this same chat; when it already has one,
 * that project is updated in place under its exact revision. Saving the same
 * normalized name and context twice returns the current project unchanged, even
 * on a stale revision; a different change on a stale revision is a conflict.
 */
export async function saveChatProjectContext(
  database: Database,
  input: { ownerId: string; chatId: string; questionId: string; expectedRevision: number; name: string; context: ProjectContext },
): Promise<ProjectBrief> {
  const parsed = chatProjectContextSchema.safeParse(input);
  if (!parsed.success) throw new ConversationContextError("invalid_input", "Check the project details and revision.");
  const { ownerId, chatId, questionId, expectedRevision, name, context } = parsed.data;
  return database.transaction(async (sql) => {
    // Same owner advisory lock the closure guards take, and taken first, so a
    // closure that races this save serialises with it.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
    // Re-checked under the lock: a closure that won the race has removed the
    // account row, so this is a signed-in account or nothing.
    const { rows: accounts } = await sql.query("SELECT 1 AS found FROM accounts WHERE owner_id=$1", [ownerId]);
    if (!accounts[0]) throw new ConversationContextError("not_found", "Sign in to save this project.");
    const { rows: chats } = await sql.query<{ project_id: string | null }>(
      "SELECT project_id FROM chats WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [chatId, ownerId],
    );
    if (!chats[0]) throw new ConversationContextError("not_found", "Chat not found.");
    // The question must be this chat's own user message, and the most recent one.
    const { rows: asked } = await sql.query("SELECT 1 AS found FROM chat_messages WHERE id=$1 AND chat_id=$2 AND role='user'", [questionId, chatId]);
    if (!asked[0]) throw new ConversationContextError("not_found", "Question not found in this chat.");
    const { rows: latest } = await sql.query<{ id: string }>(
      "SELECT id FROM chat_messages WHERE chat_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1",
      [chatId],
    );
    if (latest[0]?.id !== questionId) throw new ConversationContextError("conflict", "This is no longer the latest question in this chat.");

    const projectId = chats[0].project_id;
    if (!projectId) {
      if (expectedRevision !== 0) throw new ConversationContextError("conflict", "This chat has no saved project yet.");
      // Serialise with createProject's separate advisory key, owner lock held
      // first, so the per-owner cap holds across both creation paths.
      await sql.query("SELECT pg_advisory_xact_lock(hashtext('romanum_projects'), hashtext($1))", [ownerId]);
      const { rows: counts } = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM creative_projects WHERE owner_id=$1", [ownerId]);
      if (counts[0].count >= MAX_PROJECTS) throw new ConversationContextError("limit", `You can keep up to ${MAX_PROJECTS} projects.`);
      const { rows: created } = await sql.query<ProjectRow>(
        `INSERT INTO creative_projects(id, owner_id, name, context) VALUES ($1,$2,$3,$4) RETURNING ${COLUMNS}`,
        [randomUUID(), ownerId, name, JSON.stringify(context)],
      );
      // Attach the existing chat to the new project; the chat and its rows stay.
      await sql.query("UPDATE chats SET project_id=$2, updated_at=now() WHERE id=$1 AND owner_id=$3", [chatId, created[0].id, ownerId]);
      return brief(created[0]);
    }

    const { rows: projects } = await sql.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM creative_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
      [projectId, ownerId],
    );
    const project = projects[0];
    if (!project) throw new ConversationContextError("not_found", "Project not found.");
    if (project.archived) throw new ConversationContextError("conflict", "Restore this project to save changes.");
    // Omitting the optional planning fields is not a request to erase them.
    // Explicit empty strings/arrays still allow a requested reset.
    const nextContext = { ...context };
    if (nextContext.plan === undefined && project.context.plan !== undefined) nextContext.plan = project.context.plan;
    if (nextContext.roadmap === undefined && project.context.roadmap !== undefined) nextContext.roadmap = project.context.roadmap;
    if (nextContext.todos === undefined && project.context.todos !== undefined) nextContext.todos = project.context.todos;
    // Same content is a no-op before the revision is compared, so a repeated
    // save never rewrites or bumps the stored project.
    if (project.name === name && sameContent(project.context, nextContext)) return brief(project);
    if (project.revision !== expectedRevision) throw new ConversationContextError("conflict", "This project changed since you last saw it. Reload and try again.");
    const { rows: updated } = await sql.query<ProjectRow>(
      `UPDATE creative_projects SET name=$3, context=$4, revision=revision+1, updated_at=now()
       WHERE id=$1 AND owner_id=$2 RETURNING ${COLUMNS}`,
      [project.id, ownerId, name, JSON.stringify(nextContext)],
    );
    return brief(updated[0]);
  });
}
