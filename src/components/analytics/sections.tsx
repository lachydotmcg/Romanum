import Link from "next/link";
import { getGameDirectory } from "@/lib/analytics/directory";
import { getMarketData } from "@/lib/market-data";
import { formatValue } from "@/lib/charts/spec";
import { GameExplorer } from "./game-explorer";
import { PatternExplorer } from "@/components/market/pattern-explorer";
import { RankedList } from "@/components/market/ranked-list";
import { RetryMarket } from "@/components/market/retry";
import { GameEarnings } from "./revenue";

function Unavailable() {
  return <div className="mt-7 rounded-xl border border-line p-5 text-sm text-fg-muted"><p role="status">Couldn&apos;t load games.</p><RetryMarket /></div>;
}

export async function GamesSection({ connected, chartMode, genre }: { connected: boolean; chartMode?: boolean; genre?: string }) {
  const data = await getGameDirectory();
  if (!data.analysis.availableCharts.length) return <Unavailable />;
  return <GameExplorer games={data.games} connected={connected} chartMode={chartMode} initialGenre={genre} />;
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
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-96 text-left text-sm tabular-nums">
        <thead className="border-b border-line text-xs text-fg-muted"><tr>
          <th className="px-5 py-3 font-medium">Genre</th><th className="px-5 py-3 text-right font-medium">Games</th>
          <th className="px-5 py-3 text-right font-medium">Players now</th><th className="px-5 py-3 text-right font-medium">Share</th>
          <th className="px-5 py-3 text-right font-medium">Est. earnings</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{analysis.genres.map((genre) => <tr key={genre.name} className="hover:bg-surface-hover">
          <td className="px-5 py-4"><Link prefetch={false} scroll={false} href={`/analytics?view=games&genre=${encodeURIComponent(genre.name)}`} className="hover:underline">{genre.name}</Link></td>
          <td className="px-5 py-4 text-right text-fg-muted">{genre.gameCount}</td><td className="px-5 py-4 text-right">{formatValue(genre.players, "compact")}</td>
          <td className="px-5 py-4 text-right text-fg-muted">{formatValue(genre.share, "percent")}</td>
          <td className="px-5 py-4 text-right"><GameEarnings game={{ playing: genre.players, genre: genre.name }} /></td>
        </tr>)}</tbody>
      </table>
      {!analysis.genres.length && <p role="status" className="p-5 text-sm text-fg-muted">No genres found.</p>}
    </div>
  </section>;
}
