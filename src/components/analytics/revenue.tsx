"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { Robux } from "@/components/robux";
import { Select } from "@/components/select";
import { currentEarnings, DEVEX } from "@/lib/analytics/earnings";

type Preferences = { revenue: boolean; days: number; currency: "robux" | "usd" };
const DEFAULTS: Preferences = { revenue: false, days: 30, currency: "robux" };
const Context = createContext<Preferences & { update: (value: Partial<Preferences>) => void }>({ ...DEFAULTS, update: () => {} });
export function RevenueProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(DEFAULTS);
  return <Context.Provider value={{ ...preferences, update: (value) => setPreferences((current) => ({ ...current, ...value })) }}>{children}</Context.Provider>;
}
export const useRevenue = () => useContext(Context);

export function RevenueControls({ toggle = true }: { toggle?: boolean }) {
  const { revenue, currency, days, update } = useRevenue();
  return <div className="flex flex-wrap items-center gap-2" aria-label="Revenue display">
    {toggle && <button type="button" aria-pressed={revenue} onClick={() => update({ revenue: !revenue })}
      className={`inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-xs ${revenue ? "bg-surface-hover text-white" : "bg-surface text-fg-muted hover:text-white"}`}><Robux className="size-4 text-white" /> Est. earnings</button>}
    <Select label="Earnings period" value={String(days)} onChange={(value) => update({ days: Number(value) })} options={[{value:"1",label:"Per day"},{value:"7",label:"Per week"},{value:"30",label:"Per month"}]} className="text-xs" />
    <Select label="Earnings currency" value={currency} onChange={(value) => update({ currency: value as Preferences["currency"] })} options={[{value:"robux",label:"Robux"},{value:"usd",label:"USD · DevEx"}]} className="text-xs" />
    <Link href="/analytics/earnings-method" className="px-1 text-xs text-fg-muted hover:text-white">Method</Link>
  </div>;
}

export function EarningsRange({ range, full = false, className = "" }: { range: {low:number;high:number} | null; full?: boolean; className?: string }) {
  const { currency } = useRevenue();
  if (!range) return <span className={className}>–</span>;
  const scale = currency === "usd" ? DEVEX.standard : 1;
  const format = new Intl.NumberFormat("en-US", { notation: full ? "standard" : "compact", maximumFractionDigits: full ? 0 : 1 });
  const content = `${currency === "usd" ? "$" : ""}${format.format(range.low * scale)}–${currency === "usd" ? "$" : ""}${format.format(range.high * scale)}`;
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums ${className}`} aria-label={`${content} ${currency === "robux" ? "Robux" : "USD"} estimated`}>
    {currency === "robux" && <Robux className="size-[1em] shrink-0 text-white" />}{content}
  </span>;
}

export function GameEarnings({ game, className, full = false }: { game: {playing:number;genre?:string|null}; className?:string; full?:boolean }) {
  const { days } = useRevenue();
  return <EarningsRange range={currentEarnings(game, days)?.robux ?? null} full={full} className={className} />;
}

export function GameEarningsPanel({ game }: { game: {playing:number;genre?:string|null} }) {
  const { days } = useRevenue();
  return <section aria-label="Estimated earnings" className="mt-6 rounded-xl border border-line bg-surface p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium">Estimated earnings</h2><RevenueControls toggle={false} /></div>
    <div className="mt-4 text-2xl font-semibold"><GameEarnings game={game} /></div><p className="mt-2 text-xs text-fg-muted">{days} {days === 1 ? "day" : "days"} at current CCU</p>
  </section>;
}
