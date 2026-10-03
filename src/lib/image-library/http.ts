import sharp from "sharp";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { inspectPng } from "../creative/image-provider.ts";
import { ImageLibraryInputError, IMAGE_LIBRARY_MAX_QUERY_LENGTH, parseImageLibraryQuery } from "./query.ts";
import type { ImageLibraryStorage } from "./types.ts";

export const IMAGE_LIBRARY_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export type ImageLibraryDependencies = {
  account: () => Promise<{ ownerId: string } | null>;
  storage: () => Promise<ImageLibraryStorage | null>;
  origin: (request: Request) => string;
};
const fail = (status: number, error: string, state?: string) => Response.json({ ...(state ? { status: state } : {}), error }, { status, headers: IMAGE_LIBRARY_HEADERS });

/** All three reads resolve the session afresh. No owner scope comes from the URL or body. */
export async function imageLibraryResponse(request: Request, deps: ImageLibraryDependencies, id?: string, file = false): Promise<Response> {
  if (request.method !== "GET") return fail(405, "Method not allowed.");
  if (request.url.length > IMAGE_LIBRARY_MAX_QUERY_LENGTH) return fail(400, "Check the image-library filters.");
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== deps.origin(request))) return fail(403, "Request rejected.");
  try {
    const account = await deps.account();
    if (!account || !ownerIdSchema.safeParse(account.ownerId).success) return fail(401, "Sign in to view your images.", "sign_in_required");
    const params = new URL(request.url).searchParams;
    let query;
    let thumbnail = false, download = false;
    if (id !== undefined) {
      if (!idSchema.safeParse(id).success) return fail(404, "Image not found.");
      if (file) {
        const keys = [...params.keys()];
        if (keys.some(key => !["variant", "download"].includes(key) || params.getAll(key).length !== 1) ||
          (params.has("variant") && params.get("variant") !== "thumbnail") ||
          (params.has("download") && params.get("download") !== "1") || (params.has("variant") && params.has("download"))) return fail(400, "Check the image request.");
        thumbnail = params.has("variant"); download = params.has("download");
      } else if (params.size) return fail(400, "Check the image request.");
    } else query = parseImageLibraryQuery(params, account.ownerId);
    const storage = await deps.storage();
    if (!storage) return fail(503, "Image library unavailable. Try again later.", "unavailable");
    if (id === undefined) return Response.json({ status: "ready", ...await storage.list(account.ownerId, query!) }, { headers: IMAGE_LIBRARY_HEADERS });
    // Resolve metadata first so an expired/missing file outcome never discloses a foreign image.
    const image = await storage.detail(account.ownerId, id);
    if (!image) return fail(404, "Image not found.");
    if (!file) return Response.json({ image }, { headers: IMAGE_LIBRARY_HEADERS });
    const result = await storage.file(account.ownerId, id);
    if (result.status === "expired") return fail(410, "Image is no longer available.");
    if (result.status !== "ready") return fail(404, "Image not found.");
    let bytes;
    try {
      const shape = inspectPng(result.bytes);
      if (shape.width !== image.width || shape.height !== image.height) return fail(404, "Image not found.");
      bytes = thumbnail ? await sharp(result.bytes, { limitInputPixels: 8_388_608 }).resize(512, 512, { fit: "inside", withoutEnlargement: true }).png().toBuffer() : result.bytes;
    } catch { return fail(404, "Image not found."); }
    return new Response(new Uint8Array(bytes), { headers: {
      ...IMAGE_LIBRARY_HEADERS, "Content-Type": "image/png", "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${image.id}${thumbnail ? "-preview" : ""}.png"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) {
    return error instanceof ImageLibraryInputError ? fail(400, "Check the image-library filters.") : fail(503, "Image library unavailable. Try again later.", "unavailable");
  }
}
