// The private metrics Romanum syncs for a linked game, and how to show them. Safe to use in the browser.

/** Game-level daily metrics from Roblox's Analytics Query API: no breakdowns and no player identifiers. `short` labels
 * fit chart line ends and small tiles. */
export const SYNCED_METRICS = [
  { metric: "DailyActiveUsers", label: "Daily active users", short: "DAU", unit: "count" },
  { metric: "Visits", label: "Sessions", short: "Sessions", unit: "count" },
  { metric: "AveragePlayTimeMinutesPerDAU", label: "Playtime per user", short: "Playtime", unit: "minutes" },
  { metric: "AverageSessionLengthMinutes", label: "Session length", short: "Session", unit: "minutes" },
  { metric: "ForwardD1Retention", label: "Day 1 retention", short: "Day 1", unit: "rate" },
  { metric: "ForwardD7Retention", label: "Day 7 retention", short: "Day 7", unit: "rate" },
  { metric: "DailyRevenue", label: "Revenue", short: "Revenue", unit: "robux" },
  { metric: "PayingUsersCVR", label: "Payer conversion", short: "Payers", unit: "rate" },
] as const;

export type MetricUnit = (typeof SYNCED_METRICS)[number]["unit"];

/**
 * Rates as fractions of 1. Roblox's documentation doesn't give their scale; a series with any value above 1 must be
 * in percent, so it's scaled down.
 */
export function asFractions(values: (number | null)[]): (number | null)[] {
  return values.some((value) => value !== null && value > 1) ? values.map((value) => (value === null ? null : value / 100)) : values;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** A metric value for display. Rates are fractions of 1, as asFractions returns them. */
export function formatMetric(value: number | null | undefined, unit: MetricUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (unit === "rate") return `${(value * 100).toFixed(1)}%`;
  if (unit === "minutes") return `${value.toFixed(1)} min`;
  if (unit === "robux") return `R$${compact.format(value)}`;
  return compact.format(value);
}
