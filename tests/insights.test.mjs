import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { claimInsight, failInsight, insightContentSchema, insightDay, latestInsight, pageKey, saveInsight, verifiedRadar } from "../src/lib/insights/store.ts";
import { evidenceRecommendations } from "../src/lib/insights/evidence.ts";
import { analyzeMarket } from "../src/lib/market-analysis.ts";

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", "011_insights.sql"), "utf8"));
  return db;
}

const content = (overrides = {}) => ({
  recommendations: [{ title: "Lava Dodge Rush", reason: "Obbies keep appearing in Top Trending while few pair them with falling-block chaos." }],
  radar: [],
  dataAt: "2026-09-27T09:00:00.000Z",
  generatedAt: "2026-09-27T09:01:00.000Z",
  ...overrides,
});
const item = (kind, url, extra = {}) => ({ kind, headline: "An indie game is taking off", why: "Its simple loop could suit a Roblox audience.", source: "Example News", url, published: "2026-09-25", ...extra });

test("one request at a time generates a day's insight, and a stuck or failed one is retried later", async (t) => {
  const db = await database(t);
  assert.equal(insightDay(new Date("2026-09-27T23:59:59Z")), "2026-09-27");
  assert.equal(await claimInsight(db, "2026-09-27"), true);
  assert.equal(await claimInsight(db, "2026-09-27"), false);

  await db.query("UPDATE insights SET started_at = now() - interval '6 minutes' WHERE day='2026-09-27'");
  assert.equal(await claimInsight(db, "2026-09-27"), true, "a generation running for over 5 minutes is presumed stuck");

  await failInsight(db, { day: "2026-09-27", cost: 1_234, calls: [{ purpose: "recommendations" }] });
  assert.equal(await claimInsight(db, "2026-09-27"), false, "a failure waits 15 minutes before a retry");
  await db.query("UPDATE insights SET finished_at = now() - interval '16 minutes' WHERE day='2026-09-27'");
  assert.equal(await claimInsight(db, "2026-09-27"), true);

  await saveInsight(db, { day: "2026-09-27", content: content(), cost: 5_000, calls: [] });
  assert.equal(await claimInsight(db, "2026-09-27"), false, "a ready insight is never regenerated");
});

test("the latest ready insight is shown until today's is ready, and malformed content is refused", async (t) => {
  const db = await database(t);
  assert.equal(await latestInsight(db), null);
  await claimInsight(db, "2026-09-26");
  await saveInsight(db, { day: "2026-09-26", content: content(), cost: 5_000, calls: [] });
  await claimInsight(db, "2026-09-27");
  assert.deepEqual(await latestInsight(db), { day: "2026-09-26", content: content() });

  await assert.rejects(saveInsight(db, { day: "2026-09-27", content: content({ recommendations: [] }), cost: 0, calls: [] }));
  await assert.rejects(saveInsight(db, { day: "2026-09-27", content: content({ radar: [item("outside", "javascript:alert(1)")] }), cost: 0, calls: [] }));
  await saveInsight(db, { day: "2026-09-27", content: content({ radar: [item("roblox", "https://example.com/story")] }), cost: 0, calls: [] });
  assert.equal((await latestInsight(db)).day, "2026-09-27");
});

test("the radar keeps only recent links the web search returned, without duplicates, two of each kind at most", () => {
  assert.equal(pageKey("https://www.Example.com/news/story/?utm_source=openai#top"), "example.com/news/story");
  assert.equal(pageKey("ftp://example.com/file"), null);

  const searched = ["a", "b?utm_source=openai", "c", "d", "e", "old", "undated", "future"].map((page) => `https://www.example.com/${page}`);
  const kept = verifiedRadar(
    [
      item("outside", "https://example.com/a"),
      item("outside", "https://example.com/a/"),
      item("outside", "https://invented.example/nowhere"),
      item("roblox", "https://example.com/b"),
      item("roblox", "https://example.com/old", { published: "2026-09-12" }),
      item("roblox", "https://example.com/undated", { published: null }),
      item("roblox", "https://example.com/future", { published: "2026-09-29" }),
      item("outside", "https://example.com/c", { published: "2026-09-13" }),
      item("outside", "https://example.com/d"),
      item("outside", "https://example.com/e"),
    ],
    searched,
    "2026-09-27",
  );
  assert.deepEqual(kept.map((entry) => [entry.kind, entry.url]), [
    ["outside", "https://example.com/a"],
    ["roblox", "https://example.com/b"],
    ["roblox", "https://example.com/undated"],
    ["outside", "https://example.com/c"],
  ]);
});

test("old JSON stays readable and new dated evidence/research round-trips through the existing JSON column", async (t) => {
  const db = await database(t);
  await claimInsight(db, "2026-09-27");
  // Simulate an already-stored legacy row, without routing it through the new writer.
  await db.query("UPDATE insights SET status='ready', content=$1 WHERE day='2026-09-27'", [JSON.stringify(content())]);
  const legacy = await latestInsight(db);
  assert.deepEqual(legacy.content, content());
  assert.equal(legacy.content.marketEvidence, undefined);
  assert.equal(legacy.content.recommendations[0].research, undefined);

  const chartIds = ["top-playing-now", "top-trending", "up-and-coming", "top-earning"];
  const fetchedAt = "2026-09-28T08:59:00.000Z", expiresAt = "2026-09-28T09:01:00.000Z";
  const samples = chartIds.map((chart, i) => ({ chart, games: i === 0 ? [{
    universeId: 123, rootPlaceId: 456, name: "Fixture Obby", playing: 20, genre: "Adventure", sponsored: false,
  }] : null }));
  const generated = await evidenceRecommendations({
    samples, analysis: analyzeMarket(samples, "2026-09-28T09:00:00.000Z"),
    observations: [{ chart: chartIds[0], fetchedAt, expiresAt }],
  }, async () => ({ recommendations: [{
    title: "Rescue Rope Team", proposal: { coreAction: "rescue teammates on an obstacle course", variation: "cooperative rescue ropes" },
    evidenceRefs: [{ chart: chartIds[0], universeId: 123 }], researchTerms: ["rescue ropes"],
  }] }), { search: async () => { throw new Error("upstream outage"); } });
  const enriched = content({ ...generated, generatedAt: "2026-09-28T09:01:00.000Z" });
  await claimInsight(db, "2026-09-28");
  await saveInsight(db, { day: "2026-09-28", content: enriched, cost: 0, calls: [] });
  assert.deepEqual((await latestInsight(db)).content, enriched);
  assert.equal(enriched.dataAt, fetchedAt);
  assert.equal(enriched.recommendations[0].research.status, "unavailable");
  assert.equal(enriched.marketEvidence.charts[1].status, "unavailable");

  const invalid = (mutate) => {
    const changed = structuredClone(enriched);
    mutate(changed);
    assert.equal(insightContentSchema.safeParse(changed).success, false);
    return changed;
  };
  invalid((row) => { row.dataAt = row.marketEvidence.assembledAt; });
  invalid((row) => { row.recommendations[0].evidence[0].fetchedAt = row.marketEvidence.assembledAt; });
  invalid((row) => { row.recommendations[0].evidence[0].chart = chartIds[1]; });
  invalid((row) => { delete row.recommendations[0].evidence; });
  invalid((row) => { delete row.recommendations[0].research; });
  invalid((row) => { delete row.marketEvidence; });
  invalid((row) => { row.marketEvidence.charts[0].stale = true; });
  invalid((row) => { row.marketEvidence.charts[1] = row.marketEvidence.charts[0]; });
  invalid((row) => { row.recommendations[0].research.status = "complete"; });
  invalid((row) => { row.recommendations[0].reason = "These experiences have a 99% click-through rate, so test rescue ropes."; });
  invalid((row) => { row.recommendations[0].proposal.variation = "99 percent CTR"; });
  invalid((row) => { row.recommendations[0].title = "99% CTR Obby"; });
  invalid((row) => { delete row.marketEvidence; delete row.recommendations[0].evidence; delete row.recommendations[0].research; });
  const previousStructured = structuredClone(enriched);
  delete previousStructured.recommendations[0].proposal;
  previousStructured.recommendations[0].reason = "An earlier AI suggestion without the constrained proposal contract.";
  assert.equal(insightContentSchema.safeParse(previousStructured).success, true, "previous evidence-bearing JSON remains readable as an unverified suggestion");
  await assert.rejects(saveInsight(db, { day: "2026-09-28", content: invalid((row) => {
    row.recommendations[0].evidence[0].rootPlaceId = -10;
  }), cost: 0, calls: [] }));
  // A malformed stored record is never returned to the client as trusted evidence.
  await db.query("UPDATE insights SET content=$1 WHERE day='2026-09-28'", [JSON.stringify({ ...enriched, recommendations: [] })]);
  assert.equal(await latestInsight(db), null);
});
