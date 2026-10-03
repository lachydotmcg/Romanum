import { cookies } from "next/headers";
import { readAccount, SESSION_COOKIE } from "@/lib/accounts/session";
import { readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { accountRecommendationContext, guestRecommendationContext } from "@/lib/models/preference-context";
import { UNKNOWN_RECOMMENDATION_CONTEXT } from "@/lib/models/auto-recommendation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only UI context. No identity creation, grants, billing or provider calls. */
export async function GET() {
  let context = UNKNOWN_RECOMMENDATION_CONTEXT;
  try {
    const hasAccountSession = (await cookies()).has(SESSION_COOKIE);
    if (hasAccountSession) {
      const account = await readAccount();
      const database = account ? await historyDatabase() : null;
      if (account && database) {
        const { rows } = await database.query<{ credit_plan: unknown }>(
          "SELECT credit_plan FROM accounts WHERE id=$1 AND owner_id=$2", [account.id, account.ownerId],
        );
        context = accountRecommendationContext(account.ownerId, rows[0]?.credit_plan);
      }
    } else context = guestRecommendationContext(false, await readGuest());
  } catch { /* Unknown identity/subscription state suppresses optional advice. */ }
  return Response.json(context, { headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" } });
}
