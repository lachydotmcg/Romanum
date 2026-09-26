import { historyService } from "@/lib/history/service";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const result = await historyService.history({ universeId: Number(query.get("universeId")), days: query.has("days") ? Number(query.get("days")) : undefined });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof z.ZodError;
    return Response.json({ error: invalid ? "Choose a valid game and period." : "Couldn't load history. Try again." }, { status: invalid ? 400 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
