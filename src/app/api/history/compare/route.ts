import { historyComparisonService } from "@/lib/analytics/history-comparison";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const query = new URL(request.url).searchParams;
    const ids = query.get("universeIds") ?? "";
    const days = query.get("days");
    if ([...query.keys()].some((key) => key !== "universeIds" && key !== "days") ||
      query.getAll("universeIds").length !== 1 || query.getAll("days").length > 1 ||
      !/^[1-9]\d{0,15}(,[1-9]\d{0,15}){1,4}$/.test(ids) ||
      (days !== null && !/^(?:[1-9]|[12]\d|30)$/.test(days))) {
      return Response.json({ error: "Choose two to five distinct public game IDs and a period of one to thirty days." }, { status: 400, headers });
    }
    const result = await historyComparisonService.compare({ universeIds: ids.split(",").map(Number), days: days === null ? undefined : Number(days) });
    return Response.json(result, { headers });
  } catch (error) {
    const invalid = error instanceof z.ZodError;
    return Response.json({ error: invalid ? "Choose two to five distinct public game IDs and a period of one to thirty days." : "Couldn't compare recorded history. Try again." }, { status: invalid ? 400 : 503, headers });
  }
}
