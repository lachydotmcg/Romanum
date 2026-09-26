import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Assistant } from "@/components/assistant/assistant";
import { MarketOverview, MarketOverviewLoading } from "@/components/market/overview";
import { SKILL_CATALOG } from "@/lib/skill-catalog";
import { PlayerHistory } from "@/components/history/player-history";
import { GameSearch } from "@/components/games/game-search";

export const metadata: Metadata = {
  title: "Analytics",
};

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ starter?: string }> }) {
  // Check for the key per request rather than baking the answer in at build time.
  await connection();
  const connected = Boolean(process.env.DEEPSEEK_API_KEY);
  const { starter } = await searchParams;
  const initialPrompt = SKILL_CATALOG.find((skill) => skill.id === starter)?.prompt ?? "";

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Explore the market</h1>
      </header>
      <Assistant key={starter ?? "default"} connected={connected} initialPrompt={initialPrompt} />

      <GameSearch />

      {/* Streams in after the prompt bar, so a slow Roblox response doesn't hold up the page. */}
      <Suspense fallback={<MarketOverviewLoading />}>
        <MarketOverview connected={connected} />
      </Suspense>

      <PlayerHistory />

      <section aria-labelledby="games-heading" className="mt-10">
        <h2 id="games-heading" className="text-base font-semibold tracking-tight text-fg">
          Your games
        </h2>
        <div className="mt-4 grid min-h-32 place-items-center rounded-xl border border-line px-6 py-8 text-center">
          <p className="text-sm text-fg-muted">No games connected</p>
        </div>
      </section>
    </>
  );
}
