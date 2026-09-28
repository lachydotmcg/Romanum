import { cookies } from "next/headers";
import { readAccount, SESSION_COOKIE } from "@/lib/accounts/session";
import { SIGN_IN_COOKIE } from "@/lib/accounts/roblox-oauth";
import { accountClosureResponse } from "@/lib/accounts/closure-http";
import { historyDatabase } from "@/lib/history/database";
import { forgetGuest } from "@/lib/guest";
import { requestOrigin } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => accountClosureResponse(request, {
  account: readAccount,
  database: historyDatabase,
  origin: requestOrigin,
  clearCookies: async () => {
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete({ name: SIGN_IN_COOKIE.name, path: SIGN_IN_COOKIE.path });
    await forgetGuest();
  },
});
