import type { Database } from "../history/database.ts";
import { MAX_ATTACHMENT_BYTES } from "../chats/limits.ts";
import { ImageInputError } from "../chats/image-input.ts";
import { addProjectReference, deleteProjectReference, listProjectReferences, readProjectReference, ReferenceError } from "./references.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const MAX_BODY = MAX_ATTACHMENT_BYTES + 32_768;
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = { account: () => Promise<{ ownerId: string } | null>; database: () => Promise<Database | null>; origin: (request: Request) => string };

/** Bound the bytes actually received; Content-Length alone is not a body limit. */
async function upload(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new Error("invalid_form");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new Error("body_limit");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_form");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error("body_limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": type } }).formData();
  if ([...form.keys()].some(key => key !== "file" && key !== "metadata") || form.getAll("file").length !== 1 || form.getAll("metadata").length !== 1) throw new Error("invalid_form");
  const file = form.get("file"), metadata = form.get("metadata");
  if (!(file instanceof File) || typeof metadata !== "string" || metadata.length > 4096) throw new Error("invalid_form");
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error("body_limit");
  return { bytes: new Uint8Array(await file.arrayBuffer()), metadata: JSON.parse(metadata) as unknown };
}

export async function referenceResponse(request: Request, deps: Dependencies, projectId: string, referenceId?: string): Promise<Response> {
  if (!["GET", "POST", "DELETE"].includes(request.method) || (request.method === "POST" && referenceId) || (request.method === "DELETE" && !referenceId)) return fail(405, "Method not allowed.");
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== deps.origin(request)) || (request.method !== "GET" && origin !== deps.origin(request))) return fail(403, "Request rejected.");
  try {
    const account = await deps.account();
    if (!account) return fail(401, "Sign in to use project references.");
    const db = await deps.database();
    if (!db) return fail(503, "References unavailable. Try again later.");
    if (request.method === "GET") {
      if (!referenceId) return Response.json({ references: await listProjectReferences(db, account.ownerId, projectId) }, { headers: HEADERS });
      const result = await readProjectReference(db, account.ownerId, projectId, referenceId);
      if (!result) return fail(404, "Reference not found.");
      return new Response(Buffer.from(result.bytes), { headers: { ...HEADERS, "Content-Type": "image/png", "Content-Length": String(result.bytes.length), "Content-Disposition": `inline; filename="${result.reference.id}.png"`, "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    if (request.method === "DELETE") {
      await deleteProjectReference(db, account.ownerId, projectId, referenceId!);
      return Response.json({ deleted: true }, { headers: HEADERS });
    }
    let input;
    try { input = await upload(request); }
    catch (error) { return fail(error instanceof Error && error.message === "body_limit" ? 413 : 400, "Choose one image up to 5 MB and add its details."); }
    const reference = await addProjectReference(db, { ownerId: account.ownerId, projectId, ...input });
    return Response.json({ reference }, { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof ImageInputError) return fail(400, error.message);
    if (error instanceof ReferenceError) {
      if (error.code === "not_found") return fail(404, "Reference or project not found.");
      if (error.code === "limit") return fail(409, "Reference storage is full: up to 24 per project and 25 MB per account.");
      if (error.code === "conflict") return fail(409, request.method === "DELETE" ? "This reference is used by saved creative work." : "Restore this project to add references.");
      return fail(400, "Check the image name and permission details.");
    }
    return fail(503, "References unavailable. Try again later.");
  }
}
