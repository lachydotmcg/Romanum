import { cookies } from "next/headers";
import { ensureGuest, readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { sessionAccount, type Account } from "./store";

// The signed-in account, from the browser's session cookie. A browser that isn't signed in is its guest.
export const SESSION_COOKIE = "romanum_session";

/** The signed-in account, or null. Safe to call from server components. */
export async function readAccount(): Promise<Account | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const database = await historyDatabase();
    return database ? await sessionAccount(database, token) : null;
  } catch {
    return null;
  }
}

/** Who this browser acts as: the signed-in account's owner ID, else its guest's (null before the guest's first visit). */
export async function readOwner(): Promise<string | null> {
  return (await readAccount())?.ownerId ?? (await readGuest());
}

/** For AI submissions: an account session or a Turnstile-verified guest. May set a guest cookie. */
export async function ensureOwner(request: Request): Promise<string> {
  return (await readAccount())?.ownerId ?? (await ensureGuest(request));
}
