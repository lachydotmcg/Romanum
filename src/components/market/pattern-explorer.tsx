"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { GameIcon } from "@/components/game-icon";
import { prefillAssistant } from "@/components/assistant/prefill";
import { formatValue } from "@/lib/charts/spec";
import type { MarketAnalysis } from "@/lib/market-analysis";

export function PatternExplorer({ analysis, connected }: { analysis: MarketAnalysis; connected: boolean }) {
  // Title matching and sample limitations are documented in docs/data-notes.md.
  const [selectedId, setSelectedId] = useState(analysis.patterns[0]?.id);
  const selected = analysis.patterns.find((pattern) => pattern.id === selectedId) ?? analysis.patterns[0];
  if (!selected) return null;
  return (
    <section aria-labelledby="patterns-heading" className="mt-10">
      <h2 id="patterns-heading" className="text-base font-semibold tracking-tight">Patterns</h2>
      <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface/40 md:grid md:grid-cols-[240px_minmax(0,1fr)]">
        <div className="flex overflow-x-auto border-b border-line p-2 md:block md:border-r md:border-b-0" role="group" aria-label="Game patterns">
          {analysis.patterns.map((pattern) => (
            <button key={pattern.id} type="button" onClick={() => setSelectedId(pattern.id)} aria-pressed={selected.id === pattern.id}
              className={`flex min-w-40 shrink-0 items-center justify-between gap-4 rounded-lg px-3 py-3 text-left transition-colors md:w-full ${selected.id === pattern.id ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface hover:text-fg"} focus-visible:outline-2 focus-visible:outline-fg-muted`}>
              <span><span className="block text-[13px] font-medium">{pattern.label}</span><span className="mt-1 block text-[11px] text-fg-subtle">{pattern.gameCount} {pattern.gameCount === 1 ? "game" : "games"}</span></span>
              <span className="text-xs tabular-nums">{formatValue(pattern.players, "compact")}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 p-5">
          <h3 className="text-lg font-semibold tracking-tight">{selected.label}</h3>
          <dl className="my-5 grid grid-cols-2 gap-4 border-y border-line py-4 sm:grid-cols-4">
            <div><dt className="text-[11px] text-fg-muted">Players now</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums">{formatValue(selected.players, "compact")}</dd></div>
            <div><dt className="text-[11px] text-fg-muted">Median per game</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums">{selected.gameCount ? formatValue(selected.medianPlayers, "compact") : "–"}</dd></div>
            <div><dt className="text-[11px] text-fg-muted">Leader share</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums">{formatValue(selected.leaderShare, "percent")}</dd></div>
            <div><dt className="text-[11px] text-fg-muted">Up-and-Coming</dt><dd className="mt-1.5 text-xl font-semibold tabular-nums">{selected.risingCount}<span className="ml-1 text-xs font-normal text-fg-subtle">{selected.risingCount === 1 ? "game" : "games"}</span></dd></div>
          </dl>
          {selected.gameCount ? (
            <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              {selected.games.slice(0, 6).map((game) => (
                <li key={game.universeId} className="min-w-0"><Link href={`/analytics/games/${game.universeId}`} prefetch={false} className="group flex items-center gap-2.5 rounded-lg py-2 pr-1 focus-visible:outline-2 focus-visible:outline-fg-muted">
                  <GameIcon url={game.iconUrl} name={game.name} className="size-9" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium group-hover:underline" title={game.name}>{game.name}</span><span className="mt-1 block text-[11px] text-fg-muted">{formatValue(game.playing, "compact")} playing</span></span>
                  <ArrowRight className="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />
                </Link></li>
              ))}
            </ul>
          ) : <p className="py-3 text-sm text-fg-muted">No matches</p>}
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button type="button" disabled={!connected} onClick={() => prefillAssistant({ prompt: `Develop an original ${selected.label} game idea using current market data.` })}
              className="inline-flex items-center gap-2 rounded-lg bg-fg px-3 py-2 text-xs font-medium text-canvas hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg">
              Develop an idea <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
