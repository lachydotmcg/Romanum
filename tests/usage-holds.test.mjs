import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { CreditsError, getBalance, grantCredits } from "../src/lib/credits/ledger.ts";
import { finishUnreportedUsage, reserveUsage, settleUsage } from "../src/lib/credits/usage-holds.ts";

// Bounded per-call holds run on the same transactional engine as the credits
// ledger, in an isolated in-memory database. Fixtures never touch the app
// database and never call a provider.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "010_usage.sql", "014_usage_holds.sql"]) {
    await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", file), "utf8"));
  }
  return db;
}

const count = async (db, table, where = "true", values = []) => (await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${where}`, values)).rows[0].count;
const holdStatus = async (db, id) => (await db.query("SELECT status FROM usage_holds WHERE id=$1", [id])).rows[0].status;
const carry = async (db, owner) => Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1", [owner])).rows[0].carry_nano_usd);
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a CreditsError"), (thrown) => thrown);
  assert.ok(error instanceof CreditsError, `expected CreditsError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};

// At DeepSeek's peak this call costs $0.00372, which is 0.93 credits after the 2.5× markup.
const call = (overrides = {}) => ({ model: "deepseek-flash", at: new Date("2026-09-23T02:00:00Z"), input: 10_000, cachedInput: 20_000, output: 500, ...overrides });
// A single call that really costs 7.5 credits: 100,000 input tokens, $0.03 cost, $0.075 price.
const heavyCall = () => ({ model: "deepseek-flash", at: new Date("2026-09-23T02:00:00Z"), input: 100_000, cachedInput: 0, output: 0 });

test("a hold that needs more credits than the account has is refused and leaves nothing behind", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 1, operationId: "g" });
  // The quote needs 9 credits (ceil 7.5 + 1); only 1 is available.
  await rejection(reserveUsage(db, { ownerId: "owner-a", feature: "ask", maxPriceNanoUsd: 75_000_000 }), "insufficient_balance");
  assert.equal(await count(db, "usage_holds"), 0);
  assert.equal(await count(db, "credits_operations"), 1); // just the grant
  assert.equal(await count(db, "credits_ledger"), 1);
  assert.deepEqual(await getBalance(db, { ownerId: "owner-a" }), { ownerId: "owner-a", balance: 1, reserved: 0, available: 1 });
  // An account that was never credited has nothing to hold.
  await rejection(reserveUsage(db, { ownerId: "ghost", feature: "chat", maxPriceNanoUsd: 1 }), "insufficient_balance");
  assert.equal(await count(db, "usage_holds"), 0);
});

test("settlement charges the real usage and releases the unused part of the hold", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 100, operationId: "g" });

  const hold = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 75_000_000 });
  assert.equal(hold.amount, 9); // ceil(7.5) + 1
  assert.deepEqual(await getBalance(db, { ownerId: owner }), { ownerId: owner, balance: 100, reserved: 9, available: 91 });

  const settled = await settleUsage(db, { ownerId: owner, id: hold.id, call: heavyCall() });
  assert.equal(settled.credits, 7.5);
  assert.equal(settled.charged, 7);
  assert.deepEqual(await getBalance(db, { ownerId: owner }), { ownerId: owner, balance: 93, reserved: 0, available: 93 });

  // The backing reservation settled for 7 of its 9 held credits.
  const entries = (await db.query("SELECT entry_type, amount FROM credits_ledger WHERE operation_id=$1 ORDER BY id", [`model-call:${hold.id}`])).rows;
  assert.deepEqual(entries.map((row) => [row.entry_type, Number(row.amount)]), [["reserve", 9], ["capture", 7]]);

  const { rows: charges } = await db.query("SELECT feature, calls, cost_nano_usd, price_nano_usd, credits_charged, unpaid_nano_usd FROM usage_charges");
  assert.deepEqual(charges.map((row) => [row.feature, Number(row.cost_nano_usd), Number(row.price_nano_usd), Number(row.credits_charged), Number(row.unpaid_nano_usd)]), [["chat", 30_000_000, 75_000_000, 7, 0]]);
  assert.equal(charges[0].calls[0].costNanoUsd, 30_000_000);

  const { rows: holds } = await db.query("SELECT status, reserved_credits, settled_price_nano_usd, settled_credits_charged, call_fingerprint FROM usage_holds WHERE id=$1", [hold.id]);
  assert.equal(holds[0].status, "settled");
  assert.equal(Number(holds[0].reserved_credits), 9);
  assert.equal(Number(holds[0].settled_credits_charged), 7);
  assert.match(holds[0].call_fingerprint, /^[a-f0-9]{64}$/);
});

test("a fractional carry flows across held calls exactly as it does for metering", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 50, operationId: "g" });

  const first = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 9_300_000 });
  assert.equal(first.amount, 2); // ceil(0.93) + 1
  const one = await settleUsage(db, { ownerId: owner, id: first.id, call: call() });
  assert.equal(one.credits, 0.93);
  assert.equal(one.charged, 0);
  assert.equal(await carry(db, owner), 9_300_000);
  assert.equal((await getBalance(db, { ownerId: owner })).available, 50);

  // The second quote covers two calls; the held extra credit also covers carry.
  const second = await reserveUsage(db, { ownerId: owner, feature: "ask", maxPriceNanoUsd: 18_600_000 });
  assert.equal(second.amount, 3); // ceil(1.86) + 1
  const two = await settleUsage(db, { ownerId: owner, id: second.id, call: call() });
  assert.equal(two.charged, 1);
  assert.equal(await carry(db, owner), 8_600_000);
  assert.equal((await getBalance(db, { ownerId: owner })).available, 49);

  const entries = (await db.query("SELECT entry_type, amount FROM credits_ledger WHERE operation_id=$1 ORDER BY id", [`model-call:${second.id}`])).rows;
  assert.deepEqual(entries.map((row) => [row.entry_type, Number(row.amount)]), [["reserve", 3], ["capture", 1]]);

  const { rows } = await db.query("SELECT feature, credits_charged FROM usage_charges ORDER BY created_at");
  assert.deepEqual(rows.map((row) => [row.feature, Number(row.credits_charged)]), [["chat", 0], ["ask", 1]]);
});

test("holds are owned: another owner and an unknown id cannot settle or close one", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 20, operationId: "g" });
  const hold = await reserveUsage(db, { ownerId: "owner-a", feature: "ask", maxPriceNanoUsd: 9_300_000 });

  await rejection(settleUsage(db, { ownerId: "owner-b", id: hold.id, call: call() }), "not_found");
  await rejection(finishUnreportedUsage(db, { ownerId: "owner-b", id: hold.id, uncertain: false }), "not_found");
  await rejection(settleUsage(db, { ownerId: "owner-a", id: randomUUID(), call: call() }), "not_found");
  await rejection(finishUnreportedUsage(db, { ownerId: "owner-a", id: randomUUID(), uncertain: true }), "not_found");

  assert.equal(await holdStatus(db, hold.id), "reserved");
  assert.equal((await getBalance(db, { ownerId: "owner-a" })).reserved, 2);
  assert.equal(await count(db, "usage_charges"), 0);
});

test("replaying an identical settlement returns the saved result, a different call is a conflict", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 50, operationId: "g" });
  const hold = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 9_300_000 });

  const first = await settleUsage(db, { ownerId: owner, id: hold.id, call: call() });
  assert.equal(first.charged, 0);
  const replay = await settleUsage(db, { ownerId: owner, id: hold.id, call: call() });
  assert.deepEqual(replay, first);
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type = 'capture'"), 1);
  assert.equal(await carry(db, owner), 9_300_000);

  await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: call({ output: 600 }) }), "conflict");
  await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: call({ input: 9_999 }) }), "conflict");
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal((await getBalance(db, { ownerId: owner })).available, 50);
});

test("two concurrent holds for one account cannot overspend it", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 10, operationId: "g" });

  const attempts = await Promise.allSettled([
    reserveUsage(db, { ownerId: owner, feature: "ask", maxPriceNanoUsd: 50_000_000 }),
    reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 50_000_000 }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "insufficient_balance");

  const balance = await getBalance(db, { ownerId: owner });
  assert.ok(balance.reserved <= balance.balance);
  assert.equal(balance.reserved, 6); // ceil(5.0) + 1
  assert.equal(await count(db, "usage_holds"), 1);
});

test("an uncertain hold keeps its reservation, can settle later, and cannot be reverted", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 50, operationId: "g" });
  const hold = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 9_300_000 });

  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: true });
  assert.equal(await holdStatus(db, hold.id), "uncertain");
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);
  // Reporting uncertainty twice is idempotent.
  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: true });
  assert.equal(await holdStatus(db, hold.id), "uncertain");
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);
  // A late "definitely not run" must not auto-release an uncertain hold.
  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: false });
  assert.equal(await holdStatus(db, hold.id), "uncertain");
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);

  // The provider's reported usage still settles it.
  const settled = await settleUsage(db, { ownerId: owner, id: hold.id, call: call() });
  assert.equal(settled.credits, 0.93);
  assert.equal(await holdStatus(db, hold.id), "settled");
  assert.equal((await getBalance(db, { ownerId: owner })).available, 50);
  // And a late uncertainty or release can never revert the settled hold.
  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: true });
  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: false });
  assert.equal(await holdStatus(db, hold.id), "settled");
  assert.equal((await getBalance(db, { ownerId: owner })).available, 50);
  assert.equal(await count(db, "usage_charges"), 1);
});

test("a definite preflight failure releases the hold, idempotently", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 10, operationId: "g" });
  const hold = await reserveUsage(db, { ownerId: owner, feature: "ask", maxPriceNanoUsd: 9_300_000 });
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);

  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: false });
  assert.equal(await holdStatus(db, hold.id), "released");
  assert.deepEqual(await getBalance(db, { ownerId: owner }), { ownerId: owner, balance: 10, reserved: 0, available: 10 });

  await finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: false });
  assert.equal(await holdStatus(db, hold.id), "released");
  assert.equal(await count(db, "credits_ledger", "entry_type = 'release'"), 1);
  assert.equal(await count(db, "usage_charges"), 0);
  // A released hold can no longer be settled.
  await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: call() }), "invalid_operation");
});

test("invalid and over-quote usage is refused, leaving the hold held for reconciliation", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 20, operationId: "g" });
  const hold = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 9_300_000 });

  const badCalls = [
    call({ input: -1 }),
    call({ output: 1.5 }),
    call({ cachedInput: Number.NaN }),
    call({ output: Number.POSITIVE_INFINITY }),
    call({ at: new Date("not a date") }),
    call({ model: "unpriced-model" }),
    undefined,
  ];
  for (const bad of badCalls) await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: bad }), "invalid_input");

  // 50,000 input tokens price at 24.75 credits, far above the 0.93-credit quote.
  await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: call({ input: 50_000, cachedInput: 0, output: 0 }) }), "conflict");

  assert.equal(await holdStatus(db, hold.id), "reserved");
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);
  assert.equal(await count(db, "usage_charges"), 0);
  assert.equal(await count(db, "usage_carry"), 0);
  assert.equal(await count(db, "credits_ledger", "entry_type = 'capture'"), 0);

  // Bad hold inputs never create a reservation either.
  for (const maxPriceNanoUsd of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await rejection(reserveUsage(db, { ownerId: owner, feature: "ask", maxPriceNanoUsd }), "invalid_input");
  }
  await rejection(reserveUsage(db, { ownerId: owner, feature: "nope", maxPriceNanoUsd: 1 }), "invalid_input");
  await rejection(reserveUsage(db, { ownerId: "", feature: "ask", maxPriceNanoUsd: 1 }), "invalid_input");
  await rejection(settleUsage(db, { ownerId: owner, id: "not-a-uuid", call: call() }), "invalid_input");
  await rejection(finishUnreportedUsage(db, { ownerId: owner, id: hold.id, uncertain: "yes" }), "invalid_input");
  assert.equal(await count(db, "usage_holds"), 1);
});

test("the hold, the reservation and the charge each commit as one atomic unit", async (t) => {
  const db = await database(t);
  const owner = "owner-a";
  await grantCredits(db, { ownerId: owner, amount: 10, operationId: "g" });

  // A successful hold always writes its ledger reservation with it.
  const hold = await reserveUsage(db, { ownerId: owner, feature: "chat", maxPriceNanoUsd: 9_300_000 });
  assert.equal(await count(db, "usage_holds", "id = $1", [hold.id]), 1);
  assert.equal(await count(db, "credits_operations", "operation_id = $1 AND kind = 'reserve'", [`model-call:${hold.id}`]), 1);

  // A refused over-quote settlement leaves the carry, the charge, the capture and
  // the hold exactly as they were.
  await rejection(settleUsage(db, { ownerId: owner, id: hold.id, call: call({ input: 50_000, cachedInput: 0, output: 0 }) }), "conflict");
  assert.equal(await count(db, "usage_carry"), 0);
  assert.equal(await count(db, "usage_charges"), 0);
  assert.equal(await count(db, "usage_holds", "status = 'reserved'"), 1);
  assert.equal((await getBalance(db, { ownerId: owner })).reserved, 2);

  // A successful settlement writes the whole result group together.
  const settled = await settleUsage(db, { ownerId: owner, id: hold.id, call: call() });
  assert.equal(settled.charged, 0);
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "usage_carry"), 1);
  assert.equal(await carry(db, owner), 9_300_000);
  assert.equal(await holdStatus(db, hold.id), "settled");
});
