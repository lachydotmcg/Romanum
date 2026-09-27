import test from "node:test";
import assert from "node:assert/strict";
import { mergeGameDetails, filterGames, explorerChart, chartPrompt } from "../src/lib/analytics/explorer.ts";
import { estimateEarnings, currentEarnings, sumEarnings } from "../src/lib/analytics/earnings.ts";

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

const scenario = { ccu: 100, days: 30, genre: "Action", basis: "average" };
test("earnings automatically models net Robux from CCU, period and genre", () => {
  const result = estimateEarnings(scenario);
  assert.equal(result.playerHours, 72_000);
  assert.deepEqual(result.robux, { low: 144_000, high: 288_000 });
  assert.deepEqual(result.usd, { low: 547.2, high: 1094.4 });
  assert.equal(result.basis, "average");
  assert.equal(result.kind, "estimate");
  assert.equal(estimateEarnings({ ...scenario, ccu: 0 }).robux.high, 0);
  assert.equal(estimateEarnings({ ...scenario, days: 1 }).robux.low, 4800);
});

test("primary genre is normalized and unknown genres use the full assumption envelope", () => {
  assert.deepEqual(estimateEarnings({ ...scenario, genre: " action / Battlegrounds " }).robux, estimateEarnings(scenario).robux);
  for (const genre of [null, undefined, "Unknown"]) {
    const result = estimateEarnings({ ...scenario, genre });
    assert.equal(result.genre, "General");
    assert.equal(result.devExRate, 0.0038);
    assert.ok(result.robux.low < estimateEarnings(scenario).robux.low);
    assert.ok(result.robux.high > estimateEarnings(scenario).robux.high);
  }
  assert.equal(currentEarnings({ playing: 100, genre: "Simulation" }).basis, "current");
  assert.equal(currentEarnings({ playing: NaN }), null);
  assert.deepEqual(sumEarnings([{ playing: 100, genre: "Action" }, { playing: 100, genre: "Simulation" }], 1), { low: 12240, high: 24000 });
});

test("earnings rejects missing, nonfinite and out-of-range inputs and rate overrides", () => {
  for (const override of [{ ccu: undefined }, { ccu: -1 }, { ccu: Infinity }, { ccu: "100" }, { days: 0 }, { days: 1.5 }, { days: 367 }, { lowRobuxPerPlayerHour: 3 }, { eligibleUs18Percent: 100 }]) {
    assert.throws(() => estimateEarnings({ ...scenario, ...override }));
  }
});

test("estimated earnings can sort games and chart both bounds in Robux or USD", () => {
  const rows = mergeGameDetails([sample(1, { playing: 100, genre: "Simulation" }), sample(2, { playing: 110, genre: "Education" })], []);
  assert.equal(filterGames(rows, { ...options, sort: "estimatedRobux" })[0].universeId, 1);
  const chart = explorerChart(rows, "estimatedRobux", "donut", 7, "usd");
  assert.equal(chart.kind, "bar");
  assert.match(chart.title, /Estimated.*7 days/);
  assert.equal(chart.series.length, 2);
  assert.equal(chart.series[0].format, "usd");
  assert.equal(chart.series[0].values[0], estimateEarnings({ ccu: 100, genre: "Simulation", days: 7 }).usd.low);
  assert.match(chartPrompt(rows, "estimatedRobux", 7), /7-day Robux.*both low and high/);
});
