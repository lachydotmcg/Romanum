import { GameIcon } from "@/components/game-icon";
import Link from "next/link";
import { type ChartSpec, formatValue } from "@/lib/charts/spec";

/** A linear comparison with game identity attached to each mark. */
export function RankingChart({ chart }: { chart: ChartSpec }) {
  const series = chart.series[0];
  const max = Math.max(0, ...series.values.map((value) => value ?? 0));
  return (
    <ol className="divide-y divide-line/70" aria-label={chart.title}>
      {chart.categories.map((category, i) => {
        const value = series.values[i];
        const content = (
          <>
            <span className="w-4 shrink-0 text-right text-[11px] text-fg-subtle tabular-nums">{i + 1}</span>
            {category.iconUrl !== undefined && <GameIcon url={category.iconUrl} name={category.label} />}
            <span className="min-w-0 flex-1">
              <span className="mb-2 flex items-baseline justify-between gap-4">
                <span className="truncate text-[13px] font-medium text-fg" title={category.label}>{category.label}</span>
                <span className="shrink-0 text-sm font-medium text-fg tabular-nums" title={formatValue(value, "full")}>{formatValue(value, series.format)}</span>
              </span>
              <span className="block h-1 overflow-hidden rounded-full bg-white/5" aria-hidden="true">
                <span className="block h-full rounded-full" style={{ width: `${max && value !== null ? Math.max(0, value / max * 100) : 0}%`, backgroundColor: chart.colors[chart.colorBy === "category" ? category.key : series.key] }} />
              </span>
            </span>
          </>
        );
        return (
          <li key={category.key}>
            {category.rootPlaceId ? (
              <Link href={`/analytics/games/${category.key}`} prefetch={false} className="flex items-center gap-3 rounded-lg px-1 py-2.5 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">{content}</Link>
            ) : <div className="flex items-center gap-3 px-1 py-2.5">{content}</div>}
          </li>
        );
      })}
    </ol>
  );
}
