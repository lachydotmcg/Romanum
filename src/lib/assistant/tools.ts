import type OpenAI from "openai";
import { CHART_KINDS, type ChartSpec, METRIC_KEYS, PALETTE_ORDER } from "@/lib/charts/spec";
import {
  getGameStats,
  getRobloxChart,
  ROBLOX_CHART_IDS,
  ROBLOX_CHARTS,
  type RobloxChartId,
  searchGames,
  universeIdForPlace,
} from "@/lib/roblox";
import { buildChart } from "./chart-tool";
import type { FetchedData } from "./fetched-data";

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
  {
    type: "function",
    function: {
      name: "get_roblox_charts",
      description:
        "Get one of Roblox's own charts (as on roblox.com/charts), in chart order, with each game's universe ID, live players, likes, dislikes and genre. Top Earning is Roblox's ranking only; it contains no revenue figures.",
      parameters: {
        type: "object",
        properties: {
          chart: { type: "string", enum: ROBLOX_CHART_IDS },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "How many games to return. Default 20." },
        },
        required: ["chart"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_chart",
      description:
        "Show a chart or stat tiles in the chat. Values are filled in from data your other tools already fetched in this conversation, so fetch first. Forms: bar (horizontal, best for rankings and long names), column, stacked_bar (parts of a total per game), donut (share of one metric, up to 6 slices), treemap (share across many games), scatter (metrics[0] on x, metrics[1] on y, optional metrics[2] as bubble size), radar (3+ metrics for up to 3 games, each axis relative to the highest value), stat_tiles (headline numbers for up to 3 games).",
      parameters: {
        type: "object",
        properties: {
          // Line charts stay hidden until there is recorded history to draw them from.
          type: { type: "string", enum: CHART_KINDS.filter((kind) => kind !== "line") },
          title: { type: "string", description: "Short title, up to 80 characters." },
          subtitle: { type: "string", description: "Optional one-line context." },
          universeIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 30 },
          metrics: { type: "array", items: { type: "string", enum: METRIC_KEYS }, minItems: 1, maxItems: 6 },
          colors: {
            type: "object",
            description: `Optional colours keyed by universe ID (as a string) or metric name. Values: ${[...PALETTE_ORDER, "gray"].join(", ")}. Scatter and radar allow only blue, orange, aqua and gray.`,
            additionalProperties: { type: "string", enum: [...PALETTE_ORDER, "gray"] },
          },
          highlight: { type: "integer", description: "Universe ID to emphasise; other games turn gray." },
          sort: { type: "string", enum: ["desc", "asc", "none"] },
          logScale: { type: "boolean", description: "Log value axis, for values spanning several orders of magnitude." },
          showValues: { type: "boolean", description: "Label bars or points with their values." },
          format: { type: "string", enum: ["compact", "full", "percent"] },
          size: { type: "string", enum: ["small", "medium", "large"] },
        },
        required: ["type", "title", "universeIds", "metrics"],
        additionalProperties: false,
      },
    },
  },
];

const LABELS: Record<string, string> = {
  search_games: "Search games",
  get_game_stats: "Get game stats",
  resolve_game_link: "Resolve game link",
  get_roblox_charts: "Get Roblox chart",
  create_chart: "Create chart",
};

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  label: string;
  /** What's happening, in words, while the call runs. */
  activity: string;
  detail: string;
};

export type ToolOutcome =
  | { ok: true; result: unknown; summary: string; chart?: ChartSpec }
  | { ok: false; error: string };

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function describe(name: string, args: Record<string, unknown>): { activity: string; detail: string } {
  switch (name) {
    case "search_games": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      return { activity: `Searching for "${query}"`, detail: `"${query}"` };
    }
    case "get_game_stats": {
      const ids = Array.isArray(args.universeIds) ? args.universeIds : [];
      return {
        activity: `Getting stats for ${ids.length} ${ids.length === 1 ? "game" : "games"}`,
        detail: `universe ${ids.join(", ")}`,
      };
    }
    case "resolve_game_link": {
      const link = typeof args.link === "string" ? args.link : "";
      return { activity: "Resolving the game link", detail: link.length > 60 ? `${link.slice(0, 57)}…` : link };
    }
    case "get_roblox_charts": {
      const name = ROBLOX_CHARTS[args.chart as RobloxChartId] ?? String(args.chart ?? "");
      return { activity: `Checking Roblox's ${name} chart`, detail: name };
    }
    case "create_chart": {
      const kind = typeof args.type === "string" ? args.type.replace("_", " ") : "chart";
      const title = typeof args.title === "string" ? args.title : "";
      return { activity: `Building a ${kind} chart`, detail: title };
    }
    default:
      return { activity: `Running ${name}`, detail: "" };
  }
}

function listNames(names: string[]): string {
  return `${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;
}

/** Parses the model's arguments and describes the call, so it can be shown before it runs. */
export function prepareCall(name: string, rawArgs: string): ToolCall {
  const args = parseArgs(rawArgs);
  return { name, args, label: LABELS[name] ?? name, ...describe(name, args) };
}

function placeIdFrom(link: string): number | null {
  const trimmed = link.trim();
  if (/^\d{1,20}$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{1,20})/i);
  return match ? Number(match[1]) : null;
}

/** Validates the arguments, runs the tool and summarises the result for the action list. */
export async function runTool({ name, args }: ToolCall, data: FetchedData): Promise<ToolOutcome> {
  const fail = (error: string): ToolOutcome => ({ ok: false, error });

  try {
    switch (name) {
      case "search_games": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query || query.length > 80) return fail("The query must be 1 to 80 characters.");
        const games = await searchGames(query);
        const summary = games.length
          ? `${games.length} result${games.length === 1 ? "" : "s"}: ${listNames(games.map((g) => g.name))}`
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
              : `${games.length} games: ${listNames(games.map((g) => g.name))}`;
        return { ok: true, result: { fetchedAt: new Date().toISOString(), games }, summary };
      }

      case "resolve_game_link": {
        const placeId = placeIdFrom(typeof args.link === "string" ? args.link : "");
        if (placeId === null) return fail("Use a roblox.com/games/<placeId> link or a numeric place ID.");
        const universeId = await universeIdForPlace(placeId);
        return { ok: true, result: { placeId, universeId }, summary: `Place ${placeId} → universe ${universeId}` };
      }

      case "get_roblox_charts": {
        const chart = args.chart as RobloxChartId;
        if (!ROBLOX_CHART_IDS.includes(chart)) return fail(`"chart" must be one of: ${ROBLOX_CHART_IDS.join(", ")}.`);
        const limit = Math.min(50, Math.max(1, Number.isSafeInteger(args.limit) ? Number(args.limit) : 20));
        const games = (await getRobloxChart(chart)).slice(0, limit);
        return {
          ok: true,
          result: { fetchedAt: new Date().toISOString(), chart: ROBLOX_CHARTS[chart], games },
          summary: games.length ? `${ROBLOX_CHARTS[chart]}: ${listNames(games.map((g) => g.name))}` : "The chart is empty",
        };
      }

      case "create_chart": {
        const built = buildChart(args, data);
        if (!built.ok) return fail(built.error);
        return {
          ok: true,
          result: { rendered: true, type: built.chart.kind, title: built.chart.title, chartColors: built.chartColors },
          summary: built.summary,
          chart: built.chart,
        };
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The lookup failed.");
  }
}
