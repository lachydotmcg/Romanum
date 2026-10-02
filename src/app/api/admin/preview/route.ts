import { adminPreviewRequestAllowed } from "@/lib/admin/access";
import { adminFixtureReport, adminPreviewState } from "@/lib/admin/fixtures";
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
export async function GET(request: Request) {
  if (!adminPreviewRequestAllowed(request)) return Response.json({ error: "Not found." }, { status: 404, headers: HEADERS });
  const state = adminPreviewState(new URL(request.url).searchParams.get("state"));
  const report = adminFixtureReport(state);
  if (!report) return Response.json({ mode: "fixture", error: "Fixture reporting unavailable." }, { status: 503, headers: HEADERS });
  return Response.json({ mode: "fixture", report }, { headers: HEADERS });
}
