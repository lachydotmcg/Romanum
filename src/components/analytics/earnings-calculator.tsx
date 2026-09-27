"use client";

import { useState } from "react";
import Link from "next/link";
import { DEVEX, EARNINGS_INPUT, estimateEarnings } from "@/lib/analytics/earnings";

const CONTROL = "mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-white";
const GENRES = ["Custom", "Action", "Adventure", "Education", "Entertainment", "Obby & Platformer", "Party & Casual", "Puzzle", "Roleplay & Avatar Sim", "RPG", "Shooter", "Shopping", "Simulation", "Social", "Sports & Racing", "Strategy", "Survival", "Utility & Other"];

export function EarningsCalculator() {
  const [average, setAverage] = useState("");
  const [days, setDays] = useState("30");
  const [genre, setGenre] = useState("Custom");
  // Scenario assumptions stay in this browser component; no private metrics are submitted.
  const [assumptions, setAssumptions] = useState<Record<string, { low: string; high: string }>>({});
  const [currency, setCurrency] = useState<"robux" | "usd">("robux");
  const [eligible, setEligible] = useState("0");
  const current = assumptions[genre] ?? { low: "", high: "" };
  const complete = [average, days, current.low, current.high, eligible].every((value) => value.trim() !== "");
  const parsed = complete ? EARNINGS_INPUT.safeParse({
    averageCcu: Number(average), days: Number(days), lowRobuxPerPlayerHour: Number(current.low), highRobuxPerPlayerHour: Number(current.high), eligibleUs18Percent: Number(eligible),
  }) : null;
  const result = parsed?.success ? estimateEarnings(parsed.data) : null;
  const values = result?.[currency];
  const number = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const format = (value: number) => currency === "robux" ? `${number.format(value)} R$` : money.format(value);

  return <section className="mt-7 max-w-3xl" aria-labelledby="earnings-heading">
    <div className="mb-5 flex items-baseline justify-between gap-3">
      <h2 id="earnings-heading" className="text-base font-semibold">Earnings calculator</h2>
      <Link href="/analytics/earnings-method" className="text-xs text-fg-muted hover:text-white">Method</Link>
    </div>
    <div className="rounded-xl border border-line bg-surface p-5 sm:p-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="text-xs text-fg-muted">Average CCU<input type="number" min="0" max="1000000000" step="any" inputMode="decimal" value={average} onChange={(event) => setAverage(event.target.value)} className={CONTROL} /></label>
        <label className="text-xs text-fg-muted">Period<select value={days} onChange={(event) => setDays(event.target.value)} className={CONTROL}><option value="30">30 days</option><option value="7">7 days</option><option value="1">1 day</option></select></label>
      </div>
      <div className="mt-6 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Your genre assumptions</h3>
          <select aria-label="Scenario genre" value={genre} onChange={(event) => setGenre(event.target.value)} className="min-h-10 max-w-full rounded-lg border border-line bg-surface px-3 text-xs text-fg">
            {GENRES.map((name) => <option key={name}>{name}</option>)}
          </select>
        </div>
        <p className="mt-2 text-xs text-fg-muted">Net Earned Robux per player-hour</p>
        <div className="mt-3 grid grid-cols-2 gap-5">
          {(["low", "high"] as const).map((key) => <label key={key} className="text-xs capitalize text-fg-muted">{key}<input type="number" min="0" max="1000000" step="any" inputMode="decimal" value={current[key]}
            onChange={(event) => setAssumptions({ ...assumptions, [genre]: { ...current, [key]: event.target.value } })} className={CONTROL} /></label>)}
        </div>
      </div>
      <div className="mt-6 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs text-fg-muted">Estimated earnings · {days} days</h3>
          <div className="flex rounded-lg border border-line p-1" role="group" aria-label="Earnings currency">
            {(["robux", "usd"] as const).map((value) => <button key={value} type="button" aria-pressed={currency === value} onClick={() => setCurrency(value)}
              className={`rounded-md px-3 py-1.5 text-xs ${currency === value ? "bg-surface-hover text-white" : "text-fg-muted hover:text-white"}`}>{value === "robux" ? "Robux" : "USD · DevEx"}</button>)}
          </div>
        </div>
        <div className="mt-5" aria-live="polite" aria-atomic="true">
          <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{values ? `${format(values.low)} – ${format(values.high)}` : "–"}</p>
          <p className="mt-2 text-xs text-fg-muted">{parsed && !parsed.success ? parsed.error.issues[0].message : result ? "Based on your assumptions." : "Enter CCU and an earnings range."}</p>
        </div>
        {currency === "usd" && <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs text-fg-muted">Pre-tax · standard DevEx ${DEVEX.standard}/R$</p>
          <details className="mt-3 text-xs text-fg-muted"><summary className="cursor-pointer text-fg">US 18+ eligible earnings</summary>
            <label className="mt-4 block max-w-xs">Eligible share of Earned Robux (%)<input type="number" min="0" max="100" step="any" value={eligible} onChange={(event) => setEligible(event.target.value)} className={CONTROL} /></label>
            <a href="https://create.roblox.com/docs/production/monetization/18-plus-devex-rate" target="_blank" rel="noreferrer" className="mt-3 inline-block hover:text-white">Eligibility ↗</a>
          </details>
        </div>}
      </div>
    </div>
  </section>;
}
