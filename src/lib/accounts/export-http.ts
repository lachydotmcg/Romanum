import type { Database } from "../history/database.ts";
import { EXPORT_SECTIONS, ExportError, readExportImage, readExportPage, type ExportAccount } from "./data-export.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Cookie" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = { account: () => Promise<ExportAccount | null>; database: () => Promise<Database | null> };

/** Read-only, session-scoped downloads. No client-supplied owner is used as a query scope. */
export async function accountExportResponse(request: Request, deps: Dependencies): Promise<Response> {
  if (request.method !== "GET") return fail(405, "Method not allowed.");
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(request.url).origin)) return fail(403, "Request rejected.");
  try {
    const account = await deps.account();
    if (!account) return fail(401, "Sign in to download your data.");
    // If another tab switches accounts, stop instead of mixing two people's data
    // into one archive. This header is an equality check, never authentication.
    const expected = request.headers.get("x-romanum-export-account");
    if (expected && expected !== account.id) return fail(409, "Your account changed. Start the download again.");
    const headers = { ...HEADERS, "X-Romanum-Export-Account": account.id };
    const params = new URL(request.url).searchParams;
    const section = params.get("section");
    const kind = params.get("image");
    if (section && kind) return fail(400, "Invalid export request.");
    if (!section && !kind) return Response.json({ format: "romanum-data-v1", sections: EXPORT_SECTIONS }, { headers });
    const db = await deps.database();
    if (!db) return fail(503, "Data unavailable. Try again later.");
    if (kind) {
      if (kind !== "chat" && kind !== "creative") return fail(400, "Invalid image request.");
      const offset = params.get("offset") ?? "0";
      if (!/^\d{1,8}$/.test(offset)) return fail(400, "Invalid image request.");
      const image = await readExportImage(db, account, kind, params.get("id") ?? "", Number(offset));
      if (!image) return fail(404, "This image is no longer available. Start the download again.");
      return new Response(new Uint8Array(image.bytes), { headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Image-Type": image.mimeType,
        "X-Image-Bytes": String(image.totalBytes),
        "X-Next-Offset": image.nextOffset === null ? "done" : String(image.nextOffset),
      } });
    }
    return Response.json(await readExportPage(db, account, section!, params.get("after")), { headers });
  } catch (error) {
    if (error instanceof ExportError) {
      if (error.code === "invalid") return fail(400, "Invalid export request.");
      if (error.code === "not_found") return fail(401, "Sign in to download your data.");
      if (error.code === "too_large") return fail(413, "A record exceeds the download limit.");
    }
    return fail(503, "Data unavailable. Try again later.");
  }
}
