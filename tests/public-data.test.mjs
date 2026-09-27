import test from "node:test";
import assert from "node:assert/strict";
import { DataCache } from "../src/lib/data-cache.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { parsePlaceId, runPublicTool } from "../src/lib/public-tools.ts";

test("cache shares in-flight work and preserves observation time until expiry", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new DataCache(2, () => now);
  const fetcher = async () => ++calls;
  const [first, concurrent] = await Promise.all([cache.get("a", 60, fetcher), cache.get("a", 60, fetcher)]);
  assert.deepEqual(first, concurrent);
  assert.equal(calls, 1);
  now = 60_000;
  assert.deepEqual(await cache.get("a", 60, fetcher), first);
  now = 61_000;
  const next = await cache.get("a", 60, fetcher);
  assert.equal(next.value, 2);
  assert.equal(next.fetchedAt, new Date(now).toISOString());
});

test("cache retries failures and bounds retained observations", async () => {
  const cache = new DataCache(2);
  await assert.rejects(cache.get("a", 60, () => { throw new Error("upstream"); }));
  assert.equal((await cache.get("a", 60, async () => 1)).value, 1);
  await cache.get("b", 60, async () => 2);
  await cache.get("c", 60, async () => 3);
  assert.equal((await cache.get("a", 60, async () => 4)).value, 4);
});

test("stats canonicalize IDs, share cached data and identify missing universes", async () => {
  const received = [];
  const service = createPublicDataService({
    getGameStats: async (ids) => { received.push(ids); return [{ universeId: 1 }]; },
  });
  const first = await service.stats([2, 1, 1]);
  assert.deepEqual(await service.stats([1, 2]), first);
  assert.deepEqual(received, [[1, 2]]);
  assert.deepEqual(first.missingUniverseIds, [2]);
});

test("market reuses chart observations and separates failed from empty charts", async () => {
  let now = 1_000;
  const calls = [];
  const service = createPublicDataService({
    getRobloxChart: async (chart) => {
      calls.push(chart);
      if (chart === "top-trending") throw new Error("unavailable");
      return [];
    },
  }, new DataCache(20, () => now));
  const first = await service.chart("top-playing-now");
  now = 10_000;
  const { result } = await runPublicTool("get_market_analysis", {}, service);
  assert.equal(calls.filter((chart) => chart === "top-playing-now").length, 1);
  assert.equal(result.fetchedAt, first.fetchedAt);
  assert.equal(result.assembledAt !== result.fetchedAt, true);
  assert.deepEqual(result.unavailableCharts, ["top-trending"]);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.observations.length, 3);
  assert.equal("growth" in result, false);
});

test("invalid tool input cannot trigger upstream requests", async () => {
  const service = new Proxy({}, { get() { assert.fail("invalid input reached data service"); } });
  for (const [name, args] of [
    ["search_games", { query: "   " }],
    ["search_games", { query: "x", url: "http://localhost" }],
    ["get_game_stats", { universeIds: ["123"] }],
    ["get_game_stats", { universeIds: Array(11).fill(1) }],
    ["estimate_game_earnings", { universeIds: [1], days: 0 }],
    ["estimate_game_earnings", { universeIds: [1], days: 367 }],
    ["estimate_game_earnings", { universeIds: Array(11).fill(1) }],
    ["estimate_game_earnings", { universeIds: [1], rate: 99 }],
    ["get_roblox_charts", { chart: "top-playing-now", limit: 51 }],
    ["resolve_game_link", { link: "https://roblox.com.evil.example/games/1" }],
    ["load_skill", { skill: "../../.env.local" }],
  ]) await assert.rejects(runPublicTool(name, args, service));
});

test("place resolver accepts Roblox links without fetching user-provided URLs", () => {
  assert.equal(parsePlaceId("123"), 123);
  assert.equal(parsePlaceId("www.roblox.com/games/123/A-Game?foo=bar"), 123);
  assert.equal(parsePlaceId("https://www.roblox.com/en-us/games/123"), 123);
  for (const link of ["0", "9007199254740992", "https://roblox.com@evil.example/games/1", "https://evil@roblox.com/games/1", "http://127.0.0.1/games/1", "file:///etc/passwd", "https://roblox.com/games/nope"]) {
    assert.throws(() => parsePlaceId(link));
  }
});

test("earnings tool shares cached public observations without changing raw statistics", async () => {
  let calls = 0;
  const service = createPublicDataService({ getGameStats: async () => { calls++; return [{ universeId: 1, name: "Fixture", playing: 100, genre: "Action" }]; } });
  const observation = await service.stats([1, 2]);
  const { result } = await runPublicTool("estimate_game_earnings", { universeIds: [2, 1], days: 7 }, service);
  assert.equal(calls, 1);
  assert.equal(result.fetchedAt, observation.fetchedAt);
  assert.deepEqual(result.missingUniverseIds, [2]);
  assert.equal(result.games[0].estimatedRobuxLow, 33600);
  assert.equal(result.games[0].estimatedRobuxHigh, 67200);
  assert.equal(result.kind, "estimate");
  assert.match(result.assumptions, /uncalibrated/);
  assert.equal("estimatedEarnings" in observation.games[0], false);
});
