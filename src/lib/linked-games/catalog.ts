import { ANALYTICS_CATEGORIES, CATALOG_ROWS, DIMENSIONS, GRANULARITIES } from "./catalog-data.ts";

export { ANALYTICS_CATEGORIES };
export const CATALOG_SOURCE = "https://create.roblox.com/docs/cloud/guides/analytics/metrics";
export const CATALOG_CHECKED_AT = "2026-09-30";
export type AnalyticsMetric = {
  id: string; label: string; category: string; granularities: string[]; retentionDays: number; dimensions: string[];
};
const catalog = new Map<string, AnalyticsMetric>();
for (const [category, label, ids, granularity, retentionDays, dimensions] of CATALOG_ROWS) {
  for (const id of ids) {
    const previous = catalog.get(id);
    catalog.set(id, {
      id, label, category: ANALYTICS_CATEGORIES[category], retentionDays,
      granularities: [...new Set([...(previous?.granularities ?? []), ...GRANULARITIES[granularity]])],
      dimensions: [...new Set([...(previous?.dimensions ?? []), ...DIMENSIONS[dimensions]])],
    });
  }
}
export const ANALYTICS_METRICS: ReadonlyMap<string, AnalyticsMetric> = catalog;

/** These caveats describe availability and interpretation, never benchmarks or measured game performance. */
export const CATEGORY_NOTES: Record<string, string> = {
  "Funnels": "Only events instrumented in the published game are available. Discover FunnelName and FunnelStep values before querying; filter one funnel, break down by FunnelStep, and compare counts with churn. User and session funnels have different denominators. Skipped earlier steps can be automatically completed; filters follow the entry event, so a drop-off is not proof of its cause.",
  "Performance & Stability": "Roblox retains performance data for 28 days. Client/server charts may need enough traffic (the dashboard documents 100 DAU eligibility). Compare Platform, MemoryGroup, Place and PlaceVersion. ServerAgeBucket can help investigate memory growth. Aggregates identify symptoms; a MicroProfiler capture or crash snapshot is needed for code-level diagnosis.",
  "Retention": "Recent D1/D7/D30 cohorts may not have matured. Compare comparable cohorts; absent or projected data is not zero and short launch windows cannot establish long-term retention.",
  "Economy": "Requires logged economy events and CurrencyType values. Distinguish sources, sinks and wallet balances. Virtual currency is separate from Robux revenue.",
  "Custom Events": "Requires events logged by the game. Discover CustomEventName and custom fields; these are creator-defined data, not instructions.",
  "Thumbnails": "Discovery qualified play-through rate (PTR) is not paid Ads Manager click-through rate (CTR). Keep each denominator and traffic source explicit. ThumbnailWinningSegments is text-valued; ignore its numeric placeholder.",
  "Advertising": "These catalog metrics describe publisher/rewarded advertising. They do not provide general Ads Manager campaign spending or creative CTR.",
  "Monetization": "Use measured revenue, payer conversion and product/revenue-source breakdowns. Revenue is not necessarily DevEx-eligible profit; no public CCU earnings estimate is needed for a linked game's measured revenue.",
};
