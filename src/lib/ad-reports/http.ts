import { z } from "zod";
import type { Database } from "../history/database.ts";
import { idSchema } from "../creative/schema.ts";
import { AD_REPORT_LIMITS, importAdReports, validateAdReportContext } from "./import.ts";
import { AdReportError, deleteAdReport, importAdReport, linkAdReportCreative, readAdReports, saveAdObservation, setAdReportConsent } from "./store.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export const MAX_AD_REPORT_BODY_BYTES = AD_REPORT_LIMITS.uploadBytes + 32_768;
export const MAX_AD_REPORT_JSON_BYTES = 32_768;
type Dependencies = { account: () => Promise<{ ownerId: string } | null>; database: () => Promise<Database | null>; origin: (request: Request) => string };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
const ids = z.array(idSchema).max(20);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consent"), aiAnalysis: z.boolean(), consentVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("link"), reportId: idSchema, adId: z.string().trim().min(1).max(200), creativeId: idSchema }).strict(),
  z.object({ action: z.literal("observation"), status: z.enum(["observation", "hypothesis", "tested"]), text: z.string().trim().min(1).max(4000), reportIds: ids.min(1), creativeIds: ids.optional(), supersedesId: idSchema.optional() }).strict(),
  z.object({ action: z.literal("delete"), reportId: idSchema }).strict(),
]);
class BodyError extends Error { readonly status: number; constructor(status: number) { super("Invalid report request."); this.status = status; } }
async function bounded(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw new BodyError(413);
  const reader = request.body?.getReader(); if (!reader) throw new BodyError(400);
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new BodyError(413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function upload(request: Request, contentType: string) {
  const bytes = await bounded(request, MAX_AD_REPORT_BODY_BYTES);
  const form = await new Response(Buffer.from(bytes), { headers: { "Content-Type": contentType } }).formData();
  if ([...form.keys()].some(key => key !== "file" && key !== "context") || form.getAll("file").length !== 1 || form.getAll("context").length !== 1) throw new BodyError(400);
  const file = form.get("file"), context = form.get("context");
  if (!(file instanceof File) || typeof context !== "string" || context.length > 8192 || !file.size) throw new BodyError(400);
  if (file.size > AD_REPORT_LIMITS.uploadBytes) throw new BodyError(413);
  return importAdReports({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, validateAdReportContext(JSON.parse(context)));
}
/** Session-only, owner-scoped import and manual learning history. No API key. */
export async function adReportsResponse(request: Request, deps: Dependencies, projectId: string): Promise<Response> {
  if (!["GET", "POST"].includes(request.method)) return fail(405, "Method not allowed.");
  const origin = request.headers.get("origin"), expected = deps.origin(request);
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== expected) || (request.method === "POST" && origin !== expected)) return fail(403, "Request rejected.");
  try {
    const account = await deps.account(); if (!account) return fail(401, "Sign in to use private ad reports.");
    const db = await deps.database(); if (!db) return fail(503, "Ad reports unavailable. Try again later.");
    const scope = { ownerId: account.ownerId, projectId };
    if (request.method === "GET") return Response.json(await readAdReports(db, scope.ownerId, projectId), { headers: HEADERS });
    const type = request.headers.get("content-type") ?? "";
    // Check ownership before parsing/decompressing an upload; transactions recheck.
    await readAdReports(db, scope.ownerId, projectId);
    if (type.toLowerCase().startsWith("multipart/form-data;")) {
      let bundle;
      try { bundle = await upload(request, type); }
      catch (error) { if (error instanceof BodyError) throw error; return fail(400, "Choose a supported CSV or ZIP export and check the report context."); }
      const result = await importAdReport(db, { ...scope, bundle });
      return Response.json(result, { status: result.duplicate ? 200 : 201, headers: HEADERS });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(type)) return fail(400, "Use a report upload or a JSON action.");
    let input;
    try { input = actionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bounded(request, MAX_AD_REPORT_JSON_BYTES)))); }
    catch (error) { if (error instanceof BodyError) throw error; return fail(400, "Check the report action details."); }
    if (input.action === "consent") return Response.json({ settings: await setAdReportConsent(db, { ...scope, aiAnalysis: input.aiAnalysis, consentVersion: input.consentVersion }) }, { headers: HEADERS });
    if (input.action === "link") return Response.json({ link: await linkAdReportCreative(db, { ...scope, reportId: input.reportId, adId: input.adId, creativeId: input.creativeId }) }, { status: 201, headers: HEADERS });
    if (input.action === "observation") {
      return Response.json({ observation: await saveAdObservation(db, { ...scope, status: input.status, text: input.text, reportIds: input.reportIds, creativeIds: input.creativeIds, supersedesId: input.supersedesId }) }, { status: 201, headers: HEADERS });
    }
    await deleteAdReport(db, { ...scope, reportId: input.reportId });
    return Response.json({ deleted: true, dependentObservationsDeleted: true }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof BodyError) return fail(error.status, error.status === 413 ? "Report request is too large." : "Check the report request.");
    if (error instanceof AdReportError) return fail(error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : 409, error.message);
    return fail(503, "Ad reports unavailable. Try again later.");
  }
}
