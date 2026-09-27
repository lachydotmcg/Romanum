import type { SampleGame } from "../market-analysis.ts";
import type { GameStats } from "../roblox.ts";
import { colorHex, PALETTE_ORDER, type ChartSpec } from "../charts/spec.ts";
import { currentEarnings } from "./earnings.ts";

export type ExplorerGame = SampleGame & {
  creatorName: string | null;
  visits: number | null;
  favorites: number | null;
  likeRatio: number | null;
  created: string | null;
};

export const EXPLORER_METRICS = {
  playing: "Players now",
  visits: "Visits",
  favorites: "Favourites",
  likeRatio: "Rating",
  estimatedRobux: "Est. earnings",
} as const;
export type ExplorerMetric = keyof typeof EXPLORER_METRICS;
export type ExplorerSort = ExplorerMetric | "created";

/** Keep chart CCU and genre together; detail failures leave only missing fields empty. */
export function mergeGameDetails(games: SampleGame[], details: GameStats[]): ExplorerGame[] {
  const byId = new Map(details.map((game) => [game.universeId, game]));
  return games.map((game) => {
    const detail = byId.get(game.universeId);
    const votes = game.likes + game.dislikes;
    return {
      ...game,
      creatorName: detail?.creator.name ?? null,
      visits: detail?.visits ?? null,
      favorites: detail?.favorites ?? null,
      likeRatio: detail ? detail.likeRatio : votes > 0 ? game.likes / votes : null,
      created: detail?.created ?? null,
    };
  });
}

export function filterGames(games: ExplorerGame[], options: {
  query: string; genre: string; chart: string; sort: ExplorerSort; ascending: boolean;
}): ExplorerGame[] {
  const query = options.query.trim().toLocaleLowerCase();
  return games.filter((game) =>
    (!query || `${game.name} ${game.creatorName ?? ""}`.toLocaleLowerCase().includes(query)) &&
    (!options.genre || (game.genre || "Unlisted") === options.genre) &&
    (!options.chart || game.charts.some((chart) => chart === options.chart))
  ).sort((a, b) => {
    const value = (game: ExplorerGame) => options.sort === "created"
      ? game.created && Number.isFinite(Date.parse(game.created)) ? Date.parse(game.created) : null
      : options.sort === "estimatedRobux" ? (() => { const range = currentEarnings(game)?.robux; return range ? (range.low + range.high) / 2 : null; })()
      : game[options.sort];
    const left = value(a), right = value(b);
    // Missing values are always last, including ascending sorts. Zero is an observation.
    if (left === null || right === null) return left === right ? a.universeId - b.universeId : left === null ? 1 : -1;
    return (options.ascending ? left - right : right - left) || a.universeId - b.universeId;
  });
}

export function explorerChart(games: ExplorerGame[], metric: ExplorerMetric, kind: "bar" | "column" | "donut", days = 30, currency: "robux"|"usd" = "robux"): ChartSpec {
  const effectiveKind = kind === "donut" && (metric === "likeRatio" || metric === "estimatedRobux") ? "bar" : kind;
  const rows = games.slice(0, effectiveKind === "donut" ? 6 : 12);
  if (metric === "estimatedRobux") {
    const estimates = rows.map((game) => currentEarnings(game, days)?.[currency]);
    return { kind: effectiveKind, title: `Estimated earnings · ${days} ${days === 1 ? "day" : "days"}`, source: "Current CCU + genre model",
      categories: rows.map((game) => ({ key:String(game.universeId),label:game.name,iconUrl:game.iconUrl,rootPlaceId:game.rootPlaceId })),
      series: ["low", "high"].map((bound) => ({ key:bound,label:bound === "low" ? "Low estimate" : "High estimate",format:currency,values:estimates.map((range) => range?.[bound as "low"|"high"] ?? null) })),
      colors: { low:colorHex("blue"),high:colorHex("orange") }, colorBy:"series", showValues:true };
  }
  return {
    kind: effectiveKind,
    title: EXPLORER_METRICS[metric], source: "Roblox public data · selected games",
    categories: rows.map((game) => ({ key: String(game.universeId), label: game.name, iconUrl: game.iconUrl, rootPlaceId: game.rootPlaceId })),
    series: [{ key: metric, label: EXPLORER_METRICS[metric], format: metric === "likeRatio" ? "percent" : "compact", values: rows.map((game) => game[metric]) }],
    colors: effectiveKind === "donut" ? Object.fromEntries(rows.map((game, index) => [String(game.universeId), colorHex(PALETTE_ORDER[index])])) : { [metric]: colorHex("blue") },
    colorBy: effectiveKind === "donut" ? "category" : "series", showValues: true,
  };
}

export function chartPrompt(games: ExplorerGame[], metric: ExplorerMetric, days = 30) {
  const ids = games.slice(0, 12).map((game) => game.universeId);
  return `Create a chart comparing ${metric === "estimatedRobux" ? `estimated ${days}-day Robux earnings (both low and high bounds)` : EXPLORER_METRICS[metric].toLowerCase()} for these Roblox universe IDs: ${ids.join(", ")}. Fetch fresh data first.`;
}
