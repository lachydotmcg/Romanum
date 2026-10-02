import type { Metadata } from "next";
import Link from "next/link";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import { PUBLIC_GUIDE_LINKS, PUBLIC_ORIGIN } from "@/lib/public-discovery";

export const metadata: Metadata = {
  title: "Public Roblox data: sources and metric definitions",
  description: "Read and cite Romanum's public Roblox analytics without signup or MCP: metric definitions, sources, retrieval times, chart coverage and existing HTTP access.",
  alternates: { canonical: `${PUBLIC_ORIGIN}/analytics/data` },
};

export default function PublicDataPage() {
  return <article className="max-w-3xl space-y-7 text-sm leading-7 text-fg-muted">
    <header>
      <Link href="/analytics" prefetch={false} className="text-xs hover:text-fg">← Analytics</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-fg">Public Roblox data</h1>
      <p className="mt-4">Romanum makes public Roblox observations available to people and browsing AI assistants. Reading the analytics pages is free and requires neither signup nor an MCP installation. Hosted AI advice uses a separate verified, credit-based flow.</p>
    </header>
    <nav aria-label="Explore public data"><ul className="flex flex-wrap gap-x-5 gap-y-2">{PUBLIC_GUIDE_LINKS.map(link => <li key={link.href}><Link href={link.href} className="text-fg underline underline-offset-4">{link.label}</Link></li>)}</ul></nav>

    <section aria-labelledby="metrics-heading">
      <h2 id="metrics-heading" className="text-lg font-semibold text-fg">What the metrics mean</h2>
      <p className="mt-2">Game detail URLs use a universe ID. Roblox game links use a place ID. {METRIC_DEFINITIONS.identifiers.universeId} {METRIC_DEFINITIONS.identifiers.rootPlaceId}</p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[32rem] text-left text-xs leading-6"><caption className="sr-only">Public metric names, units and definitions</caption><thead className="bg-surface text-fg"><tr><th scope="col" className="px-4 py-3">Metric</th><th scope="col" className="px-4 py-3">Unit</th><th scope="col" className="px-4 py-3">Meaning</th></tr></thead><tbody className="divide-y divide-line">{Object.entries(METRIC_DEFINITIONS.metrics).map(([name, metric]) => <tr key={name}><th scope="row" className="px-4 py-3 align-top font-medium text-fg">{name}</th><td className="px-4 py-3 align-top">{metric.unit}</td><td className="px-4 py-3">{metric.meaning}</td></tr>)}</tbody></table>
      </div>
      <p className="mt-3">Missing values remain unknown, not zero. The public data does not supply actual revenue, retention, daily active users, session length, demographics or private developer analytics.</p>
    </section>

    <section aria-labelledby="sources-heading">
      <h2 id="sources-heading" className="text-lg font-semibold text-fg">Sources and freshness</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>Current game counts and metadata come from <a href="https://games.roblox.com/v1/games" className="text-fg underline">Roblox game statistics</a>; public charts come from <a href="https://www.roblox.com/charts" className="text-fg underline">Roblox Charts</a>.</li>
        <li>Name search uses Roblox&apos;s <a href="https://apis.roblox.com/search-api/omni-search" className="text-fg underline">web search endpoint</a>, which is undocumented and may change or fail. Sponsored placements are labelled in search results.</li>
        <li><code>fetchedAt</code> is when Romanum retrieved the observation. Cache hits retain that time; <code>expiresAt</code> is its cache expiry. Roblox&apos;s underlying measurement time is not supplied.</li>
        <li>Search and statistics cache for 60 seconds, charts for 120 seconds and place-to-universe mappings for one hour. Artwork is retrieved separately and can cache for up to one hour. Processes have separate caches; these do not create history.</li>
      </ul>
      <p className="mt-3">Cite the game or chart page with its full UTC retrieval date, metric and unit. A current count is a dated observation, not a guarantee of the value when someone reads your answer later.</p>
    </section>

    <section aria-labelledby="coverage-heading">
      <h2 id="coverage-heading" className="text-lg font-semibold text-fg">Chart coverage and recorded history</h2>
      <p className="mt-3">{METRIC_DEFINITIONS.coverage} Failed charts are omitted and listed as unavailable. The overview&apos;s genre breakdown uses Top Playing Now; the Genres view uses the union of loaded charts.</p>
      <p className="mt-3">Title patterns match words in game names. They can overlap and do not prove gameplay mechanics, audience demand, market saturation or historical growth. Top Earning preserves Roblox&apos;s ranking; it does not provide revenue figures.</p>
      <p className="mt-3">{METRIC_DEFINITIONS.history} The collector schedules five-minute slots. Actual successful retrieval times can vary, and coverage exists only for games it has sampled. Opening a game page does not enroll it or backfill earlier history.</p>
      <p className="mt-3">Earnings ranges are heuristic projections from current concurrent players, a chosen period and genre assumptions. They are separate from observed statistics. <Link href="/analytics/earnings-method" className="text-fg underline">Read the earnings model and assumptions</Link>.</p>
    </section>

    <section aria-labelledby="http-heading">
      <h2 id="http-heading" className="text-lg font-semibold text-fg">Public HTTP access</h2>
      <p className="mt-3">The existing read-only endpoints return JSON without authentication. You can read the website normally or request these URLs directly; an MCP client is optional.</p>
      <ul className="mt-3 space-y-4">
        <li><a href="/api/games/search?q=Brookhaven" className="break-all text-fg underline">GET /api/games/search?q=Brookhaven</a><p>Accepts a game name, a Roblox game URL, or a numeric place ID. Names are limited to 80 characters. A game URL is parsed and resolved through Roblox; arbitrary submitted URLs are never fetched. Results include source and retrieval/cache times.</p></li>
        <li><a href="/api/history/games" className="text-fg underline">GET /api/history/games</a><p>Returns up to 100 games with recorded public observations. This is a collection directory, not a list of every Roblox game.</p></li>
        <li><code className="break-all text-fg">GET /api/history?universeId=UNIVERSE_ID&amp;days=7</code><p>Replace UNIVERSE_ID with a positive universe ID. The period accepts 1–30 days and defaults to one day. Results report their source, period, sample count, gaps, observation status and nullable metrics. An empty or unavailable response does not establish zero activity.</p></li>
      </ul>
      <p className="mt-3">Public game statistics are also readable in each game&apos;s HTML page. MCP offers additional structured stats, charts, market summaries, definitions and guides; see the <Link href="/connect/guide" className="text-fg underline">free MCP guide</Link>. Private connected-game metrics are not included in these public endpoints or MCP.</p>
    </section>

    <section aria-labelledby="research-heading">
      <h2 id="research-heading" className="text-lg font-semibold text-fg">Ground a game idea in observations</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5"><li>Find comparable games and inspect their public pages and chart context.</li><li>Cite the actual counts, sources, sample coverage and retrieval dates. Use recorded history only where it exists.</li><li>Separate the observed evidence from a design hypothesis. Describe an original mechanic or audience test, the uncertainty and what result would change your decision.</li></ol>
      <p className="mt-3">A title pattern or popular game does not establish demand for another game. Romanum&apos;s public observations can inform a hypothesis; they do not guarantee a successful idea.</p>
    </section>
  </article>;
}
