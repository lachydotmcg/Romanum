import { historyService } from "@/lib/history/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await historyService.games(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Couldn't load games. Try again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
