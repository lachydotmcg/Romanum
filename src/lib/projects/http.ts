import type { Database } from "../history/database.ts";
import { createProject, listProjects, readProject, updateProject, ProjectError, projectInputSchema, projectUpdateSchema } from "./store.ts";

const HEADERS = { "Cache-Control": "no-store" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = {
  account: () => Promise<{ ownerId: string } | null>;
  database: () => Promise<Database | null>;
  isCrossSite: (request: Request) => boolean;
};

async function readBody(request: Request): Promise<unknown> {
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
      if (size > 196_608) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Account identity is resolved by the server, never accepted from a project payload. */
export async function projectResponse(request: Request, deps: Dependencies, id?: string): Promise<Response> {
  if (request.method !== "GET" && deps.isCrossSite(request)) return fail(403, "Request rejected.");
  const account = await deps.account();
  if (!account) return fail(401, "Sign in to use projects.");
  try {
    const db = await deps.database();
    if (!db) return fail(503, "Projects unavailable. Try again later.");
    if (request.method === "GET") {
      if (id) {
        const project = await readProject(db, account.ownerId, id);
        return project ? Response.json({ project }, { headers: HEADERS }) : fail(404, "Project not found.");
      }
      const archived = new URL(request.url).searchParams.get("archived") === "true";
      return Response.json({ projects: await listProjects(db, account.ownerId, { archived }) }, { headers: HEADERS });
    }
    if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
      let body: unknown;
      try { body = await readBody(request); }
      catch (error) { return error instanceof Error && error.message === "size" ? fail(413, "Project details are too long.") : fail(400, "Invalid project details."); }
      if (id) {
        const input = projectUpdateSchema.safeParse(body);
        if (!input.success) return fail(400, "Check the project details.");
        const project = await updateProject(db, { ...input.data, id, ownerId: account.ownerId });
        return Response.json({ project }, { headers: HEADERS });
      }
      const input = projectInputSchema.safeParse(body);
      if (!input.success) return fail(400, "Check the project details.");
      const project = await createProject(db, { ...input.data, ownerId: account.ownerId });
      return Response.json({ project }, { status: 201, headers: HEADERS });
    }
    return fail(405, "Method not allowed.");
  } catch (error) {
    if (error instanceof ProjectError) {
      if (error.code === "not_found") return fail(404, "Project not found.");
      if (error.code === "conflict") return fail(409, "This context has changed. Reload it to edit.");
      if (error.code === "limit") return fail(409, "You've reached the project limit.");
      return fail(400, "Check the project details.");
    }
    return fail(503, "Projects unavailable. Try again later.");
  }
}
