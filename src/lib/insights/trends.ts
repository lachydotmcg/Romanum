import { z } from "zod";
import { historyDatabase, type Database } from "../history/database.ts";
import { INTERVAL_SECONDS } from "../history/constants.ts";
import { analyzeMarket, matchingPatterns, type SampleGame } from "../market-analysis.ts";
import { MARKET_CHARTS } from "../public-data.ts";

const PERIOD = INTERVAL_SECONDS * 1000;
const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.object({
  universeId: id, rootPlaceId: id, rank: id,
  name: z.string().min(1).max(500), genre: z.string().max(500).nullable(),
  playing: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sponsored: z.literal(false),
});

export const TREND_INPUT = z.object({ days: z.number().int().min(1).max(7).default(1) }).strict();
/** A fixed query bound and a recording-completeness rule, not a market benchmark. */
export const TREND_METHOD = Object.freeze({
  gamesPerChart: 10,
  baselineOffsetDays: 7,
  intervalSeconds: INTERVAL_SECONDS,
  comparisonRequires: "Every requested slot has all four complete chart fetches in both windows, with an unchanged common cohort, measurement chart and classification.",
});

export type RecordedChart = {
  slot: Date | string; chart_id: string | null; observed_at: Date | string | null;
  status: string | null; rejected: number | null; entries: unknown;
};
type Window = { from: string; to: string };
type Snapshot = {
  slot: number; games: SampleGame[]; complete: boolean;
  observations: { chart: typeof MARKET_CHARTS[number]; fetchedAt: string; sampledGames: number }[];
};
const time = (value: Date | string | null) => value === null ? NaN : new Date(value).getTime();
const mean = (values: number[]) => values.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return !ordered.length ? null : ordered.length % 2 ? ordered[middle] : ordered[middle - 1] / 2 + ordered[middle] / 2;
};
const signature = (game: SampleGame) => JSON.stringify([game.genre, matchingPatterns(game.name)]);

function readWindow(rows: RecordedChart[], window: Window) {
  const from = Date.parse(window.from), to = Date.parse(window.to);
  const bySlot = new Map<number, RecordedChart[]>();
  let ignoredRows = 0;
  for (const row of rows) {
    const slot = time(row.slot);
    if (!Number.isFinite(slot) || slot % PERIOD !== 0 || slot < from || slot >= to) { ignoredRows++; continue; }
    const records = bySlot.get(slot) ?? [];
    records.push(row); bySlot.set(slot, records);
  }
  const charts = MARKET_CHARTS.map(chart => ({ chart, complete: 0, empty: 0, partial: 0, failed: 0, missing: 0, invalid: 0 }));
  const snapshots = new Map<number, Snapshot>();
  for (let slot = from; slot < to; slot += PERIOD) {
    const records = bySlot.get(slot) ?? [];
    const samples = [];
    const observations: Snapshot["observations"] = [];
    for (const coverage of charts) {
      const matches = records.filter(row => row.chart_id === coverage.chart);
      if (!matches.length) { coverage.missing++; continue; }
      if (matches.length !== 1) { coverage.invalid++; continue; }
      const row = matches[0];
      if (row.status === "failed") { coverage.failed++; continue; }
      if (row.status === "partial" || (row.rejected ?? 0) > 0) { coverage.partial++; continue; }
      const observed = time(row.observed_at);
      const parsed = z.array(entrySchema).max(TREND_METHOD.gamesPerChart).safeParse(row.entries);
      if (row.status !== "complete" || !Number.isFinite(observed) || observed < slot || observed >= slot + PERIOD ||
          !parsed.success || new Set(parsed.data.map(game => game.universeId)).size !== parsed.data.length ||
          new Set(parsed.data.map(game => game.rank)).size !== parsed.data.length) {
        coverage.invalid++; continue;
      }
      coverage.complete++;
      if (!parsed.data.length) coverage.empty++;
      observations.push({ chart: coverage.chart, fetchedAt: iso(observed), sampledGames: parsed.data.length });
      samples.push({ chart: coverage.chart, games: parsed.data.map(game => ({ ...game, likes: 0, dislikes: 0 })) });
    }
    if (observations.length) {
      snapshots.set(slot, {
        slot, games: analyzeMarket(samples, iso(slot)).games,
        complete: observations.length === MARKET_CHARTS.length, observations,
      });
    }
  }
  const values = [...snapshots.values()];
  const observedTimes = values.flatMap(snapshot => snapshot.observations.map(item => Date.parse(item.fetchedAt)));
  const expectedSlots = (to - from) / PERIOD;
  return {
    snapshots,
    coverage: {
      ...window, expectedSlots, recordedSlots: snapshots.size,
      completeSlots: values.filter(snapshot => snapshot.complete).length,
      completeFraction: values.filter(snapshot => snapshot.complete).length / expectedSlots,
      charts, ignoredRows,
      observedSpan: observedTimes.length ? { from: iso(Math.min(...observedTimes)), to: iso(Math.max(...observedTimes)) } : null,
    },
  };
}

function groupSignals(games: SampleGame[]) {
  const analysis = analyzeMarket([{ chart: "top-playing-now", games }]);
  // Reuse the taxonomy, but not discovery-presence counts from this synthetic grouping input.
  const genres = analysis.genres.map(genre => ({ kind: "genre" as const, key: genre.name, label: genre.name,
    members: games.filter(game => (game.genre || "Unlisted") === genre.name) }));
  const patterns = analysis.patterns.filter(pattern => pattern.gameCount > 0).map(pattern => ({
    kind: "title_pattern" as const, key: pattern.id, label: pattern.label, members: pattern.games,
  }));
  return [...genres, ...patterns].map(({ members, ...group }) => {
    const players = members.reduce((total, game) => total + game.playing, 0);
    return {
      ...group, universeIds: members.map(game => game.universeId),
      activity: { observedPlayers: players, medianPlayersPerGame: median(members.map(game => game.playing)),
        shareOfSamplePlayers: analysis.samplePlayers > 0 ? players / analysis.samplePlayers : null },
      competition: { sampledGames: members.length, shareOfSampleGames: members.length / games.length },
      concentration: { largestGameShare: players > 0 ? Math.max(...members.map(game => game.playing)) / players : null },
      representatives: members.slice(0, 3).map(({ universeId, rootPlaceId, name }) => ({ universeId, rootPlaceId, name })),
    };
  });
}

/** Public recorded chart rows only. Missing fetches never become zero-player observations. */
export function analyzeRecordedTrends(rows: RecordedChart[], input: unknown = {}, now = Date.now(), available = true) {
  const { days } = TREND_INPUT.parse(input);
  if (!Number.isFinite(now)) throw new Error("Invalid trend cutoff.");
  // Exclude the still-open collection slot, and align a week apart to preserve UTC weekday/time-of-day.
  const end = Math.floor(now / PERIOD) * PERIOD;
  const recentWindow = { from: iso(end - days * DAY), to: iso(end) };
  const baselineWindow = { from: iso(end - (days + 7) * DAY), to: iso(end - 7 * DAY) };
  const recent = readWindow(rows.filter(row => time(row.slot) >= Date.parse(recentWindow.from)), recentWindow);
  const baseline = readWindow(rows.filter(row => time(row.slot) < Date.parse(recentWindow.from)), baselineWindow);
  const pairs = [...recent.snapshots.values()].flatMap(snapshot => {
    const before = baseline.snapshots.get(snapshot.slot - 7 * DAY);
    return snapshot.complete && before?.complete ? [{ recent: snapshot, baseline: before }] : [];
  }).sort((a, b) => a.recent.slot - b.recent.slot);
  const latest = [...recent.snapshots.values()].sort((a, b) => b.slot - a.slot)[0];
  const snapshots = pairs.flatMap(pair => [pair.recent, pair.baseline]);
  const first = snapshots[0];
  const common = first?.games.filter(game => snapshots.every(snapshot => snapshot.games.some(member => member.universeId === game.universeId))) ?? [];
  // A game switching its preferred chart can switch retrieval timing/source; keep that separate from player change.
  const sameSource = common.filter(game => snapshots.every(snapshot => snapshot.games.find(member => member.universeId === game.universeId)!.charts[0] === game.charts[0]));
  const stable = sameSource.filter(game => snapshots.every(snapshot => signature(snapshot.games.find(member => member.universeId === game.universeId)!) === signature(game)));
  const stableIds = new Set(stable.map(game => game.universeId));
  const allIds = new Set(snapshots.flatMap(snapshot => snapshot.games.map(game => game.universeId)));
  const reasons = [];
  if (!available) reasons.push("storage_unavailable");
  if (pairs.length !== recent.coverage.expectedSlots) reasons.push("incomplete_windows");
  if (!stable.length) reasons.push("no_stable_common_cohort");
  const comparable = !reasons.length;
  const groups = latest ? groupSignals(latest.games) : [];
  const sum = (snapshot: Snapshot, ids: Set<number>) => snapshot.games.filter(game => ids.has(game.universeId)).reduce((total, game) => total + game.playing, 0);
  const comparison = comparable ? groups.flatMap(group => {
    const ids = new Set(group.universeIds.filter(id => stableIds.has(id)));
    if (!ids.size) return [];
    const recentMean = mean(pairs.map(pair => sum(pair.recent, ids)));
    const baselineMean = mean(pairs.map(pair => sum(pair.baseline, ids)));
    return [{ kind: group.kind, key: group.key, label: group.label, cohortUniverseIds: [...ids],
      recentMeanPlayers: recentMean, baselineMeanPlayers: baselineMean,
      differencePlayers: recentMean - baselineMean,
      relativeChange: baselineMean > 0 ? (recentMean - baselineMean) / baselineMean : null,
    }];
  }) : null;
  const latestAt = latest?.observations.map(item => item.fetchedAt).sort().at(-1) ?? null;
  return {
    available, assembledAt: iso(now), source: "https://www.roblox.com/charts", method: TREND_METHOD,
    status: comparable ? "compared" as const : "insufficient_data" as const, reasons,
    windows: { recent: recent.coverage, baseline: baseline.coverage },
    freshness: { latestObservedAt: latestAt, ageSeconds: latestAt ? (now - Date.parse(latestAt)) / 1000 : null,
      latestCompletedSlotRecorded: latest?.slot === end - PERIOD && latest.complete },
    sample: latest ? { slot: iso(latest.slot), complete: latest.complete, observations: latest.observations,
      games: latest.games.length, observedPlayers: latest.games.reduce((total, game) => total + game.playing, 0), groups } : null,
    comparison: { pairedSlots: pairs.length, fractionOfRequestedSlots: pairs.length / recent.coverage.expectedSlots,
      commonGames: common.length, stableGames: stable.length,
      excludedForMembershipChange: allIds.size - common.length, excludedForSourceChange: common.length - sameSource.length,
      excludedForClassificationChange: sameSource.length - stable.length,
      groups: comparison },
    demand: { status: "unmeasured" as const, explanation: "Player counts show activity in this chart sample; unmet demand and causes are unknown." },
    saturation: { status: "unmeasured" as const, explanation: "Sampled games and player concentration do not measure market saturation." },
    summary: comparable ? "Recorded chart activity can be compared for the same sampled games a week apart."
      : "Chart history does not support a like-for-like comparison; no trend conclusion yet.",
    limitations: [
      "At most ten non-sponsored games per chart; deduplicated by universe with Top Playing Now counts preferred. This is a discovery sample, not all Roblox games.",
      "Comparisons require complete matching slots and use only games present throughout both windows with unchanged measurement chart, recorded genre and title-pattern matches. Other games are excluded, not counted as zero.",
      "Genres and title patterns are separate; patterns overlap and do not verify gameplay. No significance, opportunity score, market benchmark or causal claim is inferred.",
      "No social or TikTok activity, private retention, earnings or conversion evidence is present. Inspect representative games and playtest a differentiated loop before choosing an idea.",
    ],
  };
}

export type MarketTrendEvidence = ReturnType<typeof analyzeRecordedTrends>;

/** One bounded SELECT over already-recorded public chart entries. No collection or model calls. */
export function createMarketTrendService(getDatabase: () => Promise<Database | null> = historyDatabase, now = Date.now) {
  const cached = new WeakMap<Database, { key: string; result: Promise<MarketTrendEvidence> }>();
  return {
    async analyze(input: unknown = {}) {
      const parsed = TREND_INPUT.parse(input), cutoff = now();
      const empty = analyzeRecordedTrends([], parsed, cutoff, false);
      const database = await getDatabase();
      if (!database) return empty;
      const end = Math.floor(cutoff / PERIOD) * PERIOD;
      const key = `${parsed.days}:${end}`;
      const prior = cached.get(database);
      if (prior?.key === key) return prior.result;
      const result = (async () => {
        const { rows } = await database.query<RecordedChart>(`SELECT r.slot,f.chart_id,f.observed_at,f.status,f.rejected,
          COALESCE(e.entries,'[]'::jsonb) AS entries FROM history_runs r
          LEFT JOIN history_chart_fetches f ON f.run_id=r.id AND f.chart_id=ANY($5::text[])
          LEFT JOIN LATERAL (SELECT jsonb_agg(x.entry ORDER BY x.rank,x.universe_id) AS entries FROM (
            SELECT c.rank,c.universe_id,jsonb_build_object('universeId',c.universe_id,'rootPlaceId',g.root_place_id,
              'rank',c.rank,'name',c.name,'genre',c.genre,'playing',c.playing,'sponsored',c.sponsored) AS entry
            FROM history_chart_entries c JOIN history_games g ON g.universe_id=c.universe_id
            WHERE c.run_id=f.run_id AND c.chart_id=f.chart_id AND NOT c.sponsored
            ORDER BY c.rank,c.universe_id LIMIT $6
          ) x) e ON true
          WHERE ((r.slot >= $1 AND r.slot < $2) OR (r.slot >= $3 AND r.slot < $4))
            AND r.status <> 'running' AND r.finished_at IS NOT NULL
          ORDER BY r.slot,f.chart_id LIMIT $7`, [
          empty.windows.baseline.from, empty.windows.baseline.to, empty.windows.recent.from, empty.windows.recent.to,
          [...MARKET_CHARTS], TREND_METHOD.gamesPerChart,
          2 * empty.windows.recent.expectedSlots * MARKET_CHARTS.length + 1,
        ]);
        return analyzeRecordedTrends(rows, parsed, cutoff);
      })();
      cached.set(database, { key, result });
      try { return await result; }
      catch (error) { if (cached.get(database)?.result === result) cached.delete(database); throw error; }
    },
  };
}

export const marketTrendService = createMarketTrendService();
