import { welcomeGuest } from "@/lib/credits/guest";
import { welcomeAccount } from "@/lib/credits/account";
import { readAccount } from "@/lib/accounts/session";
import { ensureGuest, isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { verificationResponse } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// POST rather than GET: applies any missing guest welcome or account sign-up
// grant. Identity comes only from the server's session/cookie, never the body.
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403, headers: NO_STORE });
  try {
    const database = await historyDatabase();
    if (!database) throw new Error("No database is configured.");
    const account = await readAccount();
    const { balance, reserved, available } = account
      ? await welcomeAccount(database, account.id)
      : await welcomeGuest(database, await ensureGuest(request));
    return Response.json({ balance, reserved, available }, { headers: NO_STORE });
  } catch (error) {
    const verification = verificationResponse(error);
    if (verification) return verification;
    return Response.json({ error: "Credits unavailable." }, { status: 503, headers: NO_STORE });
  }
}
