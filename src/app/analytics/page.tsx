import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Assistant } from "@/components/assistant/assistant";
import { MarketOverview, MarketOverviewLoading } from "@/components/market/overview";

export const metadata: Metadata = {
  title: "Analytics",
};

export default async function AnalyticsPage() {
  // Check for the key per request rather than baking the answer in at build time.
  await connection();
  const connected = Boolean(process.env.DEEPSEEK_API_KEY);

  return (
    <>
      <h1 className="sr-only">Analytics</h1>
      <Assistant connected={connected} />

      {/* Streams in after the prompt bar, so a slow Roblox response doesn't hold up the page. */}
      <Suspense fallback={<MarketOverviewLoading />}>
        <MarketOverview />
      </Suspense>

      <section aria-labelledby="games-heading" className="mt-10">
        <h2 id="games-heading" className="text-base font-semibold tracking-tight text-fg">
          Your games
        </h2>
        <div className="mt-4 grid min-h-48 place-items-center rounded-xl border border-line px-6 py-10 text-center">
          <div>
            <p className="text-sm font-medium text-fg">No data connected</p>
            <p className="mt-1 text-sm text-fg-muted">
              Analytics will appear here once a game&apos;s data is connected.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
