import {
  CHART_KINDS,
  type ChartColor,
  type ChartKind,
  type ChartSpec,
  colorHex,
  METRIC_KEYS,
  METRICS,
  type MetricKey,
  PALETTE_ORDER,
  type PaletteColor,
  type ValueFormat,
} from "../charts/spec.ts";
import type { FetchedData, GameRecord } from "./fetched-data";
import { HISTORY_METRICS, type HistoryMetric } from "./fetched-data.ts";

export type ChartBuild =
  | { ok: true; chart: ChartSpec; chartColors: Record<string, ChartColor>; summary: string }
  | { ok: false; error: string };

const COLOR_NAMES: ChartColor[] = [...PALETTE_ORDER, "gray"];
/** Scatter and radar put every colour next to every other; only the first three slots pass that check. */
const ALL_PAIRS_SAFE: PaletteColor[] = PALETTE_ORDER.slice(0, 3);

// [min, max] games and metrics per chart type.
const LIMITS: Record<ChartKind, { games: [number, number]; metrics: [number, number] }> = {
  bar: { games: [1, 20], metrics: [1, 4] },
  column: { games: [1, 12], metrics: [1, 4] },
  stacked_bar: { games: [1, 20], metrics: [2, 4] },
  line: { games: [1, 1], metrics: [1, 1] },
  donut: { games: [2, 20], metrics: [1, 1] },
  treemap: { games: [2, 30], metrics: [1, 1] },
  scatter: { games: [2, 30], metrics: [2, 3] },
  radar: { games: [1, 3], metrics: [3, 6] },
  stat_tiles: { games: [1, 3], metrics: [1, 6] },
};

const DONUT_SLICES = 6;

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : ` · fetched ${date.toISOString().slice(11, 16)} UTC`;
}

/** Validates create_chart arguments and resolves every value from data the tools fetched. */
export function buildChart(args: Record<string, unknown>, data: FetchedData): ChartBuild {
  const fail = (error: string): ChartBuild => ({ ok: false, error });

  const kind = args.type as ChartKind;
  if (!CHART_KINDS.includes(kind)) return fail(`"type" must be one of: ${CHART_KINDS.join(", ")}.`);

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > 80) return fail(`"title" is required, up to 80 characters.`);
  const subtitle = typeof args.subtitle === "string" && args.subtitle.trim() ? args.subtitle.trim().slice(0, 140) : undefined;

  const ids = Array.isArray(args.universeIds) ? [...new Set(args.universeIds.map(Number))] : [];
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) return fail(`"universeIds" must be positive integers.`);
  const metrics = Array.isArray(args.metrics) ? [...new Set(args.metrics)] : [];
  if (!metrics.every((m): m is MetricKey => METRIC_KEYS.includes(m as MetricKey))) {
    return fail(`"metrics" must be from: ${METRIC_KEYS.join(", ")}.`);
  }

  const limit = LIMITS[kind];
  if (ids.length < limit.games[0] || ids.length > limit.games[1]) {
    return fail(`A ${kind} chart takes ${limit.games[0]} to ${limit.games[1]} games.`);
  }
  if (metrics.length < limit.metrics[0] || metrics.length > limit.metrics[1]) {
    return fail(`A ${kind} chart takes ${limit.metrics[0]} to ${limit.metrics[1]} metrics.`);
  }
  if (kind === "line") {
    const metric = metrics[0] as HistoryMetric;
    if (!(HISTORY_METRICS as readonly string[]).includes(metric)) return fail("This metric has no recorded history. Use players, visits, favourites or votes.");
    const history = data.getHistory(ids[0]);
    if (!history) return fail("Fetch get_game_history for this universe first. Current counts cannot form a time series.");
    if (history.points.filter((point) => point[metric] !== null).length < 2) return fail("Not enough recorded observations for a line chart. Offer current statistics instead.");
    const key = String(ids[0]);
    const chart: ChartSpec = {
      kind: "line", title, subtitle, source: "Romanum recorded history · UTC",
      categories: history.points.map((point) => ({ key: String(point.time), label: new Date(point.time).toISOString().replace("T", " ").replace(".000Z", " UTC") })),
      series: [{ key, label: `${history.name} · ${METRICS[metric].label}`, format: metric === "likeRatio" ? "percent" : "compact", values: history.points.map((point) => point[metric]) }],
      colors: { [key]: colorHex("blue") }, colorBy: "series", size: "large",
    };
    return { ok: true, chart, chartColors: { [key]: "blue" }, summary: `Recorded ${METRICS[metric].label.toLowerCase()} · ${history.name}` };
  }
  const hasRatio = metrics.includes("likeRatio");
  const hasEstimate = metrics.some((metric) => metric === "estimatedRobuxLow" || metric === "estimatedRobuxHigh");
  if (hasEstimate && (!["bar", "column", "stat_tiles"].includes(kind) || metrics.length !== 2 || !metrics.includes("estimatedRobuxLow") || !metrics.includes("estimatedRobuxHigh"))) {
    return fail("Show both estimatedRobuxLow and estimatedRobuxHigh together in a bar, column or stat_tiles chart, without other metrics. These bounds cannot be stacked or used as shares.");
  }
  if (["bar", "column"].includes(kind) && hasRatio && metrics.length > 1) {
    return fail("Don't mix likeRatio (a percentage) with counts in one chart. Make a separate chart for it.");
  }
  if (["stacked_bar", "donut", "treemap"].includes(kind) && hasRatio) {
    return fail(`likeRatio is a percentage, so it can't be stacked or shown as a share. Use a bar chart.`);
  }

  // Resolve values; refuse anything that wasn't fetched.
  const records: GameRecord[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const record = data.get(id);
    if (!record) {
      missing.push(`universe ${id}`);
      continue;
    }
    for (const metric of metrics) if (record[metric] === undefined) missing.push(`${metric} for ${record.name}`);
    records.push(record);
  }
  if (missing.length) {
    return fail(`No fetched data for ${missing.join(", ")}. Fetch it first with ${hasEstimate ? "estimate_game_earnings" : "get_game_stats"}.`);
  }
  if (hasEstimate && (records.some((record) => !record.estimateDays) || new Set(records.map((record) => record.estimateDays)).size !== 1)) return fail("Fetch earnings estimates for every game over the same period first.");

  // Colours: validate names, then work out what carries identity.
  const requested = new Map<string, ChartColor>();
  if (args.colors && typeof args.colors === "object" && !Array.isArray(args.colors)) {
    for (const [key, color] of Object.entries(args.colors as Record<string, unknown>)) {
      if (!COLOR_NAMES.includes(color as ChartColor)) return fail(`Unknown colour "${String(color)}". Use: ${COLOR_NAMES.join(", ")}.`);
      requested.set(key, color as ChartColor);
    }
  }
  const allPairs = kind === "scatter" || kind === "radar";
  if (allPairs && [...requested.values()].some((c) => c !== "gray" && !ALL_PAIRS_SAFE.includes(c as PaletteColor))) {
    return fail(`${kind} charts can only use ${ALL_PAIRS_SAFE.join(", ")} and gray, so every pair of colours stays distinguishable.`);
  }
  const highlight = args.highlight === undefined ? undefined : Number(args.highlight);
  if (highlight !== undefined && !ids.includes(highlight)) return fail(`"highlight" must be one of the chart's universeIds.`);

  const format = args.format as ValueFormat | undefined;
  if (format !== undefined && !["compact", "full", "percent"].includes(format)) return fail(`"format" must be compact, full or percent.`);
  if (format === "percent" && !hasRatio) return fail(`"percent" only applies to likeRatio.`);

  // Sort categories (default: largest first for ranked forms).
  const sort = (args.sort as string | undefined) ?? (["bar", "column", "stacked_bar", "donut", "treemap"].includes(kind) ? "desc" : "none");
  if (!["desc", "asc", "none"].includes(sort)) return fail(`"sort" must be desc, asc or none.`);
  const sortMetric = metrics[0];
  const total = (r: GameRecord) => (kind === "stacked_bar" ? metrics.reduce((sum, m) => sum + (r[m] ?? 0), 0) : (r[sortMetric] ?? 0));
  if (sort !== "none") records.sort((a, b) => (sort === "desc" ? total(b) - total(a) : total(a) - total(b)));

  let categories: ChartSpec["categories"] = records.map((r) => ({ key: String(r.universeId), label: r.name, iconUrl: r.iconUrl ?? null, rootPlaceId: r.rootPlaceId }));
  let series = metrics.map((metric) => ({
    key: metric,
    label: METRICS[metric].label,
    format: (hasEstimate ? "robux" : metric === "likeRatio" ? "percent" : format === "full" ? "full" : "compact") as ValueFormat,
    values: records.map((r) => r[metric] ?? null) as (number | null)[],
  }));

  // A donut past six slices stops being readable: keep the five largest and fold the rest into "Other".
  if (kind === "donut" && categories.length > DONUT_SLICES) {
    const rest = series[0].values.slice(DONUT_SLICES - 1).reduce<number>((sum, v) => sum + (v ?? 0), 0);
    categories = [...categories.slice(0, DONUT_SLICES - 1), { key: "other", label: "Other" }];
    series = [{ ...series[0], values: [...series[0].values.slice(0, DONUT_SLICES - 1), rest] }];
  }

  const colors: Record<string, string> = {};
  const chartColors: Record<string, ChartColor> = {};
  let colorBy: ChartSpec["colorBy"] = "category";

  if (kind === "stat_tiles") {
    colorBy = "series";
  } else if (metrics.length > 1 && kind !== "scatter" && kind !== "radar") {
    // Several metrics per game: the metrics carry identity.
    colorBy = "series";
    const used = new Set<ChartColor>();
    for (const s of series) {
      const color = requested.get(s.key) ?? PALETTE_ORDER.find((c) => !used.has(c)) ?? "gray";
      used.add(color);
      colors[s.key] = colorHex(color);
    }
  } else {
    // Games carry identity. One colour for all unless the chart is about telling games apart.
    const categorical =
      kind === "donut" ||
      kind === "radar" ||
      ((kind === "bar" || kind === "column") && highlight === undefined && categories.length <= 8 &&
        categories.some((c) => requested.has(c.key)));
    const pool = allPairs ? ALL_PAIRS_SAFE : PALETTE_ORDER;
    const used = new Set<ChartColor>([...requested.values()]);
    const single = requested.get(metrics[0]) ?? "blue";

    for (const category of categories) {
      let color: ChartColor;
      if (category.key === "other") color = "gray";
      else if (highlight !== undefined) color = category.key === String(highlight) ? (requested.get(category.key) ?? single) : "gray";
      else if (!categorical) color = requested.get(category.key) ?? single;
      else {
        const remembered = data.colors.get(category.key);
        color =
          requested.get(category.key) ??
          (remembered && !used.has(remembered) && (pool as ChartColor[]).includes(remembered) ? remembered : undefined) ??
          pool.find((c) => !used.has(c)) ??
          "gray";
        used.add(color);
        if (color !== "gray") chartColors[category.key] = color;
      }
      colors[category.key] = colorHex(color);
    }
  }

  const sizes = ["small", "medium", "large"] as const;
  const newest = records.map((r) => r.fetchedAt).filter(Boolean).sort().at(-1);
  const chart: ChartSpec = {
    kind,
    title: hasEstimate ? `Estimated earnings · ${records[0].estimateDays} ${records[0].estimateDays === 1 ? "day" : "days"}` : title,
    subtitle,
    source: `${hasEstimate ? "Current CCU + genre model" : "Roblox public data"}${formatTime(newest)}`,
    categories,
    series,
    colors,
    colorBy,
    logScale: args.logScale === true,
    showValues: args.showValues === true,
    size: sizes.includes(args.size as (typeof sizes)[number]) ? (args.size as ChartSpec["size"]) : "medium",
  };
  return { ok: true, chart, chartColors, summary: `${kind.replace("_", " ")} chart · ${categories.length} ${categories.length === 1 ? "game" : "games"}` };
}
