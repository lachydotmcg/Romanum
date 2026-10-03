import { publicModels } from "../../../lib/models/readiness.ts";
import { runtimeExecutionReviews } from "../../../lib/models/provider-schema.ts";
import { historyDatabase } from "../../../lib/history/database.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public configuration metadata only; schema availability never exposes database identity. */
export async function GET() {
  let database = null;
  try { database = await historyDatabase(); } catch { /* Native choices remain unavailable. */ }
  return Response.json(publicModels(undefined, await runtimeExecutionReviews(database)), { headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } });
}
