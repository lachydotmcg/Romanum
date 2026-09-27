import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizationUrl, callbackUrl, newSignInAttempt, oauthClient, SIGN_IN_COOKIE } from "@/lib/accounts/roblox-oauth";
import { signAttempt } from "@/lib/accounts/sign-in-cookie";
import { secretsKey } from "@/lib/secrets";
import { historyDatabase } from "@/lib/history/database";
import { isCrossSite } from "@/lib/guest";
import { requestOrigin, verificationResponse, verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function available() {
  try {
    return Boolean(oauthClient() && (await historyDatabase()));
  } catch {
    return false;
  }
}

// Old bookmarks lead to the protected button; a GET must never bypass Turnstile.
export async function GET() {
  redirect("/profile");
}

/** Starts OAuth only after Siteverify; the browser then navigates to the returned Roblox URL. */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (isCrossSite(request) || (request.headers.has("origin") && request.headers.get("origin") !== requestOrigin(request))) {
    return Response.json({ error: "Request rejected." }, { status: 403, headers });
  }
  if (!(await available())) return Response.json({ error: "Sign-in unavailable." }, { status: 503, headers });
  try {
    await verifyTurnstile(request, "roblox_signin");
  } catch (error) {
    return verificationResponse(error) ?? Response.json({ error: "Sign-in unavailable." }, { status: 503, headers });
  }
  const client = oauthClient()!;
  const attempt = newSignInAttempt("/profile");
  (await cookies()).set(SIGN_IN_COOKIE.name, signAttempt(attempt, await secretsKey()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SIGN_IN_COOKIE.path,
    maxAge: SIGN_IN_COOKIE.maxAge,
  });
  return Response.json({ url: authorizationUrl(client, attempt, callbackUrl(request.url)) }, { headers });
}
