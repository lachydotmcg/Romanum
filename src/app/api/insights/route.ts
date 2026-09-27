import { currentInsight } from "@/lib/insights/current";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The latest Romanum insight. When it isn't today's, today's generates in the background. */
export async function GET() {
  const current = await currentInsight();
  if (!current) return Response.json({ error: "Insight unavailable." }, { status: 503, headers: NO_STORE });
  return Response.json(current, { headers: NO_STORE });
}
