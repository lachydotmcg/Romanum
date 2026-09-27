import { z } from "zod";
import { readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { disconnectGame } from "@/lib/linked-games/store";
import { linkedGameViews } from "@/lib/linked-games/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });

/** Deletes a game's stored key and stops its syncing. Its metrics stay until its data is deleted. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return failure(403, "Request rejected.");
  const account = await readAccount();
  if (!account) return failure(401, "Sign in to manage your games.");
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return failure(404, "Game not found.");
  const db = await historyDatabase().catch(() => null);
  if (!db) return failure(503, "Your games are unavailable.");
  const game = await disconnectGame(db, account.id, id.data);
  if (!game) return failure(404, "Game not found.");
  const [view] = await linkedGameViews(db, account.id, [game]);
  return Response.json({ game: view }, { headers: NO_STORE });
}
