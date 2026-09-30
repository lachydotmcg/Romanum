import type { Database } from "../history/database.ts";
import { AdReportError, readAdReportSettings } from "./store.ts";

/** Existing chats keep their server-owned project; request arguments cannot reassign them. */
export async function adReportBackgroundEnabled(db: Database, ownerId: string, input: { chatId: string | null; projectId: string | null }): Promise<boolean> {
  let projectId = input.projectId;
  if (input.chatId) {
    const result = await db.query<{ project_id: string | null }>("SELECT project_id FROM chats WHERE id=$1 AND owner_id=$2", [input.chatId, ownerId]);
    projectId = result.rows[0]?.project_id ?? null;
  }
  if (!projectId) return false;
  try {
    return (await readAdReportSettings(db, ownerId, projectId)).aiAnalysis;
  } catch (error) {
    if (error instanceof AdReportError && error.code === "not_found") return false;
    throw error;
  }
}
