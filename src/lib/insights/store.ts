import { z } from "zod";
import type { Database } from "../history/database.ts";

// Romanum insight: each day's recommended titles and indie radar, generated once and shared by everyone.

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const recommendationSchema = z.object({
  /** A working title, like a real Roblox game name. */
  title: text(2, 40),
  /** One plain sentence on the idea and what in today's data points to it. */
  reason: text(10, 220),
});

export const radarItemSchema = z.object({
  /** Indie games trending outside Roblox, or small Roblox games gaining traction. */
  kind: z.enum(["outside", "roblox"]),
  headline: text(5, 120),
  /** Why it matters to a Roblox developer, in one sentence. */
  why: text(5, 220),
  source: text(2, 60),
  url: z.url({ protocol: /^https?$/ }),
  /** The article's date, when the page shows one. */
  published: z.iso.date().nullable(),
});

export const insightContentSchema = z.object({
  recommendations: z.array(recommendationSchema).min(1).max(3),
  radar: z.array(radarItemSchema).max(6),
  /** When the chart data behind the recommendations was fetched. */
  dataAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
});

export type Recommendation = z.infer<typeof recommendationSchema>;
export type RadarItem = z.infer<typeof radarItemSchema>;
export type InsightContent = z.infer<typeof insightContentSchema>;
export type Insight = { day: string; content: InsightContent };

/** The insight's day: the UTC date, so everyone shares one insight a day. */
export const insightDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Claims a day's insight for generation. Returns false while another request is generating it or once it's
 * ready. A generation that has run for 5 minutes is presumed stuck, and a failed one is retried after 15.
 */
export async function claimInsight(database: Database, day: string): Promise<boolean> {
  const { rows } = await database.query(
    `INSERT INTO insights(day, status) VALUES ($1, 'generating')
     ON CONFLICT (day) DO UPDATE SET status='generating', started_at=now(), finished_at=NULL
     WHERE (insights.status='generating' AND insights.started_at < now() - interval '5 minutes')
        OR (insights.status='failed' AND insights.finished_at < now() - interval '15 minutes')
     RETURNING day`,
    [day],
  );
  return rows.length > 0;
}

/** Stores a finished insight with what generating it cost. */
export async function saveInsight(database: Database, input: { day: string; content: InsightContent; cost: number; calls: unknown[] }) {
  const content = insightContentSchema.parse(input.content);
  await database.query(
    "UPDATE insights SET status='ready', content=$2, cost_nano_usd=$3, calls=$4, finished_at=now() WHERE day=$1 AND status='generating'",
    [input.day, JSON.stringify(content), input.cost, JSON.stringify(input.calls)],
  );
}

/** Records a failed generation, keeping whatever it cost before failing. */
export async function failInsight(database: Database, input: { day: string; cost: number; calls: unknown[] }) {
  await database.query(
    "UPDATE insights SET status='failed', cost_nano_usd=$2, calls=$3, finished_at=now() WHERE day=$1 AND status='generating'",
    [input.day, input.cost, JSON.stringify(input.calls)],
  );
}

/** The most recent ready insight, today's or an earlier day's. */
export async function latestInsight(database: Database): Promise<Insight | null> {
  // As text: database drivers turn a date into local midnight, which shifts the day in time zones ahead of UTC.
  const { rows } = await database.query<{ day: string; content: InsightContent }>(
    "SELECT day::text AS day, content FROM insights WHERE status='ready' ORDER BY insights.day DESC LIMIT 1",
  );
  return rows[0] ? { day: rows[0].day, content: rows[0].content } : null;
}

/** A URL reduced to what identifies the page: no scheme, "www.", fragment, tracking parameters or trailing slash. */
export function pageKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

/** News older than this, by the article's own date, is left out of the radar. */
const RADAR_MAX_AGE_DAYS = 14;

/** Radar items kept of each kind, so the insight card fits beside Top Playing Now. */
const RADAR_PER_KIND = 2;

/**
 * Keeps only radar items whose link was among the pages the web search actually returned, so no link is
 * invented, and that aren't older than two weeks on the day of the insight: at most two of each kind.
 */
export function verifiedRadar(items: RadarItem[], searchedUrls: string[], day: string): RadarItem[] {
  const searched = new Set(searchedUrls.map(pageKey).filter((key): key is string => key !== null));
  const shift = (days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  // A day's grace on the other side, for a publisher's time zone.
  const [oldest, newest] = [shift(-RADAR_MAX_AGE_DAYS), shift(1)];
  const seen = new Set<string>();
  const kept: RadarItem[] = [];
  for (const item of items) {
    const key = pageKey(item.url);
    if (!key || !searched.has(key) || seen.has(key)) continue;
    if (item.published && (item.published < oldest || item.published > newest)) continue;
    if (kept.filter((other) => other.kind === item.kind).length >= RADAR_PER_KIND) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}
