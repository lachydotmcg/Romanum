import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { secretsKey } from "./secrets";
import { GUEST_ID, GUEST_SECONDS, pendingGuestId, signGuest, signPendingGuest, verifiedGuestId } from "./guest-token";
import { verifyTurnstile } from "./turnstile";
import { historyDatabase } from "./history/database";

// A browser that isn't signed in is an anonymous guest, identified by a random ID in a cookie. Its owner ID keys
// the guest's credits and chats; an account created at sign-in adopts them (see src/lib/accounts).
const COOKIE = "romanum_guest";
async function unclaimed(id: string): Promise<boolean> {
  const database = await historyDatabase();
  if (!database) throw new Error("Guest storage unavailable");
  // An adopted guest cookie, even a signed copy, must not reopen an account after sign-out.
  return (await database.query("SELECT 1 FROM accounts WHERE owner_id=$1 UNION ALL SELECT 1 FROM account_closures WHERE owner_id=$1", [`guest:${id}`])).rows.length === 0;
}

async function currentGuest(): Promise<{ id: string; verified: boolean } | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value || !value.includes(".")) return null;
  try {
    const key = await secretsKey();
    const verified = verifiedGuestId(value, key);
    const id = verified ?? pendingGuestId(value, key);
    return id && await unclaimed(id) ? { id, verified: verified !== null } : null;
  } catch {
    // Like account-session reads, a storage outage must not break public pages or authenticate a guest.
    return null;
  }
}

/** Reads identity for balances/history without starting verification. Safe in server components. */
export async function readGuest(): Promise<string | null> {
  const guest = await currentGuest();
  return guest ? `guest:${guest.id}` : null;
}

async function newGuestId(): Promise<string> {
  const legacy = (await cookies()).get(COOKIE)?.value;
  // Preserve pre-Turnstile identities; never reopen a guest that was adopted by an account.
  return legacy && GUEST_ID.test(legacy) && await unclaimed(legacy) ? legacy : randomUUID();
}

async function saveGuest(id: string, verified: boolean): Promise<string> {
  const sign = verified ? signGuest : signPendingGuest;
  (await cookies()).set(COOKIE, sign(id, await secretsKey()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GUEST_SECONDS,
  });
  return `guest:${id}`;
}

/** Creates an identity for the welcome balance only. This cookie is not proof of Turnstile. */
export async function ensureGuestIdentity(): Promise<string> {
  const existing = await readGuest();
  return existing ?? await saveGuest(await newGuestId(), false);
}

/** AI submissions require verification before any question is saved or provider called. */
export async function ensureGuest(request: Request): Promise<string> {
  const existing = await currentGuest();
  if (existing?.verified) return `guest:${existing.id}`;
  await verifyTurnstile(request, "guest");
  return saveGuest(existing?.id ?? await newGuestId(), true);
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
