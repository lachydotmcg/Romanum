import { publicModels } from "../../../lib/models/readiness.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public configuration metadata only. No probing, account access, grants, or provider calls. */
export async function GET() {
  return Response.json(publicModels(), { headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } });
}
