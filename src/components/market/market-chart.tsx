"use client";

import { ChartCard } from "@/components/charts/chart-card";
import { useRevenue } from "@/components/analytics/revenue";
import { explorerChart, mergeGameDetails } from "@/lib/analytics/explorer";
import type { ChartSpec } from "@/lib/charts/spec";
import type { ChartGame } from "@/lib/roblox";

export function MarketChart({ chart, games, className }: { chart: ChartSpec; games: ChartGame[]; className: string }) {
  const { revenue, days, currency } = useRevenue();
  const rows = games.filter((game) => !game.sponsored).slice(0, 8).map((game) => ({ ...game, charts: ["top-playing-now" as const] }));
  const display = revenue ? explorerChart(mergeGameDetails(rows, []), "estimatedRobux", "bar", days, currency) : chart;
  return <ChartCard className={className} chart={display} showSource={revenue} />;
}
