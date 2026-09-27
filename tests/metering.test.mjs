import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getBalance, grantCredits } from "../src/lib/credits/ledger.ts";
import { chargeAnswer, chargeUsage } from "../src/lib/credits/metering.ts";

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "010_usage.sql"]) await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", file), "utf8"));
  return db;
}

// At DeepSeek's peak this call costs $0.00372, which is 0.6138 credits after the 1.65× markup.
const call = (overrides = {}) => ({ model: "deepseek-flash", at: new Date("2026-09-23T02:00:00Z"), input: 10_000, cachedInput: 20_000, output: 500, ...overrides });
const carry = async (db, owner) => Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1", [owner])).rows[0].carry_nano_usd);

test("fractions of a credit carry over until they add up to a whole credit, which the ledger records", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "guest:a", operationId: "welcome:guest:a", amount: 50 });

  const first = await chargeUsage(db, { ownerId: "guest:a", feature: "chat", calls: [call()] });
  assert.equal(first.cost, 3_720_000);
  assert.equal(first.price, 6_138_000);
  assert.equal(first.credits, 0.6138);
  assert.equal(first.charged, 0);
  assert.equal((await getBalance(db, { ownerId: "guest:a" })).available, 50);
  assert.equal(await carry(db, "guest:a"), 6_138_000);

  const second = await chargeUsage(db, { ownerId: "guest:a", feature: "ask", calls: [call()] });
  assert.equal(second.charged, 1);
  assert.equal((await getBalance(db, { ownerId: "guest:a" })).available, 49);
  assert.equal(await carry(db, "guest:a"), 2_276_000);
  const { rows: entries } = await db.query("SELECT entry_type, amount FROM credits_ledger WHERE operation_id=$1 ORDER BY id", [`usage:${second.id}`]);
  assert.deepEqual(entries.map((row) => [row.entry_type, Number(row.amount)]), [["reserve", 1], ["capture", 1]]);

  const { rows } = await db.query("SELECT feature, calls, cost_nano_usd, credits_charged FROM usage_charges ORDER BY created_at, credits_charged");
  assert.deepEqual(rows.map((row) => [row.feature, Number(row.credits_charged)]), [["chat", 0], ["ask", 1]]);
  assert.deepEqual(rows[0].calls[0], { model: "deepseek-flash", at: "2026-09-23T02:00:00.000Z", peak: true, input: 10_000, cachedInput: 20_000, cacheWrite: 0, output: 500, costNanoUsd: 3_720_000 });
});

test("an answer that costs more than the balance empties it, and the shortfall is written off, not owed", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "guest:a", operationId: "welcome:guest:a", amount: 1 });
  // Four calls: 2.4552 credits due, with 1 credit available.
  const charge = await chargeUsage(db, { ownerId: "guest:a", feature: "chat", calls: [call(), call(), call(), call()] });
  assert.equal(charge.charged, 1);
  assert.equal(charge.unpaid, 10_000_000);
  assert.equal((await getBalance(db, { ownerId: "guest:a" })).available, 0);
  assert.equal(await carry(db, "guest:a"), 4_552_000);

  // Without an account there is nothing to charge.
  const none = await chargeUsage(db, { ownerId: "guest:b", feature: "ask", calls: [call(), call()] });
  assert.equal(none.charged, 0);
  assert.equal(none.unpaid, 10_000_000);
});

test("a charged answer reports its cost on the stream, and an answer without usage isn't charged", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "guest:a", operationId: "welcome:guest:a", amount: 50 });
  const sent = [];
  await chargeAnswer(db, { ownerId: "guest:a", feature: "chat", calls: [call()], send: (event) => sent.push(event) });
  await chargeAnswer(db, { ownerId: "guest:a", feature: "chat", calls: [], send: (event) => sent.push(event) });
  assert.deepEqual(sent, [{ type: "usage", credits: 0.6138 }]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM usage_charges")).rows[0].count, 1);
});
