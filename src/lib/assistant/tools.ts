import type OpenAI from "openai";
import { z } from "zod";
import { CHART_KINDS, type ChartSpec, METRIC_KEYS, PALETTE_ORDER } from "../charts/spec.ts";
import { ROBLOX_CHARTS, type RobloxChartId } from "../roblox.ts";
import { PUBLIC_TOOLS, isPublicTool, runPublicTool, publicToolError } from "../public-tools.ts";
import { buildChart } from "./chart-tool.ts";
import type { FetchedData } from "./fetched-data";
import type { SavedPlanCard } from "./types";

export const TOOLS: OpenAI.Chat.ChatCompletionFunctionTool[] = [
  ...Object.entries(PUBLIC_TOOLS).map(([name, tool]): OpenAI.Chat.ChatCompletionFunctionTool => ({
    type: "function",
    function: { name, description: tool.description, parameters: z.toJSONSchema(tool.schema, { target: "draft-7", io: "input" }) },
  })),
  {
    type: "function",
    function: {
      name: "create_chart",
      description:
        "Show a chart or stat tiles in the chat. Values are filled in from data your other tools already fetched in this conversation, so fetch first. Forms: line (one game and one metric over time; fetch get_game_history first, requires at least two observations, keeps gaps), bar (horizontal, best for rankings and long names), column, stacked_bar (parts of a total per game), donut (share of one metric, up to 6 slices), treemap (share across many games), scatter (metrics[0] on x, metrics[1] on y, optional metrics[2] as bubble size), radar (3+ metrics for up to 3 games, each axis relative to the highest value), stat_tiles (headline numbers for up to 3 games).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: CHART_KINDS },
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
  save_asset_plan: "Save asset plan",
  list_asset_plans: "Find saved plans",
  read_asset_plan: "Read asset plan",
  estimate_game_earnings: "Estimate earnings",
  research_game_idea: "Check similar games",
  get_game_history: "Read game history",
  get_market_analysis: "Analyze market patterns",
  load_skill: "Read skill guide",
  get_metric_definitions: "Read metric definitions",
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
  | { ok: true; result: unknown; summary: string; chart?: ChartSpec; plan?: SavedPlanCard }
  | { ok: false; error: string };

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
    case "save_asset_plan":
      return { activity: "Saving a written asset plan", detail: String(args.title ?? "") };
    case "list_asset_plans":
      return { activity: "Finding this project's plans", detail: "" };
    case "read_asset_plan":
      return { activity: "Reading a saved plan", detail: "" };
    case "estimate_game_earnings":
      return { activity: "Estimating earnings from CCU and genre", detail: `${args.days ?? 30} days` };
    case "research_game_idea":
      return { activity: "Checking existing games", detail: String(args.title ?? "") };
    case "get_market_analysis":
      return { activity: "Comparing genres and game patterns", detail: String(args.pattern ?? "all patterns") };
    case "load_skill":
      return { activity: "Reading the assistant's skill guide", detail: String(args.skill ?? "") };
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

/** Parses the model's arguments and describes the call, so it can be shown before it runs. */
export function prepareCall(name: string, rawArgs: string): ToolCall {
  const args = parseArgs(rawArgs);
  return { name, args, label: LABELS[name] ?? name, ...describe(name, args) };
}

/** The assistant and MCP share validated data tools; chart rendering stays local to chat. */
export async function runTool({ name, args }: ToolCall, data: FetchedData): Promise<ToolOutcome> {
  try {
    if (isPublicTool(name)) return { ok: true, ...await runPublicTool(name, args) };
    if (name !== "create_chart") return { ok: false, error: "Unknown tool." };
    const built = buildChart(args, data);
    if (!built.ok) return { ok: false, error: built.error };
    return {
      ok: true,
      result: { rendered: true, type: built.chart.kind, title: built.chart.title, chartColors: built.chartColors },
      summary: built.summary,
      chart: built.chart,
    };
  } catch (error) {
    return { ok: false, error: publicToolError(error) };
  }
}
