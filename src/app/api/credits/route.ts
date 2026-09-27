import { welcomeGuest } from "@/lib/credits/guest";
import { ensureGuest, isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// POST rather than GET: on a guest's first visit this creates the guest and grants its welcome credits.
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403, headers: NO_STORE });
  try {
    const database = await historyDatabase();
    if (!database) throw new Error("No database is configured.");
    const { balance, reserved, available } = await welcomeGuest(database, await ensureGuest());
    return Response.json({ balance, reserved, available }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Credits unavailable." }, { status: 503, headers: NO_STORE });
  }
}
