import { asFractions, formatMetric, type MetricUnit } from "./metrics.ts";
import type { MetricPoint } from "./store";

export type DailyMetricChange = { label: string; direction: "up" | "down" | "flat"; previousDay: string; latestDay: string };

/** Compare consecutive completed days only. A missing day or provisional cohort is not a measured change. */
export function dailyMetricChange(series: MetricPoint[], unit: MetricUnit): DailyMetricChange | null {
  const latest = series.at(-1), previous = series.at(-2);
  if (!latest || !previous || latest.status || previous.status) return null;
  if (!Number.isFinite(latest.value) || !Number.isFinite(previous.value)) return null;
  if (Date.parse(`${latest.day}T00:00:00Z`) - Date.parse(`${previous.day}T00:00:00Z`) !== 86_400_000) return null;
  const values = unit === "rate" ? asFractions(series.map((point) => point.value)) : series.map((point) => point.value);
  const difference = (values.at(-1)! - values.at(-2)!) * (unit === "rate" ? 100 : 1);
  const rounded = Math.round(difference * 10) / 10;
  const direction = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const amount = unit === "rate" ? `${Math.abs(rounded).toFixed(1)} pp` : formatMetric(Math.abs(rounded), unit);
  return { label: `${direction === "up" ? "+" : direction === "down" ? "−" : ""}${amount}`, direction, previousDay: previous.day, latestDay: latest.day };
}
