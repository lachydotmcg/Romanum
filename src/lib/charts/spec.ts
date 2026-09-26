// Chart specs shared by the dashboard, the assistant's create_chart tool and the renderer.

/**
 * Categorical palette in its fixed order (dataviz reference palette, dark steps).
 * Validated on Romanum's surfaces (#050505, #111111): all adjacent checks pass,
 * and the first three also pass all-pairs, which is why scatter and radar cap at three colours.
 */
export const CHART_COLORS = {
  blue: "#3987e5",
  orange: "#d95926",
  aqua: "#199e70",
  yellow: "#c98500",
  magenta: "#d55181",
  green: "#008300",
  violet: "#9085e9",
  red: "#e66767",
} as const;

export type PaletteColor = keyof typeof CHART_COLORS;
export type ChartColor = PaletteColor | "gray";

export const PALETTE_ORDER = Object.keys(CHART_COLORS) as PaletteColor[];

/** De-emphasis for "highlight one, gray the rest". */
export const MUTED_MARK = "#4d4d4d";

export function colorHex(color: ChartColor): string {
  return color === "gray" ? MUTED_MARK : CHART_COLORS[color];
}

export const CHART_KINDS = ["bar", "column", "stacked_bar", "line", "donut", "scatter", "radar", "treemap", "stat_tiles"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type ValueFormat = "compact" | "full" | "percent";

export const METRICS = {
  playing: { label: "Players now", format: "compact" },
  visits: { label: "Total visits", format: "compact" },
  favorites: { label: "Favourites", format: "compact" },
  likes: { label: "Likes", format: "compact" },
  dislikes: { label: "Dislikes", format: "compact" },
  likeRatio: { label: "Like ratio", format: "percent" },
  maxPlayersPerServer: { label: "Max players per server", format: "compact" },
} as const satisfies Record<string, { label: string; format: ValueFormat }>;

export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

/** A chart ready to render. Every value comes from fetched data; none are typed in by a model. */
export type ChartSpec = {
  kind: ChartKind;
  title: string;
  subtitle?: string;
  /** Where the numbers came from, shown under the chart. */
  source: string;
  /** The things being compared: games, or groups such as genres. For line charts, timestamps (epoch ms as keys). */
  categories: { key: string; label: string; iconUrl?: string | null; rootPlaceId?: number }[];
  /** One value per category. Scatter uses series 0/1/2 as x/y/size. */
  series: { key: string; label: string; format: ValueFormat; values: (number | null)[] }[];
  /** Hex colour per category key or series key, depending on what carries identity. */
  colors: Record<string, string>;
  colorBy: "category" | "series";
  logScale?: boolean;
  showValues?: boolean;
  size?: "small" | "medium" | "large";
};

const compactFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat("en");

export function formatValue(value: number | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  return format === "full" ? fullFormat.format(value) : compactFormat.format(value);
}
