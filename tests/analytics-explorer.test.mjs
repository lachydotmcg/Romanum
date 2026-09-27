import test from "node:test";
import assert from "node:assert/strict";
import { mergeGameDetails, filterGames, explorerChart, chartPrompt } from "../src/lib/analytics/explorer.ts";
import { estimateEarnings } from "../src/lib/analytics/earnings.ts";

const sample = (id, extra = {}) => ({ universeId: id, rootPlaceId: id * 10, name: `Game ${id}`, rank: id, playing: id * 10, likes: 9, dislikes: 1, genre: "Simulation", sponsored: false, charts: ["top-playing-now"], ...extra });
const options = { query: "", genre: "", chart: "", sort: "playing", ascending: false };

test("directory preserves chart observations and leaves failed metadata empty", () => {
  const result = mergeGameDetails([sample(1), sample(2)], [{ universeId: 1, playing: 500, creator: { name: "Creator" }, visits: 0, favorites: 20, likeRatio: null, created: "2026-09-01T00:00:00Z" }]);
  assert.equal(result[0].playing, 10);
  assert.equal(result[0].visits, 0);
  assert.equal(result[0].likeRatio, null);
  assert.equal(result[1].visits, null);
  assert.equal(result[1].creatorName, null);
  assert.equal(result[1].likeRatio, 0.9);
});

test("filters combine genre, title/creator and chart, without changing the source order", () => {
  const rows = mergeGameDetails([sample(1), sample(2, { genre: "Action" }), sample(3, { charts: ["up-and-coming"] })], []);
  rows[2].creatorName = "Example Studio";
  assert.deepEqual(filterGames(rows, { ...options, query: " studio ", genre: "Simulation", chart: "up-and-coming" }).map((row) => row.universeId), [3]);
  assert.deepEqual(rows.map((row) => row.universeId), [1, 2, 3]);
  assert.equal(filterGames(rows, { ...options, genre: "Unknown" }).length, 0);
});

test("zero observations sort normally and unknown values stay last in either direction", () => {
  const rows = mergeGameDetails([sample(1), sample(2), sample(3)], []);
  rows[1].visits = 0; rows[2].visits = 20;
  for (const ascending of [false, true]) {
    const sorted = filterGames(rows, { ...options, sort: "visits", ascending });
    assert.equal(sorted.at(-1).universeId, 1);
    assert.equal(sorted[0].universeId, ascending ? 2 : 3);
  }
  rows[0].created = "invalid"; rows[1].created = "2026-01-01"; rows[2].created = "2026-02-01";
  assert.deepEqual(filterGames(rows, { ...options, sort: "created" }).map((row) => row.universeId), [3, 2, 1]);
});

test("manual charts preserve unknown values, bound rows and never use ratings as shares", () => {
  const rows = mergeGameDetails(Array.from({ length: 20 }, (_, i) => sample(i + 1)), []);
  const bars = explorerChart(rows, "visits", "bar");
  assert.equal(bars.categories.length, 12);
  assert.ok(bars.series[0].values.every((value) => value === null));
  const donut = explorerChart(rows, "playing", "donut");
  assert.equal(donut.categories.length, 6);
  assert.equal(donut.colorBy, "category");
  assert.equal(new Set(Object.values(donut.colors)).size, 6);
  assert.equal(explorerChart(rows, "likeRatio", "donut").kind, "bar");
  assert.match(chartPrompt(rows, "favorites"), /favourites/);
  assert.ok(!chartPrompt(rows, "playing").includes("Game 1"), "prompt passes IDs, not untrusted game titles");
});

const scenario = { averageCcu: 100, days: 30, lowRobuxPerPlayerHour: 1, highRobuxPerPlayerHour: 2 };
test("earnings uses average player-hours and net Robux, then standard DevEx once", () => {
  const result = estimateEarnings(scenario);
  assert.equal(result.playerHours, 72_000);
  assert.deepEqual(result.robux, { low: 72_000, high: 144_000 });
  assert.deepEqual(result.usd, { low: 273.6, high: 547.2 });
  assert.equal(estimateEarnings({ ...scenario, averageCcu: 0 }).robux.high, 0);
  assert.equal(estimateEarnings({ ...scenario, days: 1 }).robux.low, 2400);
});

test("only the explicitly eligible share receives the US18+ DevEx rate", () => {
  assert.equal(estimateEarnings({ ...scenario, eligibleUs18Percent: 100 }).devExRate, 0.0054);
  assert.ok(Math.abs(estimateEarnings({ ...scenario, eligibleUs18Percent: 25 }).devExRate - 0.0042) < 1e-12);
});

test("earnings rejects missing, reversed, nonfinite and out-of-range assumptions", () => {
  for (const override of [{ averageCcu: -1 }, { averageCcu: Infinity }, { averageCcu: "100" }, { days: 0 }, { days: 1.5 }, { lowRobuxPerPlayerHour: 3 }, { highRobuxPerPlayerHour: undefined }, { eligibleUs18Percent: 101 }]) {
    assert.throws(() => estimateEarnings({ ...scenario, ...override }));
  }
});
