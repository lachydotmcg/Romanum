import { readOwner } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { isCrossSite } from "@/lib/guest";
import { readChatRun, cancelChatRun } from "@/lib/chats/runs";
import { isChatId } from "@/lib/chats/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const owner = await readOwner(), id = (await context.params).id;
  if (!owner || !isChatId(id)) return Response.json({ error: "Review not found." }, { status: 404, headers });
  const database = await historyDatabase().catch(() => null);
  if (!database) return Response.json({ error: "Review unavailable." }, { status: 503, headers });
  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  const run = await readChatRun(database, owner, id, after);
  return run ? Response.json(run, { headers }) : Response.json({ error: "Review not found." }, { status: 404, headers });
}
export async function DELETE(request: Request, context: Context) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403, headers });
  const owner = await readOwner(), id = (await context.params).id;
  if (!owner || !isChatId(id)) return Response.json({ error: "Review not found." }, { status: 404, headers });
  const database = await historyDatabase().catch(() => null);
  if (!database) return Response.json({ error: "Review unavailable." }, { status: 503, headers });
  return await cancelChatRun(database, owner, id) ? new Response(null, { status: 204, headers }) : Response.json({ error: "Review not found." }, { status: 404, headers });
}
