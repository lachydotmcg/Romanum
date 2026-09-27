import Link from "next/link";
import { DEVEX } from "@/lib/analytics/earnings";

export const metadata = { title: "Earnings method" };

export default function EarningsMethod() {
  return <article className="max-w-2xl space-y-5 text-sm leading-relaxed text-fg-muted">
    <Link href="/analytics?view=earnings" className="text-xs hover:text-white">← Earnings</Link>
    <h1 className="text-2xl font-semibold text-fg">Earnings method</h1>
    <p>This calculator models a scenario from your assumptions. It does not report a game&apos;s actual revenue or a statistical confidence interval.</p>
    <p className="rounded-xl border border-line bg-surface p-4 text-fg">Average CCU × 24 × days × Earned Robux per player-hour</p>
    <p>Use average CCU across the chosen period, not a peak or a live snapshot. The low and high rates are net Earned Robux retained by the creator after platform fees and any revenue splits. No fee is deducted again.</p>
    <p>Genre assumptions are separate inputs. Romanum currently has no verified genre earnings benchmarks, so it supplies no default rates. Public player counts alone cannot establish spending, payer conversion or private earnings. Inputs stay in the current page and clear when you leave.</p>
    <h2 className="text-base font-semibold text-fg">DevEx</h2>
    <p>USD represents estimated cash-out value before tax, transfer costs and development expenses. It is not profit or the price players pay for Robux. DevEx eligibility and approval still apply.</p>
    <p>The standard rate is $0.0038 per Earned Robux earned on or after 5 September 2025 at 10 AM PT. Older balances use $0.0035 and are outside this calculator.</p>
    <p>Since 8 June 2026, eligible earnings from verified US players aged 18+ can use $0.0054. This applies to eligible purchases of developer products, passes, subscriptions and private servers in eligible experiences. Enter only the eligible share of earnings, not the share of players.</p>
    <p>Rates checked {DEVEX.checkedAt}. <a href={DEVEX.source} target="_blank" rel="noreferrer" className="text-fg underline">Roblox DevEx rates</a> · <a href="https://create.roblox.com/docs/production/monetization/18-plus-devex-rate" target="_blank" rel="noreferrer" className="text-fg underline">US 18+ eligibility</a></p>
  </article>;
}
