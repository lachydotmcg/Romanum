import { z } from "zod";
import { searchPublicGames } from "@/lib/game-discovery";
import { PublicInputError } from "@/lib/public-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await searchPublicGames(new URL(request.url).searchParams.get("q"));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof z.ZodError || error instanceof PublicInputError;
    const message = error instanceof PublicInputError ? error.message : invalid ? "Use a game name (up to 80 characters) or Roblox link." : "Couldn't search games. Try again.";
    return Response.json({ error: message }, { status: invalid ? 400 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
