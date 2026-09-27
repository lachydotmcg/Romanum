import { cache } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { PrivateAnalytics } from "@/components/account/private-analytics";
import { GameIcon } from "@/components/game-icon";
import { PlayerHistory } from "@/components/history/player-history";
import { loadPublicGame, parseUniverseId } from "@/lib/game-discovery";
import { formatValue } from "@/lib/charts/spec";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { linkedGameForUniverse, readGameMetrics } from "@/lib/linked-games/store";
import { GameEarningsPanel } from "@/components/analytics/revenue";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ universeId: string }> };
const getGame = cache(loadPublicGame);

function validId(id: string) {
  try { parseUniverseId(id); } catch { notFound(); }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { universeId } = await params;
  validId(universeId);
  // Request memoisation shares this observation with the page body.
  const result = await getGame(universeId);
  return { title: result.game?.name ?? "Game not found" };
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "–" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The signed-in account's private analytics for this game, when it has linked it. */
async function ownAnalytics(universeId: number) {
  const account = await readAccount();
  if (!account) return null;
  const database = await historyDatabase().catch(() => null);
  const linked = database && (await linkedGameForUniverse(database, account.id, universeId));
  return database && linked ? { game: linked, metrics: await readGameMetrics(database, account.id, linked.id) } : null;
}

export default async function GamePage({ params }: Props) {
  const { universeId } = await params;
  validId(universeId);
  const [{ game, fetchedAt }, own] = await Promise.all([getGame(universeId), ownAnalytics(Number(universeId))]);
  if (!game) notFound();
  const stats = [
    { label: "Players now", value: game.playing, format: "compact" },
    { label: "Visits", value: game.visits, format: "compact" },
    { label: "Favourites", value: game.favorites, format: "compact" },
    { label: "Like ratio", value: game.likeRatio, format: "percent" },
  ] as const;
  return (
    <>
      <Link href="/analytics" className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">
        <ArrowLeft className="size-4 text-white" aria-hidden="true" /> Analytics
      </Link>
      <header className="mt-5 flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-4 sm:basis-auto">
          <GameIcon url={game.iconUrl} name={game.name} className="size-16 sm:size-20" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{game.name}</h1>
            <p className="mt-1 text-sm text-fg-muted break-words">{game.creator.name}</p>
          </div>
        </div>
        <a href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">
          Roblox <ArrowUpRight className="size-4 text-white" aria-hidden="true" />
        </a>
      </header>

      <section aria-label="Current statistics" className="mt-8">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0 rounded-xl border border-line bg-surface px-4 py-5">
              <dt className="text-xs text-fg-muted">{stat.label}</dt>
              <dd className="mt-2 text-2xl font-semibold tabular-nums" title={formatValue(stat.value, stat.format === "percent" ? "percent" : "full")}>{formatValue(stat.value, stat.format)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-fg-subtle">As of <time dateTime={fetchedAt}>{new Date(fetchedAt).toISOString().slice(11, 16)} UTC</time></p>
      </section>

      <GameEarningsPanel game={game} />
      {own && <PrivateAnalytics game={own.game} metrics={own.metrics} />}

      <PlayerHistory key={game.universeId} game={{ universeId: game.universeId, rootPlaceId: game.rootPlaceId, name: game.name, iconUrl: game.iconUrl ?? null }} />

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-fg-muted">Genre</dt><dd className="mt-1 break-words">{game.genre ?? "–"}</dd></div>
        <div><dt className="text-xs text-fg-muted">Created</dt><dd className="mt-1">{dateLabel(game.created)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Game updated</dt><dd className="mt-1">{dateLabel(game.updated)}</dd></div>
      </dl>
    </>
  );
}
