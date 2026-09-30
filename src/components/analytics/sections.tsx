import { getGameDirectory } from "@/lib/analytics/directory";
import { getMarketData } from "@/lib/market-data";
import { GameExplorer } from "./game-explorer";
import { PatternExplorer } from "@/components/market/pattern-explorer";
import { RankedList } from "@/components/market/ranked-list";
import { RetryMarket } from "@/components/market/retry";
import { GenresTable } from "./genres-table";

function Unavailable() {
  return <div className="mt-7 rounded-xl border border-line p-5 text-sm text-fg-muted"><p role="status">Couldn&apos;t load games.</p><RetryMarket /></div>;
}

export async function GamesSection({ chartMode, genre }: { chartMode?: boolean; genre?: string }) {
  const data = await getGameDirectory();
  if (!data.analysis.availableCharts.length) return <Unavailable />;
  return <GameExplorer games={data.games} chartMode={chartMode} initialGenre={genre} />;
}

export async function TrendsSection({ connected }: { connected: boolean }) {
  const { samples, analysis } = await getMarketData();
  if (!analysis.availableCharts.length) return <Unavailable />;
  return <>
    <section className="mt-7" aria-labelledby="trending-heading">
      <h2 id="trending-heading" className="mb-4 text-base font-semibold">Roblox discovery</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <RankedList title="Trending" games={samples.find((sample) => sample.chart === "top-trending")?.games ?? null} />
        <RankedList title="Up-and-Coming" games={samples.find((sample) => sample.chart === "up-and-coming")?.games ?? null} />
        <RankedList title="Top Earning" earnings games={samples.find((sample) => sample.chart === "top-earning")?.games ?? null} />
      </div>
    </section>
    <PatternExplorer analysis={analysis} connected={connected} />
  </>;
}

export async function GenresSection() {
  const { analysis } = await getMarketData();
  if (!analysis.availableCharts.length) return <Unavailable />;
  return <section className="mt-7" aria-labelledby="genres-heading">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="genres-heading" className="text-base font-semibold">Genres</h2>
      <span className="text-xs text-fg-muted">{analysis.sampleSize} games in Roblox charts</span>
    </div>
    <GenresTable genres={analysis.genres} />
  </section>;
}
