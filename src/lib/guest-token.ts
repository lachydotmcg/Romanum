import { createHmac, timingSafeEqual } from "node:crypto";

export const GUEST_SECONDS = 365 * 24 * 60 * 60;
export const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const signature = (payload: string, key: Buffer) => createHmac("sha256", key).update(`romanum:verified-guest:v1:${payload}`).digest("base64url");

/** A verified guest is signed; inventing a UUID cookie must never unlock a welcome grant. */
export function signGuest(id: string, key: Buffer, now = Date.now()): string {
  if (!GUEST_ID.test(id)) throw new Error("Invalid guest ID");
  const payload = `${id}.${Math.floor(now / 1000)}`;
  return `${payload}.${signature(payload, key)}`;
}

export function verifiedGuestId(value: string | undefined, key: Buffer, now = Date.now()): string | null {
  if (!value || value.length > 120) return null;
  const [id, issued, supplied, extra] = value.split(".");
  if (extra !== undefined || !GUEST_ID.test(id) || !/^\d{10}$/.test(issued ?? "") || !/^[\w-]{43}$/.test(supplied ?? "")) return null;
  const age = Math.floor(now / 1000) - Number(issued);
  if (age < 0 || age >= GUEST_SECONDS) return null;
  const expected = signature(`${id}.${issued}`, key);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? id : null;
}
