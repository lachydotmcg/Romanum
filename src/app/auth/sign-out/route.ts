import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/accounts/session";
import { endSession } from "@/lib/accounts/store";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signs this browser out. A form posts here, so another site can't sign people out with a link. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403 });
  const store = await cookies();
  try {
    const database = await historyDatabase();
    if (database) await endSession(database, store.get(SESSION_COOKIE)?.value);
  } catch {
    // The cookie is still removed below, which signs this browser out either way.
  }
  store.delete(SESSION_COOKIE);
  // 303 so the browser follows with a GET.
  return new Response(null, { status: 303, headers: { Location: "/profile" } });
}
