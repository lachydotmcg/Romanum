import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket, matchingPatterns } from "../src/lib/market-analysis.ts";

const game = (id, name, playing, extra = {}) => ({ universeId: id, rootPlaceId: id * 10, rank: 1, name, playing, likes: 9, dislikes: 1, genre: "Simulation", sponsored: false, ...extra });
const find = (data, id) => data.patterns.find((pattern) => pattern.id === id);

test("recognizes overlapping patterns without confusing +10 or update tags with +1", () => {
  assert.deepEqual(matchingPatterns("[UPDATE] Jump To Steal An Egg"), ["steal-a", "pets-eggs"]);
  assert.deepEqual(matchingPatterns("＋１ Speed Escape"), ["plus-one", "escape-obby"]);
  assert.deepEqual(matchingPatterns("[+1 LUCK] +10 Speed Race"), []);
  assert.deepEqual(matchingPatterns("Stealth Arena"), []);
});

test("counts each universe once and prefers the Top Playing Now observation", () => {
  const result = analyzeMarket([
    { chart: "top-trending", games: [game(1, "Steal a Pet", 999)] },
    { chart: "top-playing-now", games: [game(1, "Steal a Pet", 100), game(2, "Steal an Egg", 20)] },
    { chart: "up-and-coming", games: [game(2, "Steal an Egg", 30)] },
  ]);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.samplePlayers, 120);
  assert.equal(find(result, "steal-a").players, 120);
  assert.equal(find(result, "steal-a").medianPlayers, 60);
  assert.equal(find(result, "steal-a").leaderShare, 100 / 120);
  assert.equal(find(result, "steal-a").trendingCount, 1);
  assert.equal(find(result, "steal-a").risingCount, 1);
  assert.equal(find(result, "pets-eggs").players, 120);
});

test("excludes paid placements and invalid counts from both pattern and genre totals", () => {
  const result = analyzeMarket([{ chart: "top-playing-now", games: [
    game(1, "+1 Speed", 10), game(2, "+1 Speed", 500, { sponsored: true }),
    game(3, "+1 Speed", -50), game(4, "+1 Speed", NaN), game(-1, "+1 Speed", 40),
  ] }]);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.samplePlayers, 10);
  assert.equal(result.genres[0].share, 1);
});

test("reports missing charts separately from successfully loaded empty charts", () => {
  const result = analyzeMarket([{ chart: "top-trending", games: null }, { chart: "top-playing-now", games: [] }]);
  assert.deepEqual(result.unavailableCharts, ["top-trending"]);
  assert.deepEqual(result.availableCharts, ["top-playing-now"]);
  assert.equal(result.sampleSize, 0);
  assert.ok(result.patterns.every((pattern) => pattern.players === 0 && pattern.leaderShare === null));
});

test("preserves zero-player games without inventing a concentration percentage", () => {
  const result = analyzeMarket([{ chart: "top-playing-now", games: [game(1, "+1 Escape", 0)] }]);
  assert.equal(find(result, "plus-one").gameCount, 1);
  assert.equal(find(result, "plus-one").leaderShare, null);
  assert.equal(result.genres[0].share, 0);
});

test("calculates odd medians, disjoint genre shares, and does not mutate the inputs", () => {
  const input = [game(1, "+1 Speed", 90), game(2, "+1 Wings", 10, { genre: "Adventure" }), game(3, "+1 Jump", 20, { genre: null })];
  const before = structuredClone(input);
  const result = analyzeMarket([{ chart: "top-playing-now", games: input }], "2026-09-26T10:00:00.000Z");
  assert.deepEqual(input, before);
  assert.equal(find(result, "plus-one").medianPlayers, 20);
  assert.equal(result.genres.reduce((total, genre) => total + genre.players, 0), 120);
  assert.equal(result.genres.reduce((total, genre) => total + genre.share, 0), 1);
  assert.equal(result.assembledAt, "2026-09-26T10:00:00.000Z");
});
