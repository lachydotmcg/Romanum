"use client";

import type { ChartGame } from "@/lib/roblox";
import { GameEarnings, useRevenue } from "@/components/analytics/revenue";
import { Robux } from "@/components/robux";
import Link from "next/link";
import { GameIcon } from "@/components/game-icon";
import { RetryMarket } from "./retry";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function RankedList({
  title,
  games,
  limit = 5,
  earnings = false,
}: {
  title: string;
  /** null when Roblox couldn't be reached. */
  games: ChartGame[] | null;
  limit?: number;
  earnings?: boolean;
}) {
  const { revenue, days } = useRevenue();
  const showEarnings = earnings || revenue;
  return (
    <section aria-label={title} className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg">{earnings && <Robux className="size-4 text-white" />}{title}</h3>
      {showEarnings && <p className="mt-1 text-[10px] text-fg-muted">Est. {days}-day earnings · current CCU</p>}
      {!games?.length ? (
        <div className="mt-3">
          <p role="status" className="text-sm text-fg-muted">{games === null ? "Couldn't load chart." : "No games found."}</p>
          {games === null && <RetryMarket />}
        </div>
      ) : (
        <ol className="mt-3 divide-y divide-line/70">
          {games.slice(0, limit).map((game) => (
            <li key={game.universeId}>
              <Link href={`/analytics/games/${game.universeId}`} prefetch={false} className="flex items-center gap-2.5 rounded-lg py-3 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">
              <span className="w-3 shrink-0 text-right text-[10px] text-fg-subtle tabular-nums">{game.rank}</span>
              <GameIcon url={game.iconUrl} name={game.name} className="size-9" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-fg" title={game.name}>{game.name}</span>
                {game.genre && <span className="mt-1 block truncate text-[10px] text-fg-muted">{game.genre}</span>}
              </span>
              <span className="shrink-0 text-right text-xs font-medium tabular-nums">{showEarnings ? <GameEarnings game={game} /> : <>{compact.format(game.playing)}<span className="mt-1 block text-[10px] font-normal text-fg-subtle">playing</span></>}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
