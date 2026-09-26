"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { GameIcon } from "@/components/game-icon";

/** /api/games/search returns more fields than the list renders (rootPlaceId and fetchedAt included). */
type SearchGame = {
  universeId: number;
  name: string;
  playing: number;
  iconUrl?: string | null;
  sponsored: boolean;
};

/** Results carry the query that asked for them, so a replaced response can never render under it. */
type SearchState =
  | { query: string; status: "loading" }
  | { query: string; status: "ready"; games: SearchGame[] }
  | { query: string; status: "error"; message: string };

const MAX_QUERY = 300;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-muted";
/** Rows sit inside a rounded border, so their ring is drawn inwards. */
const ROW_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg-muted";
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** The API is trusted, but one malformed entry must not break the whole list. */
function toGames(value: unknown): SearchGame[] {
  if (!Array.isArray(value)) return [];
  const games: SearchGame[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<SearchGame>;
    if (typeof record.universeId !== "number" || !Number.isSafeInteger(record.universeId) || record.universeId <= 0) continue;
    if (typeof record.name !== "string" || !record.name) continue;
    if (typeof record.playing !== "number" || !Number.isSafeInteger(record.playing) || record.playing < 0) continue;
    if (games.some((game) => game.universeId === record.universeId)) continue;
    games.push({
      universeId: record.universeId,
      name: record.name,
      playing: record.playing,
      iconUrl: typeof record.iconUrl === "string" ? record.iconUrl : null,
      sponsored: record.sponsored === true,
    });
  }
  return games;
}

/** One short line serves as both the visible state and the aria-live announcement. */
function statusText(state: SearchState | null): string {
  if (!state) return "";
  if (state.status === "loading") return "Searching…";
  if (state.status === "error") return state.message;
  if (state.games.length === 0) return "No games found";
  return state.games.length === 1 ? "1 game" : `${state.games.length} games`;
}

export function GameSearch() {
  /** What the user has typed since the last submit; null means the box still shows the query. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The query the visible state belongs to; null until the first submit. */
  const [query, setQuery] = useState<string | null>(null);
  const [state, setState] = useState<SearchState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const input = draft ?? query ?? "";

  const search = useCallback((text: string) => {
    const q = text.trim();
    if (!q) return;

    // Only a submit starts a request. A new one aborts the last, so its response is dropped.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setQuery(q);
    setDraft(null);
    setState({ query: q, status: "loading" });

    // The query rides in the URL so Back returns to this search; nothing is kept in storage.
    const url = new URL(window.location.href);
    url.searchParams.set("q", q);
    window.history.replaceState(null, "", url);

    void (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/games/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        // Aborting is how a replaced request stops, so it is not a failure to report.
        if (controller.signal.aborted) return;
        setState({ query: q, status: "error", message: "Couldn't search games." });
        return;
      }

      const body = (await response.json().catch(() => null)) as { games?: unknown; error?: unknown } | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const message = typeof body?.error === "string" && body.error.trim() ? body.error : "Couldn't search games.";
        setState({ query: q, status: "error", message });
        return;
      }
      if (!Array.isArray(body?.games)) {
        setState({ query: q, status: "error", message: "Couldn't search games." });
        return;
      }
      setState({ query: q, status: "ready", games: toGames(body.games) });
    })();
  }, []);

  // Leaving the page stops anything still in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  // ?q= from a previous search re-runs after Back. It is read in an effect, not during render,
  // so the server and client markup still agree.
  useEffect(() => {
    const previous = new URLSearchParams(window.location.search).get("q") ?? "";
    // Deferred out of the effect body so the restore is one update instead of a render cascade.
    let active = true;
    if (previous.trim()) queueMicrotask(() => { if (active) search(previous); });
    return () => { active = false; };
  }, [search]);

  const active = state && state.query === query ? state : null;
  const loading = active?.status === "loading";
  const error = active?.status === "error" ? active.message : null;
  const games = active?.status === "ready" ? active.games : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    search(input);
  }

  function clear() {
    abortRef.current?.abort();
    setDraft("");
    setQuery(null);
    setState(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }

  return (
    <section aria-label="Game search" className="mt-10">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="game-search-query" className="sr-only">
          Search games
        </label>
        <input
          id="game-search-query"
          type="search"
          name="q"
          value={input}
          onChange={(event) => { if (!event.target.value) clear(); else setDraft(event.target.value); }}
          placeholder="Game name or Roblox link"
          maxLength={MAX_QUERY}
          autoComplete="off"
          enterKeyHint="search"
          className={`min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong ${FOCUS}`}
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className={`min-h-11 shrink-0 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-subtle ${FOCUS}`}
        >
          Search
        </button>
        {query && <button type="button" onClick={clear} className={`min-h-11 rounded-lg px-3 text-sm text-fg-muted hover:text-fg ${FOCUS}`}>Clear</button>}
      </form>

      <div className={query === null ? "" : "mt-3"} aria-busy={loading}>
        <p role="status" className="text-xs text-fg-muted">
          {statusText(active)}
        </p>

        {error !== null && (
          <button
            type="button"
            onClick={() => query !== null && search(query)}
            className={`mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border border-line px-3 text-xs text-fg hover:bg-surface-hover ${FOCUS}`}
          >
            <RotateCw className="size-3.5 text-white" aria-hidden="true" />
            Retry
          </button>
        )}

        {games && games.length > 0 && (
          <ul className="mt-2 divide-y divide-line/70 overflow-hidden rounded-xl border border-line bg-surface">
            {games.map((game) => (
              <li key={game.universeId}>
                <Link
                  href={`/analytics/games/${game.universeId}`}
                  prefetch={false}
                  className={`flex items-center gap-3 px-3 py-3 hover:bg-surface-hover ${ROW_FOCUS}`}
                >
                  <GameIcon url={game.iconUrl} name={game.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg" title={game.name}>
                      {game.name}
                    </span>
                    {game.sponsored && (
                      <span className="mt-1 inline-block rounded border border-line-strong px-1.5 text-[10px] text-fg-muted">
                        Sponsored
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right text-xs font-medium tabular-nums">
                    {compact.format(game.playing)}
                    <span className="mt-1 block text-[10px] font-normal text-fg-subtle">playing</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
