import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { DailyMetricChange } from "@/lib/linked-games/changes";

export function MetricChange({ change }: { change: DailyMetricChange | null }) {
  if (!change) return <p className="mt-1 text-[11px] text-fg-subtle">Change unavailable</p>;
  const Icon = change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;
  return <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[11px] text-fg-muted" title={`${change.latestDay} compared with ${change.previousDay}; completed daily observations`}>
    <Icon className="size-3 shrink-0" aria-hidden="true" /><span className="tabular-nums">{change.label}</span><span className="text-fg-subtle">vs {change.previousDay}</span>
  </p>;
}
