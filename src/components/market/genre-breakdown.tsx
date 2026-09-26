import { colorHex, PALETTE_ORDER, formatValue } from "@/lib/charts/spec";
import type { MarketAnalysis } from "@/lib/market-analysis";

export function GenreBreakdown({ analysis }: { analysis: MarketAnalysis }) {
  // Roblox genre labels within Top Playing Now, not platform-wide totals; see docs/data-notes.md.
  const rows = analysis.genres.slice(0, 5);
  const rest = analysis.genres.slice(5);
  if (rest.length) rows.push({ name: "Other", players: rest.reduce((s, g) => s + g.players, 0), gameCount: rest.reduce((s, g) => s + g.gameCount, 0), share: rest.reduce((s, g) => s + g.share, 0) });
  return (
    <section aria-label="Players by genre" className="rounded-xl border border-line bg-surface/40 p-5">
      <h3 className="text-sm font-medium">Players by genre</h3>
      <p className="mt-6 text-3xl font-semibold tracking-tight tabular-nums">{formatValue(analysis.samplePlayers, "compact")}</p>
      <p className="mt-1 text-xs text-fg-muted">players · {analysis.sampleSize} games</p>
      <div className="mt-5 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {rows.map((row, i) => <span key={row.name} style={{ width: `${row.share * 100}%`, background: colorHex(row.name === "Other" ? "gray" : PALETTE_ORDER[i]) }} />)}
      </div>
      <ul className="mt-5 divide-y divide-line">
        {rows.map((row, i) => (
          <li key={row.name} className="flex items-center gap-2.5 py-3.5 text-xs">
            <span className="size-2 shrink-0 rounded-sm" style={{ background: colorHex(row.name === "Other" ? "gray" : PALETTE_ORDER[i]) }} aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="block truncate text-fg">{row.name}</span><span className="mt-0.5 block text-fg-subtle">{row.gameCount} {row.gameCount === 1 ? "game" : "games"}</span></span>
            <span className="text-fg-muted tabular-nums">{formatValue(row.players, "compact")}</span>
            <span className="w-11 text-right font-medium tabular-nums">{(row.share * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
