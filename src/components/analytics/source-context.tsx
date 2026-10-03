import Link from "next/link";
import type { MarketAnalysis } from "@/lib/market-analysis";
import type { RobloxChartId } from "@/lib/roblox";
import { utcObservationTime } from "@/lib/public-discovery";

const CHART_LABELS: Record<RobloxChartId, string> = {
  "top-playing-now": "Top Playing Now", "top-trending": "Trending",
  "up-and-coming": "Up-and-Coming", "top-earning": "Top Earning",
  "top-rated": "Top Rated", "top-revisited": "Top Revisited", "most-popular": "Most Popular",
  "fun-with-friends": "Fun with Friends", "top-paid-access": "Top Paid Access",
};
type Observation = { chart: RobloxChartId; fetchedAt: string };

export function SourceContext({ analysis, observations }: {
  analysis: Pick<MarketAnalysis, "sampleSize" | "unavailableCharts">; observations: Observation[];
}) {
  return <details aria-label="Public chart sources and coverage" className="mt-6 text-xs text-fg-muted">
    <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">Sources and freshness</summary>
    <div className="mt-2 rounded-xl border border-line px-4 py-3 leading-5">
    <p><a href="https://www.roblox.com/charts" className="text-fg hover:underline">Roblox Charts</a> · Market sample: {analysis.sampleSize} distinct non-sponsored games across loaded charts.</p>
    <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
      {observations.map(observation => <li key={observation.chart}>{CHART_LABELS[observation.chart]}: <time dateTime={observation.fetchedAt}>{utcObservationTime(observation.fetchedAt) ?? "Retrieval time unavailable"}</time></li>)}
    </ul>
    {analysis.unavailableCharts.length > 0 && <p className="mt-2">Unavailable charts: {analysis.unavailableCharts.map(chart => CHART_LABELS[chart]).join(", ")}. They are excluded from this sample.</p>}
    <p className="mt-2">Times show Romanum retrievals, not Roblox measurements. Title patterns are hypotheses; chart membership alone doesn&apos;t show growth. <Link href="/analytics/data" className="text-fg underline underline-offset-2">Sources and metric definitions</Link></p>
    </div>
  </details>;
}
