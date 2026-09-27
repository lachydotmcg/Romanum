import { readAttachment } from "@/lib/chats/store";
import { readOwner } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A reference image from one of the owner's chats. Only its owner can read it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await readOwner();
  const { id } = await params;
  let file: Awaited<ReturnType<typeof readAttachment>> = null;
  try {
    const db = await historyDatabase();
    if (owner && db) file = await readAttachment(db, owner, id);
  } catch {
    // Treated as missing below.
  }
  if (!file) return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      // Private to its owner, and a stored attachment never changes.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
