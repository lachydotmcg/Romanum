import { historyDatabase } from "../../src/lib/history/database.ts";
import { secretsKey } from "../../src/lib/secrets.ts";
import { validChatRunDispatch } from "../../src/lib/chats/run-dispatch.ts";
import { executeChatRun } from "../../src/lib/chats/run-worker.ts";

export default async function review(request: Request) {
  if (request.method !== "POST" || Number(request.headers.get("content-length")) > 1024) return;
  const raw = await request.text();
  if (raw.length > 1024) return;
  let id: string;
  try {
    id = JSON.parse(raw).runId;
    if (!validChatRunDispatch(await secretsKey(), id, request.headers.get("x-romanum-dispatch") ?? "")) return;
  } catch { return; }
  const database = await historyDatabase();
  if (!database) throw new Error("Review database is unavailable.");
  // Propagate pre-claim failures so Netlify can redeliver. The atomic claim makes any
  // redelivery after a provider attempt a no-op, including ambiguous worker failures.
  await executeChatRun(database, id);
}
export const config = { background: true };
