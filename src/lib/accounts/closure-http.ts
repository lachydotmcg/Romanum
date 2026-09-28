import type { Database } from "../history/database.ts";
import { closeAccount, AccountClosureError } from "./closure.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = {
  account: () => Promise<{ id: string; ownerId: string } | null>;
  database: () => Promise<Database | null>;
  clearCookies: () => Promise<void>;
  origin: (request: Request) => string;
};

/** An exact same-origin JSON confirmation is required before closing an account. */
export async function accountClosureResponse(request: Request, deps: Dependencies): Promise<Response> {
  if (request.method !== "POST") return fail(405, "Method not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("origin") !== deps.origin(request)) return fail(403, "Request rejected.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return fail(400, "Confirm account deletion.");
  try {
    const account = await deps.account();
    if (!account) return fail(401, "Sign in to delete your account.");
    const reader = request.body?.getReader();
    if (!reader) return fail(400, "Confirm account deletion.");
    let length = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024) { await reader.cancel(); return fail(413, "Invalid confirmation."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(400, "Confirm account deletion."); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !("confirmation" in input) || input.confirmation !== "DELETE" || !("accountId" in input) || input.accountId !== account.id) return fail(409, "Check the account and type DELETE to confirm.");
    const db = await deps.database();
    if (!db) return fail(503, "Deletion unavailable. Try again later.");
    await closeAccount(db, { id: account.id, ownerId: account.ownerId });
    await deps.clearCookies();
    return Response.json({ deleted: true }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AccountClosureError) {
      if (error.code === "not_found") return fail(401, "Sign in to delete your account.");
      if (error.code === "unfinished_work") return fail(409, "Unfinished creation work needs review. Contact help@romanum.dev to delete your account.");
      if (error.code === "shared_assets") return fail(409, "Shared asset copies need review. Contact help@romanum.dev to delete your account.");
      if (error.code === "invalid") return fail(400, "Invalid account.");
    }
    return fail(503, "Deletion unavailable. Try again later.");
  }
}
