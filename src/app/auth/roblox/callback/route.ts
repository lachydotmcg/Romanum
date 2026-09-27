import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { callbackUrl, completeSignIn, decodeAttempt, oauthClient, SIGN_IN_COOKIE, SignInError, type SignInAttempt } from "@/lib/accounts/roblox-oauth";
import { SESSION_COOKIE } from "@/lib/accounts/session";
import { signInAccount, startSession } from "@/lib/accounts/store";
import { forgetGuest, readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sameValue = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Where to send the person: back where they started, or the profile with what went wrong. */
async function finish(request: Request, attempt: SignInAttempt | null): Promise<string> {
  const params = new URL(request.url).searchParams;
  // No attempt cookie: the sign-in took over ten minutes, or this isn't the browser that started it.
  if (!attempt) return "/profile?signin=expired";
  if (params.get("error")) return params.get("error") === "access_denied" ? "/profile?signin=cancelled" : "/profile?signin=failed";
  const code = params.get("code");
  const state = params.get("state");
  if (!code || code.length > 2000 || !state || !sameValue(state, attempt.state)) return "/profile?signin=failed";

  try {
    const client = oauthClient();
    const database = await historyDatabase();
    if (!client || !database) return "/profile?signin=unavailable";
    const profile = await completeSignIn(client, { code, verifier: attempt.verifier, nonce: attempt.nonce, redirectUri: callbackUrl(request.url) });
    const { account, adoptedGuest } = await signInAccount(database, profile, await readGuest());
    const { token, expiresAt } = await startSession(database, account.id);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: expiresAt,
    });
    if (adoptedGuest) await forgetGuest();
    return attempt.next;
  } catch (error) {
    // Never log the code or tokens: only why it failed.
    console.error("Sign in with Roblox failed.", { reason: error instanceof SignInError ? error.reason : error instanceof Error ? error.name : "unknown" });
    return "/profile?signin=failed";
  }
}

/** Roblox sends the person back here with an authorization code, which signs them in. */
export async function GET(request: Request) {
  const store = await cookies();
  const attempt = decodeAttempt(store.get(SIGN_IN_COOKIE.name)?.value);
  // Each attempt is used once.
  store.set(SIGN_IN_COOKIE.name, "", { path: SIGN_IN_COOKIE.path, maxAge: 0 });
  redirect(await finish(request, attempt));
}
