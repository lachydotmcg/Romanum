import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { DailyMetricChange } from "@/lib/linked-games/changes";

export function MetricChange({ change }: { change: DailyMetricChange | null }) {
  const available = !!change && change.percentage !== null && Number.isFinite(change.percentage);
  const percentage = available ? change.percentage! : null;
  const direction = percentage === null || percentage === 0 ? "flat" : percentage > 0 ? "up" : "down";
  const Icon = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : Minus;
  const colour = direction === "up" ? "bg-emerald-400" : direction === "down" ? "bg-rose-400" : "bg-fg-subtle";
  const label = percentage === null ? "—" : `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
  const detail = change
    ? `${percentage === null ? "Percentage change unavailable because the earlier value is zero or not comparable" : `${label} relative change, rounded to one decimal`}. ${change.latestDay} compared with ${change.previousDay}; completed daily observations. Absolute change ${change.label}.`
    : "Change unavailable. Two consecutive completed daily observations are required.";
  return <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-fg-muted" title={detail}>
    <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full text-canvas ${colour}`}><Icon className="size-2.5" /></span>
    <span aria-hidden="true" className="tabular-nums">{label}</span>
    <span className="sr-only">{detail}</span>
  </p>;
}
