import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { claimInsight, failInsight, insightDay, latestInsight, pageKey, saveInsight, verifiedRadar } from "../src/lib/insights/store.ts";

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
