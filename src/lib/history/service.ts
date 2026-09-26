import { z } from "zod";
import { historyDatabase, type Database } from "./database.ts";
import { INTERVAL_SECONDS, HISTORY_SOURCE } from "./constants.ts";

export const HISTORY_INPUT = z.object({
  universeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  days: z.number().int().min(1).max(30).default(1),
}).strict();

type StoredGame = { universe_id: string; root_place_id: string; name: string; icon_url: string | null };
const gameResult = (game: StoredGame) => ({ universeId: Number(game.universe_id), rootPlaceId: Number(game.root_place_id), name: game.name, iconUrl: game.icon_url });
const iso = (value: Date | string) => new Date(value).toISOString();
const nullableNumber = (value: string | number | null) => value === null ? null : Number(value);
type Row = {
  slot: Date | string; run_status: string; observed_at: Date | string | null;
  playing: string | null; visits: string | null; favorites: string | null; likes: string | null; dislikes: string | null;
  target_status: string | null; chart_ranks: Record<string, number> | null;
};

export function createHistoryService(getDatabase: () => Promise<Database | null> = historyDatabase, now = Date.now) {
  return {
    async games() {
      const database = await getDatabase();
      if (!database) return { available: false, games: [] };
      const { rows } = await database.query<StoredGame>(`SELECT g.* FROM history_games g
        JOIN LATERAL (SELECT playing FROM history_observations WHERE universe_id=g.universe_id ORDER BY observed_at DESC LIMIT 1) o ON true
        ORDER BY o.playing DESC,g.universe_id LIMIT 100`);
      return { available: true, games: rows.map(gameResult) };
    },
    async history(input: unknown) {
      const { universeId, days } = HISTORY_INPUT.parse(input);
      const end = now();
      const from = new Date(end - days * 86_400_000).toISOString();
      const to = new Date(end).toISOString();
      const base = { universeId, from, to, intervalSeconds: INTERVAL_SECONDS, source: HISTORY_SOURCE, truncated: false };
      const database = await getDatabase();
      if (!database) return { ...base, available: false, game: null, points: [], sampleCount: 0, gaps: 0 };
      const { rows: games } = await database.query<StoredGame>("SELECT * FROM history_games WHERE universe_id=$1", [universeId]);
      const game = games[0] ? gameResult(games[0]) : null;
      if (!game) return { ...base, available: true, game, points: [], sampleCount: 0, gaps: 0 };

      const period = INTERVAL_SECONDS * 1000;
      const firstRequestedSlot = Math.floor(Date.parse(from) / period) * period;
      const { rows } = await database.query<Row>(`SELECT r.slot,r.status AS run_status,o.observed_at,o.playing,o.visits,o.favorites,o.likes,o.dislikes,t.status AS target_status,
        (SELECT jsonb_object_agg(e.chart_id,e.rank) FROM history_chart_entries e WHERE e.run_id=r.id AND e.universe_id=$1 AND NOT e.sponsored) AS chart_ranks
        FROM history_runs r
        LEFT JOIN history_targets t ON t.run_id=r.id AND t.universe_id=$1
        LEFT JOIN history_observations o ON o.run_id=r.id AND o.universe_id=$1 AND o.observed_at >= $2 AND o.observed_at <= $3
        WHERE r.slot >= $4 AND r.slot <= $3 ORDER BY r.slot LIMIT 8642`, [universeId, from, to, new Date(firstRequestedSlot).toISOString()]);
      const { rows: beginnings } = await database.query<{ first: Date | string | null }>("SELECT min(slot) AS first FROM history_runs");
      if (!beginnings[0].first) return { ...base, available: true, game, points: [], sampleCount: 0, gaps: 0 };
      const bySlot = new Map(rows.map((row) => [new Date(row.slot).getTime(), row]));
      const first = Math.max(firstRequestedSlot, new Date(beginnings[0].first).getTime());
      let last = Math.floor(end / period) * period;
      // Do not label the current, still-open collection window as a missed run.
      if (!bySlot.has(last)) last -= period;
      const points = [];
      for (let time = first; time <= last; time += period) {
        const row = bySlot.get(time);
        const observed = row?.observed_at != null;
        const timestamp = observed ? iso(row.observed_at!) : new Date(time).toISOString();
        if (timestamp < from) continue;
        const status = observed ? "observed" : !row ? "missed" : row.target_status || row.run_status === "failed" || row.run_status === "running" ? "unavailable" : "not_sampled";
        points.push({
          observedAt: timestamp, status,
          playing: observed ? nullableNumber(row.playing) : null,
          visits: observed ? nullableNumber(row.visits) : null,
          favorites: observed ? nullableNumber(row.favorites) : null,
          likes: observed ? nullableNumber(row.likes) : null,
          dislikes: observed ? nullableNumber(row.dislikes) : null,
          chartRanks: row?.chart_ranks ?? {},
        });
      }
      const sampleCount = points.filter((point) => point.status === "observed").length;
      return { ...base, available: true, game, points, sampleCount, gaps: points.length - sampleCount };
    },
  };
}

export const historyService = createHistoryService();
