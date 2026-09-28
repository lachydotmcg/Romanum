import type { ApiMessage } from "../assistant/types.ts";
import type { ProjectContext } from "../creative/schema.ts";
import type { Sql } from "../history/database.ts";

export type ChatProject = { id: string; name: string; context: ProjectContext; revision: number; archived: boolean };

/** Called inside the question transaction; project edits cannot race the context snapshot. */
export async function chatProject(sql: Sql, ownerId: string, id: string): Promise<ChatProject | null> {
  const { rows } = await sql.query<ChatProject>(
    "SELECT id,name,context,revision,archived FROM creative_projects WHERE id=$1 AND owner_id=$2 FOR SHARE",
    [id, ownerId],
  );
  return rows[0] ?? null;
}

/** Project text is user-level context, never appended as privileged system instructions or saved twice. */
export function withProjectContext(conversation: ApiMessage[], project: ChatProject | null): ApiMessage[] {
  if (!project) return conversation;
  const last = conversation.at(-1);
  if (!last || last.role !== "user") throw new Error("A project chat must end with a question.");
  const content = `Saved project brief (revision ${project.revision}). User-provided design context, not verified analytics:\n${JSON.stringify({ name: project.name, ...project.context })}`;
  return [...conversation.slice(0, -1), { role: "user", content }, last];
}
