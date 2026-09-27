import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeAttempt, encodeAttempt, SIGN_IN_COOKIE, type SignInAttempt } from "./roblox-oauth.ts";

const signature = (payload: string, key: Buffer) => createHmac("sha256", key).update(`romanum:verified-signin:v1:${payload}`).digest("base64url");

/** Only the verified start route may issue an OAuth attempt; a fabricated callback cookie isn't proof. */
export function signAttempt(attempt: SignInAttempt, key: Buffer, now = Date.now()): string {
  const payload = `${Math.floor(now / 1000)}.${encodeAttempt(attempt)}`;
  return `${payload}.${signature(payload, key)}`;
}

export function verifiedAttempt(value: string | undefined, key: Buffer, now = Date.now()): SignInAttempt | null {
  if (!value || value.length > 1200) return null;
  const [issued, encoded, supplied, extra] = value.split(".");
  if (extra !== undefined || !/^\d{10}$/.test(issued ?? "") || !/^[\w-]{43}$/.test(supplied ?? "")) return null;
  const age = Math.floor(now / 1000) - Number(issued);
  if (age < 0 || age >= SIGN_IN_COOKIE.maxAge) return null;
  const expected = signature(`${issued}.${encoded}`, key);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? decodeAttempt(encoded) : null;
}
