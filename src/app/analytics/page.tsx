import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Assistant } from "@/components/assistant/assistant";
import { MarketOverview } from "@/components/market/overview";
import { SKILL_CATALOG } from "@/lib/skill-catalog";
import { PlayerHistory } from "@/components/history/player-history";
import { GameSearch } from "@/components/games/game-search";
import { ANALYTICS_VIEWS, AnalyticsNavigation, type AnalyticsView } from "@/components/analytics/navigation";
import { ChartInvitation } from "@/components/analytics/chart-invitation";
import { GamesSection, GenresSection, TrendsSection } from "@/components/analytics/sections";
import { EarningsCalculator } from "@/components/analytics/earnings-calculator";
import { RevenueControls } from "@/components/analytics/revenue";
import { analyticsPageMetadata } from "@/lib/public-discovery";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ view?: string }> }): Promise<Metadata> {
  return analyticsPageMetadata((await searchParams).view);
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ starter?: string; view?: string; genre?: string }> }) {
  // Check for the key per request rather than baking the answer in at build time.
  await connection();
  const connected = Boolean(process.env.DEEPSEEK_API_KEY);
  const { starter, view: requestedView, genre } = await searchParams;
  const view: AnalyticsView = ANALYTICS_VIEWS.includes(requestedView as AnalyticsView) ? requestedView as AnalyticsView : "overview";
  const initialPrompt = SKILL_CATALOG.find((skill) => skill.id === starter)?.prompt ?? "";

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Explore the market</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-fg-muted">Public Roblox analytics, free to browse without signup or MCP. <Link href="/analytics/data" className="text-fg underline underline-offset-4">Sources, freshness and metric definitions</Link></p>
      </header>
      <Assistant key={starter ?? "default"} connected={connected} initialPrompt={initialPrompt} />
      <ChartInvitation connected={connected} />
      <AnalyticsNavigation view={view} />
      {/* Keep the tab row anchored when streamed content briefly becomes a short fallback.
          scroll={false} alone cannot prevent the browser clamping a shrinking document. */}
      <div className="min-h-[calc(100svh-4rem)]">
        {view !== "earnings" && <div className="mt-4"><RevenueControls /></div>}

        {(view === "overview" || view === "games") && <GameSearch />}

        {/* Streams in after the prompt bar, so a slow Roblox response doesn't hold up the page. */}
        <Suspense key={`${view}:${genre ?? ""}`} fallback={<p role="status" className="mt-7 text-sm text-fg-muted">Loading…</p>}>
          {view === "overview" && <MarketOverview connected={connected} />}
          {(view === "games" || view === "charts") && <GamesSection chartMode={view === "charts"} genre={genre} />}
          {view === "trends" && <TrendsSection connected={connected} />}
          {view === "genres" && <GenresSection />}
        </Suspense>
        {view === "earnings" && <EarningsCalculator />}
        {(view === "overview" || view === "charts") && <PlayerHistory />}
      </div>
      <footer className="mt-10 border-t border-line py-5 text-xs text-fg-subtle"><Link href="/privacy" className="inline-flex min-h-10 items-center rounded-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/70">Privacy policy</Link></footer>
    </>
  );
}
