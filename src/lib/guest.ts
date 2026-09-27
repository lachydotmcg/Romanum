import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

// A browser that isn't signed in is an anonymous guest, identified by a random ID in a cookie. Its owner ID keys
// the guest's credits and chats; an account created at sign-in adopts them (see src/lib/accounts).
const COOKIE = "romanum_guest";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** The current guest's owner ID, or null before its first visit. Safe to call from server components. */
export async function readGuest(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  return value && UUID.test(value) ? `guest:${value}` : null;
}

/** The current guest's owner ID, creating the guest on its first visit. Route handlers only, since it sets a cookie. */
export async function ensureGuest(): Promise<string> {
  const existing = await readGuest();
  if (existing) return existing;
  const id = randomUUID();
  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: YEAR_IN_SECONDS,
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
