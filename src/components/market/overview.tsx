import { ChartCard } from "@/components/charts/chart-card";
import { type ChartSpec, colorHex, PALETTE_ORDER } from "@/lib/charts/spec";
import { type ChartGame, getRobloxChart, type RobloxChartId } from "@/lib/roblox";
import { RankedList } from "./ranked-list";

/** Roblox is asked for each chart at most this often; pages in between reuse the cached response. */
const REFRESH_SECONDS = 120;

async function load(chart: RobloxChartId): Promise<ChartGame[] | null> {
  try {
    return await getRobloxChart(chart, REFRESH_SECONDS);
  } catch {
    return null;
  }
}

function topPlayingChart(games: ChartGame[]): ChartSpec {
  const top = games.slice(0, 10);
  return {
    kind: "bar",
    title: "Top Playing Now",
    subtitle: "Players right now in the top 10 games",
    source: "Roblox Charts",
    categories: top.map((game) => ({ key: String(game.universeId), label: game.name })),
    series: [{ key: "playing", label: "Players now", format: "compact", values: top.map((game) => game.playing) }],
    colors: { playing: colorHex("blue") },
    colorBy: "series",
    showValues: true,
  };
}

/** Players summed by genre across the whole chart: the five largest genres, the rest folded into "Other". */
function genreChart(games: ChartGame[]): ChartSpec {
  const totals = new Map<string, number>();
  for (const game of games) {
    const genre = game.genre ?? "Unlisted";
    totals.set(genre, (totals.get(genre) ?? 0) + game.playing);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const rest = ranked.slice(5).reduce((sum, [, players]) => sum + players, 0);
  const rows = rest > 0 ? [...ranked.slice(0, 5), ["Other", rest] as const] : ranked;

  return {
    kind: "donut",
    title: "Players by genre",
    subtitle: `Across the ${games.length} games in Top Playing Now`,
    source: "Roblox Charts",
    categories: rows.map(([genre]) => ({ key: genre, label: genre })),
    series: [{ key: "playing", label: "Players now", format: "compact", values: rows.map(([, players]) => players) }],
    colors: Object.fromEntries(
      rows.map(([genre], i) => [genre, genre === "Other" ? colorHex("gray") : colorHex(PALETTE_ORDER[i])]),
    ),
    colorBy: "category",
  };
}

export async function MarketOverview() {
  const [playing, trending, rising, earning] = await Promise.all(
    (["top-playing-now", "top-trending", "up-and-coming", "top-earning"] as const).map(load),
  );

  return (
    <section aria-labelledby="market-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="market-heading" className="text-base font-semibold tracking-tight text-fg">
          Roblox right now
        </h2>
        <p className="text-xs text-fg-muted">Live from Roblox Charts · refreshes every 2 minutes</p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {playing ? (
          <>
            <ChartCard className="lg:col-span-2" chart={topPlayingChart(playing)} />
            <ChartCard chart={genreChart(playing)} />
          </>
        ) : (
          <p className="rounded-xl border border-line p-4 text-sm text-fg-muted lg:col-span-3">
            Couldn&apos;t load Top Playing Now from Roblox right now.
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <RankedList title="Top Trending" games={trending} />
        <RankedList title="Up-and-Coming" games={rising} />
        <RankedList title="Top Earning" note="Roblox's ranking. Revenue figures aren't public." games={earning} />
      </div>
    </section>
  );
}

export function MarketOverviewLoading() {
  return (
    <section aria-label="Roblox right now" className="mt-10">
      <p className="text-base font-semibold tracking-tight text-fg">Roblox right now</p>
      <p className="mt-4 rounded-xl border border-line p-4 text-sm text-fg-muted">Loading Roblox charts…</p>
    </section>
  );
}
