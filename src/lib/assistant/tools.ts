import type OpenAI from "openai";
import { getGameStats, searchGames, universeIdForPlace } from "@/lib/roblox";

export const TOOLS: OpenAI.Chat.ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "search_games",
      description:
        "Search public Roblox games by name. Returns up to 10 matches with universe ID, root place ID, live player count, likes, dislikes and whether the result is sponsored.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Game name or keywords, e.g. \"adopt me\"." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_game_stats",
      description:
        "Get public stats for 1 to 10 games by universe ID: live players, total visits, favourites, likes, dislikes, like ratio, max players per server, genre, creator, and created/updated dates.",
      parameters: {
        type: "object",
        properties: {
          universeIds: {
            type: "array",
            items: { type: "integer" },
            minItems: 1,
            maxItems: 10,
            description: "Universe IDs (not place IDs).",
          },
        },
        required: ["universeIds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_game_link",
      description:
        "Turn a Roblox game page link (roblox.com/games/<placeId>/...) or a numeric place ID into the game's universe ID.",
      parameters: {
        type: "object",
        properties: {
          link: { type: "string", description: "A roblox.com game URL or a place ID." },
        },
        required: ["link"],
        additionalProperties: false,
      },
    },
  },
];

const LABELS: Record<string, string> = {
  search_games: "Search games",
  get_game_stats: "Get game stats",
  resolve_game_link: "Resolve game link",
};

export type ToolCall = { name: string; args: Record<string, unknown>; label: string; detail: string };

export type ToolOutcome = { ok: true; result: unknown; summary: string } | { ok: false; error: string };

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Short description of what a call asked for, shown next to the action's label. */
function detailFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "search_games":
      return typeof args.query === "string" ? `"${args.query.trim()}"` : "";
    case "get_game_stats":
      return Array.isArray(args.universeIds) ? `universe ${args.universeIds.join(", ")}` : "";
    case "resolve_game_link": {
      const link = typeof args.link === "string" ? args.link : "";
      return link.length > 60 ? `${link.slice(0, 57)}…` : link;
    }
    default:
      return "";
  }
}

function placeIdFrom(link: string): number | null {
  const trimmed = link.trim();
  if (/^\d{1,20}$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{1,20})/i);
  return match ? Number(match[1]) : null;
}

/** Parses the model's arguments and describes the call, so it can be shown before it runs. */
export function prepareCall(name: string, rawArgs: string): ToolCall {
  const args = parseArgs(rawArgs);
  return { name, args, label: LABELS[name] ?? name, detail: detailFor(name, args) };
}

/** Validates the arguments, runs the tool and summarises the result for the action list. */
export async function runTool({ name, args }: ToolCall): Promise<ToolOutcome> {
  const fail = (error: string): ToolOutcome => ({ ok: false, error });

  try {
    switch (name) {
      case "search_games": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query || query.length > 80) return fail("The query must be 1 to 80 characters.");
        const games = await searchGames(query);
        const names = games.slice(0, 3).map((g) => g.name).join(", ");
        const summary = games.length
          ? `${games.length} result${games.length === 1 ? "" : "s"}: ${names}${games.length > 3 ? ", …" : ""}`
          : "No games found";
        return { ok: true, result: { fetchedAt: new Date().toISOString(), games }, summary };
      }

      case "get_game_stats": {
        const ids = Array.isArray(args.universeIds) ? args.universeIds.map(Number) : [];
        if (!ids.length || ids.length > 10 || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
          return fail("Provide 1 to 10 positive integer universe IDs.");
        }
        const games = await getGameStats(ids);
        const [first] = games;
        const summary =
          games.length === 0
            ? "No games found for those IDs"
            : games.length === 1
              ? `${first.name}: ${compact.format(first.playing)} playing · ${compact.format(first.visits)} visits${
                  first.likeRatio === null ? "" : ` · ${Math.round(first.likeRatio * 100)}% likes`
                }`
              : `${games.length} games: ${games.slice(0, 3).map((g) => g.name).join(", ")}${games.length > 3 ? ", …" : ""}`;
        return { ok: true, result: { fetchedAt: new Date().toISOString(), games }, summary };
      }

      case "resolve_game_link": {
        const placeId = placeIdFrom(typeof args.link === "string" ? args.link : "");
        if (placeId === null) return fail("Use a roblox.com/games/<placeId> link or a numeric place ID.");
        const universeId = await universeIdForPlace(placeId);
        return { ok: true, result: { placeId, universeId }, summary: `Place ${placeId} → universe ${universeId}` };
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The lookup failed.");
  }
}
