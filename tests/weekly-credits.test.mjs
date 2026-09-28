import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { creditWeek, applyWeeklyCreditFloor } from "../src/lib/credits/weekly.ts";
import { welcomeAccount } from "../src/lib/credits/account.ts";
import { getBalance, grantCredits, reserveCredits, releaseReservation, settleReservation } from "../src/lib/credits/ledger.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import { readExportPage } from "../src/lib/accounts/data-export.ts";
import { assistantBilling } from "../src/lib/assistant/billing.ts";

const week1 = new Date("2026-09-28T00:00:00Z"), week2 = new Date("2026-10-05T00:00:00Z");
async function database(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  await migrateHistory(db); return db;
}
async function account(db, user = 42, plan = "free") {
  const id = randomUUID(), ownerId = `account:${id}`;
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,credit_plan) VALUES($1,$2,$3,'test','Test',$4)", [id, user, ownerId, plan]);
  return { id, ownerId };
}
const grant = (db, a, amount, key = "grant") => grantCredits(db, { ownerId: a.ownerId, amount, operationId: `${key}:${a.id}` });
async function spend(db, a, amount) {
  const operationId = randomUUID();
  await reserveCredits(db, { ownerId: a.ownerId, amount, operationId });
  await settleReservation(db, { ownerId: a.ownerId, actualCost: amount, operationId });
}

test("credit weeks cross the UTC Monday boundary correctly", () => {
  assert.equal(creditWeek(new Date("2026-09-27T23:59:59.999Z")), "2026-09-21");
  assert.equal(creditWeek(week1), "2026-09-28");
  assert.equal(creditWeek(new Date("2026-10-04T23:59:59.999Z")), "2026-09-28");
});

test("free accounts refill to 25 once a week; refreshes and concurrent requests do not stack", async t => {
  const db = await database(t), a = await account(db);
  await grant(db, a, 9);
  const balances = await Promise.all(Array.from({ length: 8 }, () => applyWeeklyCreditFloor(db, a.id, week1)));
  assert.ok(balances.every(b => b.balance === 25));
  await spend(db, a, 8);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, new Date("2026-10-04T23:59:59Z"))).balance, 17);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week2)).balance, 25);
  assert.deepEqual((await db.query("SELECT amount FROM weekly_credit_claims ORDER BY week_start")).rows.map(r => r.amount), [16, 8]);
});

test("higher balances are retained, held credits do not inflate refills, and weeks never accumulate", async t => {
  const db = await database(t), a = await account(db);
  await grant(db, a, 40);
  await reserveCredits(db, { ownerId: a.ownerId, amount: 35, operationId: "hold" });
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week1)).balance, 40);
  await releaseReservation(db, { ownerId: a.ownerId, operationId: "hold" });
  await spend(db, a, 40);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week1)).balance, 0);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, new Date("2026-12-14T00:00:00Z"))).balance, 25);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM weekly_credit_claims")).rows[0].n, 2);
});

test("subscribers, guests and missing accounts do not receive the free weekly allowance", async t => {
  const db = await database(t), a = await account(db, 42, "subscribed");
  await grant(db, a, 3);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week1)).balance, 3);
  await assert.rejects(applyWeeklyCreditFloor(db, randomUUID(), week1), /Account not found/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM weekly_credit_claims")).rows[0].n, 0);
  await db.query("UPDATE accounts SET credit_plan='free' WHERE id=$1", [a.id]);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week1)).balance, 25);
});

test("sign-up adds 100 once and records a zero refill for its first week", async t => {
  const db = await database(t), a = await account(db);
  assert.equal((await welcomeAccount(db, a.id, week1)).balance, 110);
  await spend(db, a, 107);
  assert.equal((await welcomeAccount(db, a.id, week1)).balance, 3);
  assert.equal((await welcomeAccount(db, a.id, week2)).balance, 25);
  assert.equal((await welcomeAccount(db, a.id, week2)).balance, 25);
});

test("legacy 50/150 grants keep their remaining balances and do not conflict or award another bonus", async t => {
  const db = await database(t), a = await account(db);
  await grantCredits(db, { ownerId: a.ownerId, operationId: `welcome:${a.ownerId}`, amount: 50 });
  await grantCredits(db, { ownerId: a.ownerId, operationId: "signup:roblox:42", amount: 150 });
  await spend(db, a, 55);
  assert.equal((await welcomeAccount(db, a.id, week1)).balance, 145);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_operations WHERE kind='grant'")).rows[0].n, 2);
});

test("deletion and recreation cannot repeat the Roblox user's weekly claim or sign-up bonus", async t => {
  const db = await database(t), a = await account(db);
  await welcomeAccount(db, a.id, week1);
  await spend(db, a, 110);
  await welcomeAccount(db, a.id, week2);
  await closeAccount(db, a);
  const b = await account(db);
  assert.equal((await welcomeAccount(db, b.id, week2)).balance, 10);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM weekly_credit_claims WHERE week_start='2026-10-05'")).rows[0].n, 1);
  await assert.rejects(applyWeeklyCreditFloor(db, a.id, week2), /Account not found/);
});

test("a failed grant rolls back its weekly claim so the refill can retry", async t => {
  const db = await database(t), a = await account(db);
  await grant(db, a, 4);
  const failing = { ...db, transaction: fn => db.transaction(sql => fn({ ...sql, query: (text, values) => {
    if (text.startsWith("INSERT INTO credits_operations")) throw new Error("grant failed");
    return sql.query(text, values);
  } })) };
  await assert.rejects(applyWeeklyCreditFloor(failing, a.id, week1), /grant failed/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM weekly_credit_claims")).rows[0].n, 0);
  assert.equal((await getBalance(db, { ownerId: a.ownerId })).balance, 4);
  assert.equal((await applyWeeklyCreditFloor(db, a.id, week1)).balance, 25);
});

test("weekly claims and tool fees export only to their owner", async t => {
  const db = await database(t), a = await account(db), b = await account(db, 43);
  await welcomeAccount(db, a.id, week1);
  await assistantBilling(db, a.ownerId, "chat").tool("load_skill", async () => ({ ok: true, result: {}, summary: "Loaded" }), new AbortController().signal);
  const tool = await readExportPage(db, a, "tool_usage");
  assert.equal(tool.records[0].tool_name, "load_skill");
  assert.equal(tool.records[0].price_nano_usd, "600000");
  assert.equal((await readExportPage(db, a, "weekly_credit_claims")).records[0].amount, 0);
  assert.equal((await readExportPage(db, a, "usage_charges")).records[0].tools[0].name, "load_skill");
  assert.equal((await readExportPage(db, b, "tool_usage")).records.length, 0);
  assert.equal((await readExportPage(db, b, "weekly_credit_claims")).records.length, 0);
});
