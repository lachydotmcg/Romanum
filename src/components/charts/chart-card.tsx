"use client";

import { useCallback, useState } from "react";
import { GameIcon } from "@/components/game-icon";
import { RankingChart } from "./ranking-chart";
import { type ChartSpec, formatValue } from "@/lib/charts/spec";
import { buildOption, chartHeight } from "@/lib/charts/options";
import { EChart } from "./echart";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

function StatTiles({ chart }: { chart: ChartSpec }) {
  return (
    <div className="space-y-4">
      {chart.categories.map((category, ci) => (
        <div key={category.key}>
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-fg">
            {category.iconUrl !== undefined && <GameIcon url={category.iconUrl} name={category.label} className="size-8" />}
            {category.label}
          </p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {chart.series.map((series) => (
              <div key={series.key} className="rounded-lg border border-line px-3 py-2.5">
                <dt className="text-xs text-fg-muted">{series.label}</dt>
                <dd className="mt-1 text-xl font-semibold text-fg">{formatValue(series.values[ci], series.format)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/** The table twin of a chart: every value, unrounded. */
function ChartTable({ chart }: { chart: ChartSpec }) {
  const share = chart.kind === "donut" || chart.kind === "treemap";
  const total = share ? chart.series[0].values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : 0;
  const exact = (value: number | null, format: ChartSpec["series"][number]["format"]) =>
    formatValue(value, format === "percent" ? "percent" : "full");

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-fg-muted">
            <th className="border-b border-line-strong py-1.5 pr-4 font-medium">Name</th>
            {chart.series.map((s) => (
              <th key={s.key} className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">
                {s.label}
              </th>
            ))}
            {share && <th className="border-b border-line-strong py-1.5 text-right font-medium">Share</th>}
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((category, i) => (
            <tr key={category.key}>
              <td className="border-b border-line py-2 pr-4 text-fg">
                <span className="flex items-center gap-2">
                  {category.iconUrl !== undefined && <GameIcon url={category.iconUrl} name={category.label} className="size-7" />}
                  {category.label}
                </span>
              </td>
              {chart.series.map((s) => (
                <td key={s.key} className="border-b border-line py-1.5 pr-4 text-right text-fg">
                  {exact(s.values[i], s.format)}
                </td>
              ))}
              {share && (
                <td className="border-b border-line py-1.5 text-right text-fg">
                  {total > 0 ? `${(((chart.series[0].values[i] ?? 0) / total) * 100).toFixed(1)}%` : "–"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartCard({ chart, className = "", showSource = true }: { chart: ChartSpec; className?: string; showSource?: boolean }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const build = useCallback((width: number) => buildOption(chart, width), [chart]);
  const tiles = chart.kind === "stat_tiles";

  return (
    <figure className={`min-w-0 rounded-xl border border-line bg-surface p-5 ${className}`}>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{chart.title}</p>
          {chart.subtitle && <p className="mt-0.5 text-xs text-fg-muted">{chart.subtitle}</p>}
        </div>
        {!tiles && (
          <button
            type="button"
            onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
            aria-pressed={view === "table"}
            className={`shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg ${FOCUS}`}
          >
            {view === "chart" ? "Table" : "Chart"}
          </button>
        )}
      </figcaption>

      <div className="mt-3">
        {tiles ? (
          <StatTiles chart={chart} />
        ) : view === "chart" ? (
          chart.kind === "bar" && chart.series.length === 1 && !chart.logScale && chart.series[0].values.every((value) => value === null || value >= 0)
            ? <RankingChart chart={chart} />
            : <EChart build={build} height={chartHeight(chart)} label={chart.title} />
        ) : (
          <ChartTable chart={chart} />
        )}
      </div>

      {/* Chart normalization and source caveats live in docs/data-notes.md. */}
      {showSource && <p className="mt-3 text-xs text-fg-muted">{chart.source}</p>}
    </figure>
  );
}
