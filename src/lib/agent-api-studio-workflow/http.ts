import { z } from "zod";
import type { StudioWorkflow } from "./service.ts";
import { StudioWorkflowError, workflowRequest } from "./contracts.ts";
import { idSchema } from "../creative/schema.ts";

const HEADERS = { "Cache-Control": "no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = {
  enabled?: boolean;
  // Supply the application's existing readAccount, not its guest fallback.
  account: () => Promise<{ ownerId: string } | null>;
  isCrossSite: (request: Request) => boolean;
  workflow: (ownerId: string) => Promise<StudioWorkflow | null>;
};
export async function readStudioBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Private fixture handler: no /mcp route, live transport or guest auth.
 * Request fixtures exercise the same readAccount/isCrossSite dependency shape
 * as projectResponse. Its authored application binding remains disabled;
 * activation/deployment are separate owner-reviewed work.
 */
export async function studioWorkflowResponse(request: Request, deps: Dependencies): Promise<Response> {
  if (request.method !== "GET" && deps.isCrossSite(request)) return fail(403, "Request rejected.");
  try {
    const account = await deps.account();
    if (!account) return fail(401, "Sign in to use Studio actions.");
    if (deps.enabled !== true) return fail(503, "Studio actions unavailable.");
    if (request.method !== "GET" && request.method !== "POST") return fail(405, "Method not allowed.");
    const workflow = await deps.workflow(account.ownerId);
    if (!workflow || workflow.ownerId !== account.ownerId) return fail(503, "Studio actions unavailable.");
    if (request.method === "GET") {
      const query = z.object({ projectId: idSchema, actionId: idSchema.optional() }).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return fail(400, "Invalid Studio request.");
      const { projectId, actionId } = query.data;
      if (actionId) return Response.json({ action: await workflow.read(projectId, actionId) }, { headers: HEADERS });
      const checkpoint = await workflow.checkpoint(projectId);
      try {
        return Response.json({ discovery: await workflow.studios(projectId), checkpoint, connectionAvailable: true }, { headers: HEADERS });
      } catch {
        // Recovery uses committed status even when the transport has disappeared.
        return Response.json({ discovery: { connectionId: "unavailable", sessions: [], capabilities: [] }, checkpoint: { ...checkpoint, selection: null, requiresSelection: true }, connectionAvailable: false }, { headers: HEADERS });
      }
    }
    let raw: unknown;
    try { raw = await readStudioBody(request); }
    catch (error) { return fail(error instanceof Error && error.message === "size" ? 413 : 400, "Invalid Studio request."); }
    const parsed = workflowRequest.safeParse(raw);
    if (!parsed.success) return fail(400, "Invalid Studio request.");
    return Response.json({ result: await workflow.request(parsed.data) }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof StudioWorkflowError) {
      const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : error.code === "unavailable" ? 503 : 409;
      return fail(status, `Studio request: ${error.code}.`);
    }
    return fail(503, "Studio actions unavailable.");
  }
}
