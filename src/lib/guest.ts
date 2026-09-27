import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { secretsKey } from "./secrets";
import { GUEST_ID, GUEST_SECONDS, signGuest, verifiedGuestId } from "./guest-token";
import { verifyTurnstile } from "./turnstile";
import { historyDatabase } from "./history/database";

// A browser that isn't signed in is an anonymous guest, identified by a random ID in a cookie. Its owner ID keys
// the guest's credits and chats; an account created at sign-in adopts them (see src/lib/accounts).
const COOKIE = "romanum_guest";
async function unclaimed(id: string): Promise<boolean> {
  const database = await historyDatabase();
  if (!database) throw new Error("Guest storage unavailable");
  // An adopted guest cookie, even a signed copy, must not reopen an account after sign-out.
  return (await database.query("SELECT 1 FROM accounts WHERE owner_id=$1", [`guest:${id}`])).rows.length === 0;
}

/** The current guest's owner ID, or null before its first visit. Safe to call from server components. */
export async function readGuest(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value || !value.includes(".")) return null;
  try {
    const id = verifiedGuestId(value, await secretsKey());
    return id && await unclaimed(id) ? `guest:${id}` : null;
  } catch {
    // Like account-session reads, a storage outage must not break public pages or authenticate a guest.
    return null;
  }
}

/** The current guest's owner ID, creating the guest on its first visit. Route handlers only, since it sets a cookie. */
export async function ensureGuest(request: Request): Promise<string> {
  const existing = await readGuest();
  if (existing) return existing;
  await verifyTurnstile(request, "guest");
  const jar = await cookies();
  const legacy = jar.get(COOKIE)?.value;
  // Preserve pre-Turnstile guests after they verify once; never adopt an account's former guest identity.
  const id = legacy && GUEST_ID.test(legacy) && await unclaimed(legacy) ? legacy : randomUUID();
  jar.set(COOKIE, signGuest(id, await secretsKey()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_SECONDS,
  });
  return `guest:${id}`;
}

/**
 * Forgets this browser's guest once a new account has adopted it, so signing out later starts a new guest instead
 * of reopening the account's credits and chats. Route handlers only.
 */
export async function forgetGuest() {
  (await cookies()).delete(COOKIE);
}

/** Whether another site started this request. Routes that create data or spend money refuse these. */
export function isCrossSite(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}
