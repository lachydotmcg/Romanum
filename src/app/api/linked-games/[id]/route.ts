import { after } from "next/server";
import { z } from "zod";
import { readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { deleteLinkedGame, readLinkedGame, setCollect, setShare, setAiAnalysis } from "@/lib/linked-games/store";
import { syncLinkedGame } from "@/lib/linked-games/sync";
import { linkedGameViews } from "@/lib/linked-games/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });
const gameId = z.uuid();
const choices = z.object({ collect: z.boolean().optional(), share: z.boolean().optional(), aiAnalysis: z.boolean().optional() }).strict().refine((value) => Object.values(value).some((choice) => choice !== undefined));

type Context = { params: Promise<{ id: string }> };

async function scope(request: Request, context: Context) {
  if (isCrossSite(request)) return { error: failure(403, "Request rejected.") };
  const account = await readAccount();
  if (!account) return { error: failure(401, "Sign in to manage your games.") };
  const id = gameId.safeParse((await context.params).id);
  if (!id.success) return { error: failure(404, "Game not found.") };
  const db = await historyDatabase().catch(() => null);
  if (!db) return { error: failure(503, "Your games are unavailable.") };
  return { account, id: id.data, db };
}

/** Changes collection, AI analysis or improvement sharing for one of the account's games. */
export async function PATCH(request: Request, context: Context) {
  const scoped = await scope(request, context);
  if ("error" in scoped) return scoped.error;
  const { account, id, db } = scoped;
  const input = choices.safeParse(await request.json().catch(() => null));
  if (!input.success) return failure(400, "Choose a setting to change.");
  if (!(await readLinkedGame(db, account.id, id))) return failure(404, "Game not found.");
  if (input.data.collect !== undefined) await setCollect(db, account.id, id, input.data.collect);
  if (input.data.share !== undefined) await setShare(db, account.id, id, input.data.share);
  if (input.data.aiAnalysis !== undefined) await setAiAnalysis(db, account.id, id, input.data.aiAnalysis);
  if (input.data.collect) after(() => syncLinkedGame(db, id).catch(() => {}));
  const game = await readLinkedGame(db, account.id, id);
  if (!game) return failure(404, "Game not found.");
  const [view] = await linkedGameViews(db, account.id, [game]);
  return Response.json({ game: view }, { headers: NO_STORE });
}

/** Deletes one of the account's games with its key and metrics. */
export async function DELETE(request: Request, context: Context) {
  const scoped = await scope(request, context);
  if ("error" in scoped) return scoped.error;
  if (!(await deleteLinkedGame(scoped.db, scoped.account.id, scoped.id))) return failure(404, "Game not found.");
  return new Response(null, { status: 204, headers: NO_STORE });
}
