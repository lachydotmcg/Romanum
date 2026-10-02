import { MarketChart } from "./market-chart";
import { type ChartSpec, colorHex } from "@/lib/charts/spec";
import { getMarketData } from "@/lib/market-data";
import { analyzeMarket } from "@/lib/market-analysis";
import type { ChartGame } from "@/lib/roblox";
import { currentInsight } from "@/lib/insights/current";
import { RankedList } from "./ranked-list";
import { GenreBreakdown } from "./genre-breakdown";
import { PatternExplorer } from "./pattern-explorer";
import { RetryMarket } from "./retry";
import { RomanumInsight } from "./romanum-insight";
import { SourceContext } from "@/components/analytics/source-context";

function topPlayingChart(games: ChartGame[]): ChartSpec {
  const top = games.filter((game) => !game.sponsored).slice(0, 8);
  return {
    kind: "bar", title: "Top Playing Now", source: "Roblox Charts · current players",
    categories: top.map((game) => ({ key: String(game.universeId), label: game.name, iconUrl: game.iconUrl ?? null, rootPlaceId: game.rootPlaceId })),
    series: [{ key: "playing", label: "Players now", format: "compact", values: top.map((game) => game.playing) }],
    colors: { playing: colorHex("blue") }, colorBy: "series", showValues: true,
  };
}

export async function MarketOverview({ connected }: { connected: boolean }) {
  const [{ samples, analysis, observations }, insight] = await Promise.all([getMarketData(), currentInsight()]);
  const playing = samples.find((sample) => sample.chart === "top-playing-now")?.games ?? null;
  const genreSample = analyzeMarket([{ chart: "top-playing-now", games: playing }], analysis.assembledAt);
  return (
    <>
      <section aria-labelledby="market-heading" className="mt-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 id="market-heading" className="text-base font-semibold tracking-tight">Roblox right now</h2>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {playing?.length ? <MarketChart className={insight ? "lg:col-span-2" : "lg:col-span-3"} chart={topPlayingChart(playing)} games={playing} />
            : <div className={`rounded-xl border border-line p-5 text-sm text-fg-muted ${insight ? "lg:col-span-2" : "lg:col-span-3"}`}>
                <p role="status">{playing === null ? "Couldn't load games." : "No games found."}</p>
                {playing === null && <RetryMarket />}
              </div>}
          {insight && <RomanumInsight initial={insight.insight} today={insight.today} connected={connected} fitRow={Boolean(playing?.length)} />}
        </div>
        {playing?.length ? <div className="mt-4"><GenreBreakdown analysis={genreSample} wide /></div> : null}
      </section>
      {analysis.availableCharts.length > 0 && <PatternExplorer analysis={analysis} connected={connected} />}
      <section className="mt-9" aria-label="Roblox discovery charts">
        <div className="grid gap-4 md:grid-cols-3">
          <RankedList title="Top Trending" games={samples.find((sample) => sample.chart === "top-trending")?.games ?? null} />
          <RankedList title="Up-and-Coming" games={samples.find((sample) => sample.chart === "up-and-coming")?.games ?? null} />
          <RankedList title="Top Earning" earnings games={samples.find((sample) => sample.chart === "top-earning")?.games ?? null} />
        </div>
      </section>
      <SourceContext analysis={analysis} observations={observations} />
    </>
  );
}

export function MarketOverviewLoading() {
  return <section aria-label="Roblox right now" className="mt-9"><p className="text-base font-semibold">Roblox right now</p><p role="status" className="mt-4 rounded-xl border border-line p-5 text-sm text-fg-muted">Loading…</p></section>;
}
