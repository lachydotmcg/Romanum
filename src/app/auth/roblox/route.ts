import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizationUrl, callbackUrl, encodeAttempt, newSignInAttempt, oauthClient, SIGN_IN_COOKIE } from "@/lib/accounts/roblox-oauth";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function available() {
  try {
    return Boolean(oauthClient() && (await historyDatabase()));
  } catch {
    return false;
  }
}

/** Starts Sign in with Roblox: keeps this attempt's secrets in a short-lived cookie, then sends the person to Roblox. */
export async function GET(request: Request) {
  if (!(await available())) redirect("/profile?signin=unavailable");
  const client = oauthClient()!;
  const attempt = newSignInAttempt(new URL(request.url).searchParams.get("next"));
  (await cookies()).set(SIGN_IN_COOKIE.name, encodeAttempt(attempt), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SIGN_IN_COOKIE.path,
    maxAge: SIGN_IN_COOKIE.maxAge,
  });
  redirect(authorizationUrl(client, attempt, callbackUrl(request.url)));
}
