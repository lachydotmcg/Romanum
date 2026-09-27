"use client";

import { useState } from "react";
import Link from "next/link";
import { Select } from "@/components/select";
import { EARNINGS_INPUT, estimateEarnings, GENRE_RATES } from "@/lib/analytics/earnings";
import { EarningsRange, useRevenue } from "./revenue";

export function EarningsCalculator() {
  const [ccu, setCcu] = useState("");
  const [genre, setGenre] = useState("Simulation");
  const { days, currency, update } = useRevenue();
  const parsed = ccu.trim() ? EARNINGS_INPUT.safeParse({ ccu: Number(ccu), genre, days, basis: "average" }) : null;
  const estimate = parsed?.success ? estimateEarnings(parsed.data) : null;
  return <section className="mt-7 max-w-3xl" aria-labelledby="earnings-heading">
    <div className="mb-5 flex items-baseline justify-between gap-3"><h2 id="earnings-heading" className="text-base font-semibold">Earnings calculator</h2>
      <Link href="/analytics/earnings-method" className="text-xs text-fg-muted hover:text-white">Method</Link></div>
    <div className="rounded-xl border border-line bg-surface p-5 sm:p-6">
      <div className="grid gap-5 sm:grid-cols-3">
        <div><label htmlFor="earnings-ccu" className="text-xs text-fg-muted">Average CCU</label><input id="earnings-ccu" type="number" min="0" max="1000000000" step="any" inputMode="decimal" value={ccu} onChange={(event) => setCcu(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-white" /></div>
        <div><label htmlFor="earnings-genre" className="text-xs text-fg-muted">Genre</label><Select id="earnings-genre" label="Genre" value={genre} onChange={setGenre} options={Object.keys(GENRE_RATES).map((name) => ({ value:name,label:name }))} className="mt-2 min-h-11 w-full" /></div>
        <div><label htmlFor="earnings-days" className="text-xs text-fg-muted">Period</label><Select id="earnings-days" label="Period" value={String(days)} onChange={(value) => update({days:Number(value)})}
          options={[{value:"1",label:"1 day"},{value:"7",label:"7 days"},{value:"30",label:"30 days"}]} className="mt-2 min-h-11 w-full" /></div>
      </div>
      <div className="mt-6 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xs text-fg-muted">Estimated earnings · {days} {days === 1 ? "day" : "days"}</h3>
          <Select label="Earnings currency" value={currency} onChange={(value) => update({currency:value as "robux"|"usd"})} options={[{value:"robux",label:"Robux"},{value:"usd",label:"USD · DevEx"}]} className="text-xs" /></div>
        <div className="mt-5" aria-live="polite" aria-atomic="true"><p className="text-2xl font-semibold tracking-tight sm:text-3xl"><EarningsRange range={estimate?.robux ?? null} full /></p>
          {!estimate && <p className="mt-2 text-xs text-fg-muted">{parsed && !parsed.success ? "Enter CCU between 0 and 1 billion." : "Enter average CCU."}</p>}
          {currency === "usd" && <p className="mt-2 text-xs text-fg-muted">Pre-tax DevEx value</p>}
        </div>
      </div>
    </div>
  </section>;
}
