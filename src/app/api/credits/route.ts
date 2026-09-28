import { welcomeGuest } from "@/lib/credits/guest";
import { welcomeAccount } from "@/lib/credits/account";
import { readAccount } from "@/lib/accounts/session";
import { ensureGuestIdentity, isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// POST rather than GET: applies missing welcome grants and the current weekly
// floor. Browsing establishes an identity; AI routes verify it before spending.
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403, headers: NO_STORE });
  try {
    const database = await historyDatabase();
    if (!database) throw new Error("No database is configured.");
    const account = await readAccount();
    const { balance, reserved, available } = account
      ? await welcomeAccount(database, account.id)
      : await welcomeGuest(database, await ensureGuestIdentity());
    return Response.json({ balance, reserved, available }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Credits unavailable." }, { status: 503, headers: NO_STORE });
  }
}
