import type { Database } from "../history/database.ts";
import { readProject, type ProjectBrief } from "../projects/store.ts";
import { idSchema } from "../creative/schema.ts";
import type { StudioWorkflow } from "./service.ts";
import { readStudioBody, studioWorkflowResponse } from "./http.ts";

// Deliberately compile-time disabled. No environment variable activates a live
// channel. A later reviewed integration must provide an owner-established resolver.
export const STUDIO_WORKFLOW_ENABLED = false;
export type StudioRouteDependencies = {
  enabled?: boolean;
  account: () => Promise<{ ownerId: string } | null>;
  database: () => Promise<Database | null>;
  origin: (request: Request) => string;
  workflow: (ownerId: string) => Promise<StudioWorkflow | null>;
};
const HEADERS = { "Cache-Control": "no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });

export async function privateStudioResponse(request: Request, deps: StudioRouteDependencies, projectId: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return fail(405, "Method not allowed.");
  if (request.method === "POST" && (request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("origin") !== deps.origin(request))) return fail(403, "Request rejected.");
  try {
    const account = await deps.account();
    if (!account) return fail(401, "Sign in to review Studio changes.");
    if (deps.enabled !== true) return fail(503, "Studio review is not enabled. Use the authored offline preview.");
    if (!idSchema.safeParse(projectId).success) return fail(404, "Project not found.");
    const db = await deps.database();
    if (!db) return fail(503, "Studio review unavailable.");
    if (!await readProject(db, account.ownerId, projectId)) return fail(404, "Project not found.");
    const url = new URL(request.url);
    if (url.searchParams.has("projectId") && url.searchParams.get("projectId") !== projectId) return fail(400, "Project does not match this route.");
    let scoped: Request;
    if (request.method === "POST") {
      let input: unknown;
      try { input = await readStudioBody(request); }
      catch (error) { return fail(error instanceof Error && error.message === "size" ? 413 : 400, "Invalid Studio request."); }
      if (!input || typeof input !== "object" || Array.isArray(input) || ("projectId" in input && input.projectId !== projectId)) return fail(400, "Project does not match this route.");
      scoped = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...input, projectId }) });
    } else {
      url.searchParams.set("projectId", projectId);
      scoped = new Request(url, { headers: request.headers });
    }
    return studioWorkflowResponse(scoped, { enabled: true, account: async () => account, isCrossSite: () => false, workflow: deps.workflow });
  } catch { return fail(503, "Studio review unavailable."); }
}

export async function studioPageContext(deps: Pick<StudioRouteDependencies, "account" | "database" | "enabled">, projectId: string): Promise<{ state: "sign_in" } | { state: "not_found" } | { state: "unavailable" } | { state: "ready" | "disabled"; project: ProjectBrief }> {
  try {
    const account = await deps.account();
    if (!account) return { state: "sign_in" };
    if (!idSchema.safeParse(projectId).success) return { state: "not_found" };
    const db = await deps.database();
    if (!db) return { state: "unavailable" };
    const project = await readProject(db, account.ownerId, projectId);
    return project ? { state: deps.enabled === true ? "ready" : "disabled", project } : { state: "not_found" };
  } catch { return { state: "unavailable" }; }
}
