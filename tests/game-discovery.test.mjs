import test from "node:test";
import assert from "node:assert/strict";
import { loadPublicGame, parseUniverseId, searchPublicGames } from "../src/lib/game-discovery.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { runPublicTool } from "../src/lib/public-tools.ts";

test("name search shares its observation with MCP without another upstream request", async () => {
  let calls = 0;
  const service = createPublicDataService({ searchGames: async () => { calls++; return [{ universeId: 123, name: "Example", playing: 0, sponsored: false }]; } });
  const ui = await searchPublicGames("  Example  ", service);
  const mcp = await runPublicTool("search_games", { query: "Example" }, service);
  assert.deepEqual(ui, mcp.result);
  assert.equal(calls, 1);
  assert.equal(ui.games[0].playing, 0);
});

test("link search resolves a place ID before loading universe statistics", async () => {
  const calls = [];
  const service = createPublicDataService({
    universeIdForPlace: async (id) => { calls.push(["resolve", id]); return 456; },
    getGameStats: async (ids) => { calls.push(["stats", ids]); return [{ universeId: 456, rootPlaceId: 123, name: "Example", playing: 0 }]; },
  });
  const link = await searchPublicGames("https://www.roblox.com/games/123/Example?foo=bar", service);
  assert.equal(link.games[0].universeId, 456);
  assert.equal(link.games[0].sponsored, false);
  assert.deepEqual(calls, [["resolve", 123], ["stats", [456]]]);
  assert.deepEqual(await searchPublicGames("123", service), link);
});

test("a colon in a game title is a name search, not a URL scheme", async () => {
  const queries = [];
  const service = createPublicDataService({ searchGames: async (query) => { queries.push(query); return []; } });
  await searchPublicGames("DOORS: The Hunt", service);
  assert.deepEqual(queries, ["DOORS: The Hunt"]);
});

test("invalid searches and non-Roblox links never reach an upstream service", async () => {
  const service = new Proxy({}, { get() { assert.fail("invalid input reached service"); } });
  for (const input of [null, "", " ", "x".repeat(81), "x".repeat(301), "0", "9007199254740992", "http://127.0.0.1/games/123", "file:///etc/passwd", "https://roblox.com.evil.example/games/1", "https://secret@roblox.com/games/1"]) {
    await assert.rejects(searchPublicGames(input, service));
  }
});

test("game pages share MCP stats and preserve absence instead of inventing a game", async () => {
  let calls = 0;
  const service = createPublicDataService({ getGameStats: async () => { calls++; return [{ universeId: 456, playing: 0 }]; } });
  const detail = await loadPublicGame("456", service);
  const mcp = await runPublicTool("get_game_stats", { universeIds: [456] }, service);
  assert.equal(calls, 1);
  assert.deepEqual(detail.game, mcp.result.games[0]);
  assert.equal(detail.fetchedAt, mcp.result.fetchedAt);
  assert.equal((await loadPublicGame("789", service)).game, null);
  const empty = createPublicDataService({ getGameStats: async () => [] });
  assert.equal((await loadPublicGame("1", empty)).game, null);
});

test("route IDs are positive safe integer strings and failed upstream calls stay errors", async () => {
  assert.equal(parseUniverseId("123"), 123);
  const blocked = new Proxy({}, { get() { assert.fail("invalid ID reached service"); } });
  for (const id of ["0", "-1", "1.2", "1e3", " 123", "01", "9007199254740992", "../../secret"]) {
    await assert.rejects(loadPublicGame(id, blocked));
  }
  const service = createPublicDataService({ getGameStats: async () => { throw new Error("offline"); } });
  await assert.rejects(loadPublicGame("123", service), /offline/);
});
