"use client";

import Link from "next/link";
import type { GenreSignal } from "@/lib/market-analysis";
import { formatValue } from "@/lib/charts/spec";
import { GameEarnings, useRevenue } from "./revenue";

export function GenresTable({ genres }: { genres: GenreSignal[] }) {
  const { revenue, days } = useRevenue();
  return <div>
    {revenue && <p className="mb-3 text-xs text-fg-muted">Estimated {days}-day earnings at current player counts. Share of players stays based on current players.</p>}
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-96 text-left text-sm tabular-nums">
        <caption className="sr-only">Genre metrics: {revenue ? `estimated ${days}-day earnings` : "current players"}. Player shares describe the sampled Roblox charts.</caption>
        <thead className="border-b border-line text-xs text-fg-muted"><tr>
          <th scope="col" className="px-5 py-3 font-medium">Genre</th><th scope="col" className="px-5 py-3 text-right font-medium">Games</th>
          <th scope="col" className="px-5 py-3 text-right font-medium">{revenue ? "Est. earnings" : "Players now"}</th><th scope="col" className="px-5 py-3 text-right font-medium">Share of players</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{genres.map(genre => <tr key={genre.name} className="hover:bg-surface-hover">
          <th scope="row" className="px-5 py-4 font-normal"><Link prefetch={false} scroll={false} href={`/analytics?view=games&genre=${encodeURIComponent(genre.name)}`} className="hover:underline focus-visible:outline-2 focus-visible:outline-fg/70 outline-offset-2">{genre.name}</Link></th>
          <td className="px-5 py-4 text-right text-fg-muted">{genre.gameCount}</td>
          <td className="px-5 py-4 text-right">{revenue ? <GameEarnings game={{ playing: genre.players, genre: genre.name }} /> : formatValue(genre.players, "compact")}</td>
          <td className="px-5 py-4 text-right text-fg-muted">{formatValue(genre.share, "percent")}</td>
        </tr>)}</tbody>
      </table>
      {!genres.length && <p role="status" className="p-5 text-sm text-fg-muted">No genres found.</p>}
    </div>
  </div>;
}
