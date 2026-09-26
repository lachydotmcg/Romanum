import type { ChartGame } from "@/lib/roblox";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function RankedList({
  title,
  note,
  games,
  limit = 8,
}: {
  title: string;
  note?: string;
  /** null when Roblox couldn't be reached. */
  games: ChartGame[] | null;
  limit?: number;
}) {
  return (
    <section aria-label={title} className="min-w-0 rounded-xl border border-line p-4">
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-fg-muted">{note}</p>}
      {games === null ? (
        <p className="mt-3 text-sm text-fg-muted">Couldn&apos;t load this chart from Roblox right now.</p>
      ) : (
        <ol className="mt-3 space-y-1">
          {games.slice(0, limit).map((game) => (
            <li key={game.universeId} className="flex items-center gap-3 py-1 text-sm">
              <span className="w-5 shrink-0 text-right text-xs text-fg-muted tabular-nums">{game.rank}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{game.name}</span>
                {game.genre && <span className="block truncate text-xs text-fg-muted">{game.genre}</span>}
              </span>
              <span className="shrink-0 text-xs text-fg-muted tabular-nums">{compact.format(game.playing)} playing</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
