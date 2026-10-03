import type { Database } from "../history/database.ts";
import { insightDay, latestInsight, type Insight } from "./store.ts";
import { marketTrendService } from "./trends.ts";

/** Read-only enrichment; a history outage must not hide an otherwise valid saved insight. */
export async function readCurrentInsight(database: Database, now = new Date(), trends = marketTrendService): Promise<{ insight: Insight | null; today: string }> {
  const [insight, trendEvidence] = await Promise.all([
    latestInsight(database), trends.analyze().catch(() => null),
  ]);
  return {
    insight: insight && trendEvidence ? { ...insight, trendEvidence } : insight,
    today: insightDay(now),
  };
}
