"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, ChartNoAxesCombined } from "lucide-react";
import { GameIcon } from "@/components/game-icon";
import { ChartCard } from "@/components/charts/chart-card";
import { prefillAssistant } from "@/components/assistant/prefill";
import { formatValue } from "@/lib/charts/spec";
import { chartPrompt, EXPLORER_METRICS, explorerChart, filterGames, type ExplorerGame, type ExplorerMetric, type ExplorerSort } from "@/lib/analytics/explorer";

const CONTROL = "min-h-10 rounded-lg border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-white";
const PAGE_SIZE = 20;

export function GameExplorer({ games, connected, chartMode = false, initialGenre = "" }: {
  games: ExplorerGame[]; connected: boolean; chartMode?: boolean; initialGenre?: string;
}) {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState(initialGenre);
  const [chart, setChart] = useState("");
  const [sort, setSort] = useState<ExplorerSort>("playing");
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [metric, setMetric] = useState<ExplorerMetric>("playing");
  const [kind, setKind] = useState<"bar" | "column" | "donut">("bar");
  const genres = [...new Set(games.map((game) => game.genre || "Unlisted"))].sort();
  const filtered = filterGames(games, { query, genre, chart, sort, ascending });
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const chartGames = selected.length ? games.filter((game) => selected.includes(game.universeId)) : filtered.slice(0, kind === "donut" ? 6 : 12);
  const effectiveKind = kind === "donut" && selected.length > 6 ? "bar" : kind;
  const spec = explorerChart(chartGames, metric, effectiveKind);
  const ask = () => prefillAssistant({ prompt: chartPrompt(chartGames, chartMode ? metric : sort === "created" ? "playing" : sort) });

  function select(id: number) {
    setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : ids.length < 12 ? [...ids, id] : ids);
  }

  return (
    <section aria-label={chartMode ? "Chart builder" : "Game explorer"} className="mt-7">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{chartMode ? "Create a chart" : "Explore games"}</h2>
        <button type="button" disabled={!connected || !chartGames.length} onClick={ask}
          className={`${CONTROL} inline-flex items-center gap-2 hover:bg-surface-hover disabled:opacity-40`}>
          <ChartNoAxesCombined className="size-4 text-white" aria-hidden="true" /> Create with AI
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <input type="search" aria-label="Filter games" placeholder="Filter games" value={query} maxLength={100}
          onChange={(event) => { setQuery(event.target.value); setPage(0); }} className={`${CONTROL} min-w-0 grow sm:grow-0`} />
        <select aria-label="Genre" value={genre} onChange={(event) => { setGenre(event.target.value); setPage(0); }} className={`${CONTROL} max-w-full`}>
          <option value="">All genres</option>{genres.map((name) => <option key={name}>{name}</option>)}
        </select>
        <select aria-label="Roblox chart" value={chart} onChange={(event) => { setChart(event.target.value); setPage(0); }} className={CONTROL}>
          <option value="">All charts</option><option value="top-playing-now">Top Playing</option><option value="top-trending">Trending</option>
          <option value="up-and-coming">Up-and-Coming</option><option value="top-earning">Top Earning</option>
        </select>
        <select aria-label="Sort games by" value={sort} onChange={(event) => { setSort(event.target.value as ExplorerSort); setPage(0); }} className={CONTROL}>
          {Object.entries(EXPLORER_METRICS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="created">Created</option>
        </select>
        <button type="button" aria-label={ascending ? "Sort descending" : "Sort ascending"} onClick={() => { setAscending(!ascending); setPage(0); }} className={CONTROL}>
          {ascending ? <ArrowUpWideNarrow className="size-4 text-white" /> : <ArrowDownWideNarrow className="size-4 text-white" />}
        </button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-fg-muted" role="status">
        <span>{filtered.length} games in Roblox charts</span>
        {selected.length > 0 && <><span>{selected.length}/12 selected</span><button type="button" onClick={() => setSelected([])} className="text-white hover:underline">Clear selection</button></>}
      </div>
      {chartMode && <div className="mb-5">
        <div className="mb-3 flex flex-wrap gap-2">
          <select aria-label="Chart metric" value={metric} onChange={(event) => setMetric(event.target.value as ExplorerMetric)} className={CONTROL}>
            {Object.entries(EXPLORER_METRICS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="Chart type" value={metric === "likeRatio" && effectiveKind === "donut" ? "bar" : effectiveKind} onChange={(event) => setKind(event.target.value as typeof kind)} className={CONTROL}>
            <option value="bar">Bars</option><option value="column">Columns</option><option value="donut" disabled={metric === "likeRatio" || selected.length > 6}>Donut · up to 6</option>
          </select>
        </div>
        {spec.categories.length && spec.series[0].values.some((value) => value !== null) ? <ChartCard chart={spec} /> : <p role="status" className="rounded-xl border border-line p-5 text-sm text-fg-muted">No data for this chart.</p>}
      </div>}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[750px] text-left text-xs tabular-nums">
          <thead className="border-b border-line text-fg-muted"><tr>
            <th className="w-10 px-3 py-3"><span className="sr-only">Select games</span></th>
            <th className="py-3 font-medium">Game</th><th className="px-3 py-3 font-medium">Genre</th>
            {Object.entries(EXPLORER_METRICS).map(([key, label]) => <th key={key} aria-sort={sort === key ? ascending ? "ascending" : "descending" : "none"} className="px-3 py-3 text-right font-medium">
              <button type="button" onClick={() => { if (sort === key) setAscending(!ascending); else { setSort(key as ExplorerSort); setAscending(false); } setPage(0); }} className="whitespace-nowrap hover:text-white">{label}</button>
            </th>)}
            <th className="px-3 py-3 text-right font-medium">Created</th>
          </tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((game) => <tr key={game.universeId} className="hover:bg-surface-hover">
              <td className="px-3"><input type="checkbox" aria-label={`Select ${game.name}`} checked={selected.includes(game.universeId)} disabled={selected.length >= 12 && !selected.includes(game.universeId)} onChange={() => select(game.universeId)} className="size-4 accent-white" /></td>
              <td className="py-3"><Link prefetch={false} href={`/analytics/games/${game.universeId}`} className="flex w-56 items-center gap-3 hover:underline">
                <GameIcon url={game.iconUrl} name={game.name} className="size-10" />
                <span className="min-w-0"><span className="block truncate font-medium" title={game.name}>{game.name}</span>{game.creatorName && <span className="mt-1 block truncate text-[11px] text-fg-muted">{game.creatorName}</span>}</span>
              </Link></td>
              <td className="max-w-40 truncate px-3 text-fg-muted" title={game.genre ?? "Unlisted"}>{game.genre ?? "Unlisted"}</td>
              {Object.keys(EXPLORER_METRICS).map((key) => <td key={key} className="px-3 text-right" title={String(game[key as ExplorerMetric] ?? "Unavailable")}>{formatValue(game[key as ExplorerMetric], key === "likeRatio" ? "percent" : "compact")}</td>)}
              <td className="whitespace-nowrap px-3 text-right text-fg-muted">{game.created?.slice(0, 10) ?? "–"}</td>
            </tr>)}
            {!rows.length && <tr><td colSpan={8} className="p-8 text-center text-fg-muted">No games match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span>{filtered.length ? currentPage * PAGE_SIZE + 1 : 0}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
        <div className="flex gap-2"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)} className={`${CONTROL} disabled:opacity-40`}>Previous</button>
          <button type="button" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)} className={`${CONTROL} disabled:opacity-40`}>Next</button></div>
      </div>
    </section>
  );
}
