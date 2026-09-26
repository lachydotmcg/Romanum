import test from "node:test";
import assert from "node:assert/strict";
import { researchGameIdea } from "../src/lib/idea-research.ts";

const stamp = "2026-01-01T00:00:00Z";
const game = { universeId: 1, rootPlaceId: 2, name: "Fixture", playing: 0, likes: 0, dislikes: 0, sponsored: true };
test("idea research deduplicates queries and competitors without turning ads into endorsements", async () => {
  const calls = [];
  const result = await researchGameIdea({ title: "  Garden  ", terms: ["garden", "plant puzzle"] }, {
    search: async (query) => { calls.push(query); return { fetchedAt: stamp, games: [game, game] }; },
  });
  assert.deepEqual(calls, ["garden", "plant puzzle"]);
  assert.equal(result.status, "complete");
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].playing, 0);
  assert.equal(result.games[0].sponsored, true);
  assert.deepEqual(result.games[0].matchedQueries, calls);
  assert.equal(result.games[0].fetchedAt, stamp);
  assert.equal("novel" in result, false);
});
test("failed searches are distinct from successful empty results", async () => {
  const result = await researchGameIdea({ title: "New idea", terms: ["missing"] }, {
    search: async (query) => { if (query === "missing") throw new Error("upstream credential detail"); return { fetchedAt: stamp, games: [] }; },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.searches[0].resultCount, 0);
  assert.equal(result.searches[1].resultCount, null);
  assert.equal(result.searches[1].fetchedAt, null);
  assert.ok(!JSON.stringify(result).includes("credential"));
  const unavailable = await researchGameIdea({ title: "New idea", terms: ["missing"] }, { search: async () => { throw new Error(); } });
  assert.equal(unavailable.status, "unavailable");
});
test("invalid or unbounded research cannot trigger requests", async () => {
  const blocked = new Proxy({}, { get() { assert.fail("invalid input reached service"); } });
  for (const input of [{ title: "", terms: ["x"] }, { title: "x", terms: [] }, { title: "x", terms: ["a", "b", "c"] }, { title: "x", terms: ["a"], url: "http://internal" }]) {
    await assert.rejects(researchGameIdea(input, blocked));
  }
});
