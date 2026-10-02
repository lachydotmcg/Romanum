import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { z } from "zod";
import { createPublicHttpHandler } from "../src/lib/public-http.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { runPublicTool } from "../src/lib/public-tools.ts";
import { DataCache } from "../src/lib/data-cache.ts";

const AT = "2026-10-02T12:00:00.000Z";
const game = (universeId, extra = {}) => ({
  universeId, rootPlaceId: universeId * 10, rank: universeId, name: `Grow a Fixture ${universeId}`,
  playing: universeId * 10, genre: "Simulation", likes: 12, dislikes: 3, sponsored: false, iconUrl: null, ...extra,
});
const request = (endpoint, query = "", method = "GET") => new Request(`https://romanum.example/api/public/${endpoint}${query ? `?${query}` : ""}`, { method });

function fixture(overrides = {}, now = () => Date.parse(AT)) {
  const calls = { stats: [], charts: [] };
  const service = createPublicDataService({
    getGameStats: async ids => { calls.stats.push(ids); return ids.filter(id => id !== 9).map(id => game(id, { visits: null, favorites: 0 })); },
    getRobloxChart: async chart => { calls.charts.push(chart); return [game(2), game(1, { sponsored: true }), game(3)]; },
    searchGames: async () => assert.fail("public HTTP must not start searches"),
    universeIdForPlace: async () => assert.fail("public HTTP must not resolve arbitrary inputs"),
    ...overrides,
  }, new DataCache(200, now));
  service.history = async () => assert.fail("these routes must not access history or a database");
  const market = service.market;
  service.market = async () => {
    const result = await market();
    return { ...result, analysis: { ...result.analysis, assembledAt: AT } };
  };
  return { service, calls };
}

test("stats GET preserves the shared tool result, missing IDs, nulls and retrieval times", async () => {
  const { service, calls } = fixture();
  const response = await createPublicHttpHandler("stats", service)(request("stats", "universeIds=9,2,%201,2"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const result = await response.json();
  const expected = await runPublicTool("get_game_stats", { universeIds: [9, 2, 1, 2] }, service);
  assert.deepEqual(result, expected.result);
  assert.deepEqual(calls.stats, [[1, 2, 9]]);
  assert.deepEqual(result.missingUniverseIds, [9]);
  assert.equal(result.games[0].visits, null);
  assert.equal(result.games[0].favorites, 0);
  assert.equal(result.fetchedAt, AT);
  assert.equal(result.expiresAt, "2026-10-02T12:01:00.000Z");
  assert.equal(result.source, "https://games.roblox.com/v1/games");
});

test("charts GET preserves original ordering, sponsored labels and totalAvailable when limited", async () => {
  const { service, calls } = fixture();
  const response = await createPublicHttpHandler("charts", service)(request("charts", "chart=top-earning&limit=2"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, (await runPublicTool("get_roblox_charts", { chart: "top-earning", limit: 2 }, service)).result);
  assert.deepEqual(result.games.map(item => item.universeId), [2, 1]);
  assert.equal(result.games[1].sponsored, true);
  assert.equal(result.totalAvailable, 3);
  assert.equal(result.chart, "Top Earning");
  assert.equal(result.expiresAt, "2026-10-02T12:02:00.000Z");
  assert.deepEqual(calls.charts, ["top-earning"]);
  assert.equal("revenue" in result.games[0], false);
});

test("shared chart default and maximum, ten IDs and safe-integer boundary remain accepted", async () => {
  const { service } = fixture({ getRobloxChart: async () => Array.from({ length: 60 }, (_, i) => game(i + 1)) });
  const charts = createPublicHttpHandler("charts", service);
  assert.equal((await (await charts(request("charts", "chart=top-playing-now"))).json()).games.length, 20);
  assert.equal((await (await charts(request("charts", "chart=top-playing-now&limit=50"))).json()).games.length, 50);
  const stats = createPublicHttpHandler("stats", service);
  assert.equal((await stats(request("stats", `universeIds=${Array.from({ length: 10 }, (_, i) => i + 1).join(",")}`))).status, 200);
  assert.equal((await stats(request("stats", `universeIds=${Number.MAX_SAFE_INTEGER}`))).status, 200);
});

test("invalid, oversized and ambiguous query inputs are refused before any service read", async t => {
  const service = new Proxy({}, { get: () => assert.fail("invalid requests must not access a service") });
  const invalid = [
    ["stats", ""], ["stats", "universeIds="], ["stats", "universeIds=0"], ["stats", "universeIds=-1"],
    ["stats", "universeIds=1.5"], ["stats", "universeIds=1e2"], ["stats", "universeIds=0x10"],
    ["stats", "universeIds=9007199254740992"], ["stats", "universeIds=1,,2"], ["stats", "universeIds=1,"],
    ["stats", `universeIds=${Array(11).fill(1).join(",")}`], ["stats", "universeIds=1&universeIds=2"],
    ["stats", "universeIds=https://example.invalid"], ["stats", "universeIds=1&ownerId=2"],
    ["stats", `universeIds=${"1".repeat(2100)}`],
    ["charts", ""], ["charts", "chart="], ["charts", "chart=unknown"],
    ["charts", "chart=top-playing-now&limit=0"], ["charts", "chart=top-playing-now&limit=51"],
    ["charts", "chart=top-playing-now&limit="], ["charts", "chart=top-playing-now&limit=1.2"],
    ["charts", "chart=top-playing-now&limit=1&limit=2"], ["charts", "chart=top-playing-now&chart=top-earning"],
    ["market", "pattern="], ["market", "pattern=unknown"], ["market", "pattern=all&pattern=all"],
    ["market", "universeIds=1"], ["catalog", "ownerId=1"],
  ];
  for (const [endpoint, query] of invalid) {
    await t.test(`${endpoint}: ${query.slice(0, 100)}`, async () => {
      const response = await createPublicHttpHandler(endpoint, service)(request(endpoint, query));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Invalid query. Check /api/public/catalog for accepted parameters." });
    });
  }
});

test("market GET matches the shared tool while retaining partial coverage and deduplication", async () => {
  const { service } = fixture({
    getRobloxChart: async chart => {
      if (chart === "top-trending") throw new Error("fixture outage");
      return [game(1), game(1), game(2, { sponsored: true })];
    },
  });
  const response = await createPublicHttpHandler("market", service)(request("market"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, (await runPublicTool("get_market_analysis", {}, service)).result);
  assert.deepEqual(result.unavailableCharts, ["top-trending"]);
  assert.deepEqual(result.availableCharts, ["top-playing-now", "up-and-coming", "top-earning"]);
  assert.equal(result.observations.length, 3);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.samplePlayers, 10);
  assert.equal(result.fetchedAt, AT);
  assert.ok(result.observations.every(item => item.fetchedAt === AT));
  assert.match(result.limitations, /heuristic/);
  assert.ok(result.games.every(item => item.universeId === 1));
  const filtered = await (await createPublicHttpHandler("market", service)(request("market", "pattern=grow-a"))).json();
  assert.deepEqual(filtered.patterns.map(item => item.id), ["grow-a"]);
});

test("market response retains each chart's observation time across mixed-age cache hits", async () => {
  let now = Date.parse(AT);
  const { service } = fixture({}, () => now);
  await service.chart("top-playing-now");
  now += 30_000;
  const result = await (await createPublicHttpHandler("market", service)(request("market"))).json();
  assert.equal(result.fetchedAt, AT);
  assert.equal(result.expiresAt, "2026-10-02T12:02:00.000Z");
  assert.equal(result.observations.find(item => item.chart === "top-playing-now").fetchedAt, AT);
  assert.equal(result.observations.find(item => item.chart === "up-and-coming").fetchedAt, "2026-10-02T12:00:30.000Z");
});

test("all charts failing and other upstream errors return sanitized 503 responses", async () => {
  const failure = "fixture confidential upstream details";
  const { service } = fixture({
    getGameStats: async () => { throw new Error(failure); },
    getRobloxChart: async () => { throw new Error(failure); },
  });
  for (const [endpoint, query] of [["stats", "universeIds=1"], ["charts", "chart=top-playing-now"], ["market", ""]]) {
    const response = await createPublicHttpHandler(endpoint, service)(request(endpoint, query));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Couldn't retrieve public data. Try again." });
  }
  service.stats = async () => { throw new z.ZodError([]); };
  assert.equal((await createPublicHttpHandler("stats", service)(request("stats", "universeIds=1"))).status, 503, "an upstream schema failure is not a client input error");
});

test("successful empty responses preserve unknown coverage without inventing zero activity", async () => {
  const { service } = fixture({ getGameStats: async () => [], getRobloxChart: async () => [] });
  const stats = await (await createPublicHttpHandler("stats", service)(request("stats", "universeIds=1"))).json();
  assert.deepEqual(stats.games, []);
  assert.deepEqual(stats.missingUniverseIds, [1]);
  const market = await createPublicHttpHandler("market", service)(request("market"));
  assert.equal(market.status, 200, "empty successful charts differ from unavailable charts");
  const result = await market.json();
  assert.equal(result.sampleSize, 0);
  assert.equal(result.availableCharts.length, 4);
  assert.deepEqual(result.unavailableCharts, []);
});

test("HTTP cache hits reuse observations, expiry refreshes, and failed reads can retry", async () => {
  let now = Date.parse(AT);
  let fail = true;
  const { service, calls } = fixture({}, () => now);
  const handler = createPublicHttpHandler("stats", service);
  const first = await (await handler(request("stats", "universeIds=2,1"))).json();
  now += 30_000;
  const cached = await (await handler(request("stats", "universeIds=1,2"))).json();
  assert.deepEqual(cached, first);
  assert.equal(calls.stats.length, 1);
  now += 30_000;
  const refreshed = await (await handler(request("stats", "universeIds=1,2"))).json();
  assert.equal(calls.stats.length, 2);
  assert.equal(refreshed.fetchedAt, "2026-10-02T12:01:00.000Z");

  const retryService = fixture({ getGameStats: async () => {
    if (fail) { fail = false; throw new Error("fixture outage"); }
    return [game(1)];
  } }).service;
  const retry = createPublicHttpHandler("stats", retryService);
  assert.equal((await retry(request("stats", "universeIds=1"))).status, 503);
  assert.equal((await retry(request("stats", "universeIds=1"))).status, 200);
});

test("catalog is available without any service calls and identifies actual existing routes", async () => {
  const service = new Proxy({}, { get: () => assert.fail("catalog must not access data or providers") });
  const response = await createPublicHttpHandler("catalog", service)(request("catalog"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.access, { method: "GET", readOnly: true, authenticationRequired: false, creditsRequired: false, modelRequired: false });
  assert.deepEqual(result.endpoints.map(item => item.path), [
    "/api/public/stats", "/api/public/charts", "/api/public/market", "/api/public/catalog",
    "/api/games/search", "/api/history/games", "/api/history", "/api/history/compare",
  ]);
  for (const item of result.endpoints) await access(new URL(`../src/app${item.path}/route.ts`, import.meta.url));
  assert.equal(result.endpoints[0].parameters.universeIds.maxItems, 10);
  assert.equal(result.endpoints[1].parameters.limit.maximum, 50);
  assert.equal(result.endpoints[7].parameters.universeIds.maxItems, 5);
  assert.equal(result.endpoints[7].comparisonPolicy.minimumPairedSlots, 3);
  assert.equal(result.endpoints[7].comparisonPolicy.minimumOverlapFraction, 0.5);
  assert.equal(result.endpoints[7].comparisonPolicy.engineeringHeuristic, true);
  assert.match(result.endpoints[7].response, /requested-period coverage/);
  assert.equal(result.metricDefinitions.metrics.playing.unit, "players");
  assert.match(result.coverage, /Private connected-game data is excluded/);
  assert.match(result.citation, /UTC retrieval timestamp/);
  assert.equal(result.mcp.path, "/mcp");
});

test("non-GET requests are rejected without any service operation", async () => {
  const service = new Proxy({}, { get: () => assert.fail("non-GET must not access a service") });
  for (const endpoint of ["stats", "charts", "market", "catalog"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await createPublicHttpHandler(endpoint, service)(request(endpoint, "", method));
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});
