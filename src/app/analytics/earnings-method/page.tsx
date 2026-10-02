import Link from "next/link";
import { DEVEX, GENRE_RATES, EARNINGS_MODEL_VERSION } from "@/lib/analytics/earnings";

export const metadata = { title: "Roblox earnings estimate method", description: "Romanum’s heuristic earnings model, genre assumptions and DevEx sources. These projections are separate from observed statistics and actual revenue.", alternates: { canonical: "https://romanum.dev/analytics/earnings-method" } };

export default function EarningsMethod() {
  return <article className="max-w-2xl space-y-5 text-sm leading-relaxed text-fg-muted">
    <Link href="/analytics?view=earnings" className="text-xs hover:text-white">← Earnings</Link>
    <h1 className="text-2xl font-semibold text-fg">Earnings method</h1>
    <p>Romanum estimates earnings from CCU, period and genre. The low and high bounds use initial heuristic assumptions, not verified genre averages or statistical confidence intervals. Actual earnings can fall outside the range.</p>
    <p className="rounded-xl border border-line bg-surface p-4 text-fg">CCU × 24 × days × genre rate = estimated Earned Robux</p>
    <p>Game views hold the current player count constant across the chosen period. They do not reconstruct past earnings or establish average CCU. The calculator instead uses the average CCU you enter. A month means 30 days.</p>
    <p>The genre rates below model net Earned Robux after platform fees and revenue splits. No fee is deducted again. Roblox&apos;s primary genre selects the rate; missing or unrecognised genres use General, the full envelope of the genre bands. Genres and patterns sum their member games; overlapping patterns must not be added together.</p>
    <p>Top Earning keeps Roblox&apos;s chart order, which can differ from the model&apos;s estimated order. No private connected-game metrics are used to calibrate this model.</p>
    <h2 className="text-base font-semibold text-fg">Model assumptions</h2>
    <p className="text-xs">Version: {EARNINGS_MODEL_VERSION}. These coefficients are Romanum assumptions, not rates supplied by Roblox.</p>
    <table className="w-full text-left tabular-nums"><thead><tr className="border-b border-line"><th className="py-2 font-medium">Genre</th><th className="py-2 text-right font-medium">Net Robux / player-hour</th></tr></thead><tbody>{Object.entries(GENRE_RATES).map(([genre, rates]) => <tr key={genre} className="border-b border-line"><td className="py-2">{genre}</td><td className="py-2 text-right">{rates[0]}–{rates[1]}</td></tr>)}</tbody></table>
    <h2 className="text-base font-semibold text-fg">DevEx</h2>
    <p>USD represents estimated cash-out value before tax, transfer costs and development expenses. It is not profit or the price players pay for Robux. DevEx eligibility and approval still apply.</p>
    <p>The standard rate is $0.0038 per Earned Robux earned on or after 5 September 2025 at 10 AM PT. Older balances use $0.0035 and are outside this calculator.</p>
    <p>Eligible US 18+ earnings can receive a higher rate. Romanum does not infer that eligibility from genre or player counts, so these estimates use only the standard rate.</p>
    <p>Rates checked {DEVEX.checkedAt}. <a href={DEVEX.source} target="_blank" rel="noreferrer" className="text-fg underline">Roblox DevEx rates</a> · <a href="https://create.roblox.com/docs/production/monetization/18-plus-devex-rate" target="_blank" rel="noreferrer" className="text-fg underline">US 18+ eligibility</a></p>
  </article>;
}
