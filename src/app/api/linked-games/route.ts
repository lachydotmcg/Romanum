import { after } from "next/server";
import { z } from "zod";
import { readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { checkGameKey, plausibleApiKey } from "@/lib/linked-games/link";
import { saveLinkedGame } from "@/lib/linked-games/store";
import { syncDueGames, syncLinkedGame } from "@/lib/linked-games/sync";
import { linkedGameViews } from "@/lib/linked-games/view";
import { secretsKey } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });

async function database() {
  try {
    return await historyDatabase();
  } catch {
    return null;
  }
}

/** The signed-in account's linked games. Games due a sync start one once the response is sent. */
export async function GET() {
  const account = await readAccount();
  if (!account) return failure(401, "Sign in to see your games.");
  const db = await database();
  if (!db) return failure(503, "Your games are unavailable.");
  after(() => syncDueGames(db, { accountId: account.id }).catch(() => {}));
  return Response.json({ games: await linkedGameViews(db, account.id) }, { headers: NO_STORE });
}

const linkInput = z.object({ universeId: z.string().trim().regex(/^[1-9]\d{0,15}$/), apiKey: z.string().trim() });

/** Links a game with the owner's Open Cloud API key, after Roblox confirms the key can read its analytics. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return failure(403, "Request rejected.");
  const account = await readAccount();
  if (!account) return failure(401, "Sign in to link a game.");
  const input = linkInput.safeParse(await request.json().catch(() => null));
  if (!input.success || !plausibleApiKey(input.data.apiKey)) return failure(400, "Enter the game's universe ID and an API key.");
  const db = await database();
  if (!db) return failure(503, "Linking games is unavailable.");

  const universeId = Number(input.data.universeId);
  const check = await checkGameKey(input.data.apiKey, universeId);
  if (!check.ok) return failure(422, check.message);
  const game = await saveLinkedGame(db, { accountId: account.id, universeId, apiKey: input.data.apiKey, keyExpiresAt: check.expiresAt }, await secretsKey());
  after(() => syncLinkedGame(db, game.id).catch(() => {}));
  const [view] = await linkedGameViews(db, account.id, [game]);
  return Response.json({ game: view }, { status: 201, headers: NO_STORE });
}
