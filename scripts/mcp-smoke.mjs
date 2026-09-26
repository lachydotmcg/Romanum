import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
const client = new Client({ name: "romanum-smoke", version: "1" });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`);
  assert.ok(result.structuredContent, `${name} must return structured data`);
  return result.structuredContent;
};

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  const { resources } = await client.listResources();
  assert.equal(resources.length, 6);
  await client.readResource({ uri: "romanum://skills/romanum-game-design" });
  await call("get_metric_definitions");
  await call("load_skill", { skill: "romanum-genre-analysis" });
  const search = await call("search_games", { query: "Blox Fruits" });
  const research = await call("research_game_idea", { title: "Blox Fruits", terms: ["pirate adventure"] });
  assert.equal(research.status, "complete");
  assert.ok(research.games.length > 0, "idea research finds real candidate competitors");
  const chart = await call("get_roblox_charts", { chart: "top-playing-now", limit: 3 });
  assert.ok(chart.games.length > 0, "live chart contains experiences");
  const stats = await call("get_game_stats", { universeIds: chart.games.map((game) => game.universeId) });
  assert.ok(stats.games.length > 0, "live stats resolve chart IDs");
  const first = stats.games[0];
  const resolved = await call("resolve_game_link", { link: `https://www.roblox.com/games/${first.rootPlaceId}` });
  assert.equal(resolved.universeId, first.universeId);
  const history = await call("get_game_history", { universeId: first.universeId, days: 1 });
  assert.ok(Array.isArray(history.points));
  const analysis = await call("get_market_analysis");
  assert.ok(analysis.sampleSize > 0, "market uses real chart observations");
  const cached = await call("get_roblox_charts", { chart: "top-playing-now", limit: 3 });
  assert.equal(cached.fetchedAt, chart.fetchedAt, "cache preserves retrieval time");
  console.log(JSON.stringify({
    endpoint: endpoint.href, protocol: "legacy", tools: tools.length, resources: resources.length,
    searchMatches: search.games.length, chartGames: chart.games.length, statsGames: stats.games.length,
    icons: stats.games.filter((game) => game.iconUrl).length,
    historicalObservations: history.sampleCount,
    sampleSize: analysis.sampleSize, unavailableCharts: analysis.unavailableCharts,
    fetchedAt: chart.fetchedAt, source: chart.source,
  }, null, 2));
} finally {
  await client.close();
}

const modern = new Client({ name: "romanum-smoke", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
try {
  await modern.connect(new StreamableHTTPClientTransport(endpoint));
  const result = await modern.callTool({ name: "get_metric_definitions", arguments: {} });
  assert.ok(!result.isError);
  console.log("Protocol 2026-07-28: connected and called a tool.");
} finally {
  await modern.close();
}
