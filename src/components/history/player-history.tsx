"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { EChart } from "@/components/charts/echart";
import { GameIcon } from "@/components/game-icon";
import { buildOption, chartHeight } from "@/lib/charts/options";
import { colorHex, formatValue, type ChartSpec } from "@/lib/charts/spec";

/** Shapes returned by /api/history/games and /api/history. Missing metrics are null, never zero. */
type HistoryGame = { universeId: number; name: string; rootPlaceId: number; iconUrl: string | null };
type GamesResponse = { available: boolean; games: HistoryGame[] };
type ObservationStatus = "observed" | "unavailable" | "not_sampled" | "missed";
type HistoryPoint = {
  observedAt: string;
  playing: number | null;
  visits: number | null;
  favorites: number | null;
  likes: number | null;
  dislikes: number | null;
  status: ObservationStatus;
};
type HistoryResponse = {
  available: boolean;
  universeId: number;
  game: HistoryGame | null;
  from: string;
  to: string;
  intervalSeconds: number;
  source: string;
  points: HistoryPoint[];
  sampleCount: number;
  gaps: number;
  truncated: boolean;
};

const PERIODS = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
] as const;

// 50 rows per page keeps a 30-day window out of the DOM; the API can return thousands of samples.
const PAGE_SIZE = 50;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-muted";
const CONTROL = `min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-fg hover:bg-surface-hover ${FOCUS}`;

// Stable identities while data is absent, so memoised work and effects don't rerun on every render.
const NO_GAMES: HistoryGame[] = [];
const NO_POINTS: HistoryPoint[] = [];

const STATUS_LABEL: Record<ObservationStatus, string> = {
  observed: "Observed",
  unavailable: "Unavailable",
  not_sampled: "Not sampled",
  missed: "Missed",
};

/** Observations are stored in UTC, so the table prints the timestamp exactly as recorded. */
function utcStamp(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "–";
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Shared fetch: 503 responses carry a short message; anything else falls back to plain wording. */
async function fetchJson<T>(url: string, signal: AbortSignal, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: "no-store" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(fallback);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" && body.error.trim() ? body.error : fallback);
  }
  return (await response.json()) as T;
}

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm text-fg hover:bg-surface-hover ${FOCUS}`}>
      <RotateCw className="size-3.5 text-white" aria-hidden="true" />
      Retry
    </button>
  );
}

function pagerClass(disabled: boolean) {
  return `min-h-9 rounded-md border border-line px-3 py-1.5 hover:bg-surface-hover ${FOCUS} ${disabled ? "cursor-not-allowed opacity-40" : ""}`;
}

export function PlayerHistory({ game: fixedGame }: { game?: HistoryGame }) {
  const [gamesAttempt, setGamesAttempt] = useState(0);
  const [games, setGames] = useState<{ attempt: number; data: GamesResponse | null; error: string | null } | null>(null);
  const [universeId, setUniverseId] = useState<number | null>(null);
  const [days, setDays] = useState<number>(1);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [history, setHistory] = useState<{ key: string; data: HistoryResponse | null; error: string | null } | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [page, setPage] = useState(1);
  // Aborting stops stale responses; this counter also drops a body that resolves after a newer request.
  const latestRequest = useRef(0);

  useEffect(() => {
    if (fixedGame) return;
    const controller = new AbortController();
    fetchJson<GamesResponse>("/api/history/games", controller.signal, "Couldn't load games.")
      .then((data) => {
        if (!controller.signal.aborted) setGames({ attempt: gamesAttempt, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setGames({ attempt: gamesAttempt, data: null, error: error instanceof Error ? error.message : "Couldn't load games." });
      });
    return () => controller.abort();
  }, [gamesAttempt, fixedGame]);

  // A response only answers the attempt that asked for it; anything else is still in flight.
  const gamesResult = games && games.attempt === gamesAttempt ? games : null;
  const availableGames = fixedGame ? [fixedGame] : gamesResult?.data?.games ?? NO_GAMES;
  const gamesLoading = !fixedGame && gamesResult === null;
  const gamesError = fixedGame ? null : gamesResult?.error ?? null;

  // A stored choice survives a refresh; it only falls back when that game is no longer listed.
  const selectedUniverseId =
    fixedGame ? fixedGame.universeId : universeId !== null && availableGames.some((game) => game.universeId === universeId)
      ? universeId
      : availableGames[0]?.universeId ?? null;

  // Changing the period or the game produces a new key, so stale points never render under it.
  const requestKey = selectedUniverseId === null ? null : `${selectedUniverseId}:${days}:${historyAttempt}`;

  useEffect(() => {
    if (selectedUniverseId === null) return;
    const key = `${selectedUniverseId}:${days}:${historyAttempt}`;
    const controller = new AbortController();
    const request = ++latestRequest.current;
    fetchJson<HistoryResponse>(`/api/history?universeId=${selectedUniverseId}&days=${days}`, controller.signal, "Couldn't load history.")
      .then((data) => {
        if (!controller.signal.aborted && request === latestRequest.current) setHistory({ key, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request !== latestRequest.current) return;
        setHistory({ key, data: null, error: error instanceof Error ? error.message : "Couldn't load history." });
      });
    return () => controller.abort();
  }, [selectedUniverseId, days, historyAttempt]);

  const historyResult = history && history.key === requestKey ? history : null;
  const historyLoading = requestKey !== null && historyResult === null;
  const historyError = historyResult?.error ?? null;
  const points = historyResult?.data?.points ?? NO_POINTS;

  // Only samples with a real player count are observations; everything else stays a gap.
  const observations = useMemo(
    () => points.filter((point) => point.status === "observed" && point.playing !== null),
    [points],
  );

  const spec = useMemo<ChartSpec>(
    () => ({
      kind: "line",
      title: "Players over time",
      source: historyResult?.data?.source ?? "",
      // Every sampled timestamp is a category; missing ones carry a null value so the line breaks.
      categories: points.map((point) => ({ key: String(Date.parse(point.observedAt)), label: utcStamp(point.observedAt) })),
      series: [{ key: "playing", label: "Players", format: "compact", values: points.map((point) => point.playing) }],
      colors: { playing: colorHex("blue") },
      colorBy: "series",
    }),
    [points, historyResult],
  );

  const build = useCallback((width: number) => buildOption(spec, width), [spec]);

  const selectedGame = fixedGame ?? historyResult?.data?.game ?? availableGames.find((game) => game.universeId === selectedUniverseId) ?? null;
  const latest = observations[observations.length - 1] ?? null;
  const totalPages = Math.max(1, Math.ceil(points.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const rows = points.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const busy = gamesLoading || historyLoading;

  let body: ReactNode;
  if (gamesLoading) {
    body = <p role="status" className="text-sm text-fg-muted">Loading…</p>;
  } else if (gamesError) {
    body = (
      <div>
        <p role="status" className="text-sm text-fg-muted">{gamesError}</p>
        <Retry onClick={() => setGamesAttempt((attempt) => attempt + 1)} />
      </div>
    );
  } else if (!availableGames.length) {
    body = <p role="status" className="text-sm text-fg-muted">No games yet</p>;
  } else if (historyLoading) {
    body = <p role="status" className="text-sm text-fg-muted">Loading…</p>;
  } else if (historyError) {
    body = (
      <div>
        <p role="status" className="text-sm text-fg-muted">{historyError}</p>
        <Retry
          onClick={() => {
            setPage(1);
            setHistoryAttempt((attempt) => attempt + 1);
          }}
        />
      </div>
    );
  } else if (observations.length < 2) {
    body = (
      <div className="rounded-lg border border-line px-4 py-6">
        <p role="status" className="text-sm text-fg-muted">{observations.length === 0 ? "No history yet" : "1 observation"}</p>
        {latest?.playing != null && <p className="mt-1 text-xs text-fg-subtle">Latest {formatValue(latest.playing, "compact")} players</p>}
      </div>
    );
  } else {
    body = (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {selectedGame && <GameIcon url={selectedGame.iconUrl} name={selectedGame.name} />}
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Players over time</p>
              {selectedGame && <p className="truncate text-xs text-fg-muted">{selectedGame.name}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setView((current) => (current === "chart" ? "table" : "chart"))}
            aria-pressed={view === "table"}
            className={`shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg ${FOCUS}`}
          >
            {view === "chart" ? "Table" : "Chart"}
          </button>
        </div>

        <div className="mt-3">
          {view === "chart" ? (
            <EChart build={build} height={chartHeight(spec)} label="Players over time" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm tabular-nums">
                  <caption className="sr-only">Observations for {selectedGame?.name ?? "the selected game"}</caption>
                  <thead>
                    <tr className="text-xs text-fg-muted">
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 font-medium">Time (UTC)</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">Players</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">Visits</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">Favourites</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">Likes</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 pr-4 text-right font-medium">Dislikes</th>
                      <th scope="col" className="border-b border-line-strong py-1.5 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((point, index) => (
                      <tr key={`${point.observedAt}-${index}`}>
                        <td className="border-b border-line py-2 pr-4 whitespace-nowrap text-fg-muted">{utcStamp(point.observedAt)}</td>
                        <td className="border-b border-line py-2 pr-4 text-right text-fg">{formatValue(point.playing, "full")}</td>
                        <td className="border-b border-line py-2 pr-4 text-right text-fg-muted">{formatValue(point.visits, "full")}</td>
                        <td className="border-b border-line py-2 pr-4 text-right text-fg-muted">{formatValue(point.favorites, "full")}</td>
                        <td className="border-b border-line py-2 pr-4 text-right text-fg-muted">{formatValue(point.likes, "full")}</td>
                        <td className="border-b border-line py-2 pr-4 text-right text-fg-muted">{formatValue(point.dislikes, "full")}</td>
                        <td className="border-b border-line py-2 text-right text-xs text-fg-subtle">{STATUS_LABEL[point.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <nav aria-label="Observation pages" className="mt-3 flex items-center justify-between gap-3 text-xs text-fg-muted">
                <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1} className={pagerClass(currentPage <= 1)}>
                  Previous
                </button>
                <p aria-live="polite" className="tabular-nums">
                  {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, points.length)} of {points.length}
                </p>
                <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages} className={pagerClass(currentPage >= totalPages)}>
                  Next
                </button>
              </nav>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="mt-10">
      <h2 id="history-heading" className="text-base font-semibold tracking-tight">Player history</h2>
      <div className="mt-4 rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-end gap-4">
          {!fixedGame && <div className="flex min-w-0 w-full flex-col gap-1.5 sm:w-80">
            <label htmlFor="history-game" className="text-xs text-fg-muted">Game</label>
            <select
              id="history-game"
              value={selectedUniverseId ?? ""}
              onChange={(event) => {
                setPage(1);
                setUniverseId(Number(event.target.value));
              }}
              disabled={!availableGames.length}
              className={`${CONTROL} w-full min-w-0 disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {!availableGames.length && <option value="">{gamesLoading ? "Loading…" : "None"}</option>}
              {availableGames.map((game) => (
                <option key={game.universeId} value={game.universeId}>{game.name}</option>
              ))}
            </select>
          </div>}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="history-period" className="text-xs text-fg-muted">Period</label>
            <select
              id="history-period"
              value={days}
              onChange={(event) => {
                setPage(1);
                setDays(Number(event.target.value));
              }}
              className={CONTROL}
            >
              {PERIODS.map((period) => (
                <option key={period.days} value={period.days}>{period.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-5" aria-busy={busy}>
          {body}
        </div>
      </div>
    </section>
  );
}
