import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  CreditsError,
  getBalance,
  grantCredits,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from "../src/lib/credits/ledger.ts";

// Credits run on the same transactional PostgreSQL engine as history, in an
// isolated in-memory database. Credit fixtures never touch the app database.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", "002_credits.sql"), "utf8"));
  return db;
}

const count = async (db, table, where = "true") => (await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${where}`)).rows[0].count;
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected a CreditsError"), (thrown) => thrown);
  assert.ok(error instanceof CreditsError, `expected CreditsError, received ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return error;
};

test("aggregate balance cannot overflow JavaScript's exact integer range", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: Number.MAX_SAFE_INTEGER, operationId: "max" });
  await rejection(grantCredits(db, { ownerId: "owner-a", amount: 1, operationId: "overflow" }), "invalid_input");
  assert.equal((await getBalance(db, { ownerId: "owner-a" })).balance, Number.MAX_SAFE_INTEGER);
});

test("settlement and release require the reservation's owner", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 20, operationId: "g" });
  await reserveCredits(db, { ownerId: "owner-a", amount: 10, operationId: "held" });
  await rejection(settleReservation(db, { ownerId: "owner-b", operationId: "held", actualCost: 5 }), "not_found");
  await rejection(releaseReservation(db, { ownerId: "owner-b", operationId: "held" }), "not_found");
  assert.equal((await getBalance(db, { ownerId: "owner-a" })).reserved, 10);
});

test("grants credit once, replays on retry and rejects conflicting key reuse", async (t) => {
  const db = await database(t);
  const granted = await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "grant-1" });
  assert.deepEqual(granted, { ownerId: "owner-a", balance: 100, reserved: 0, available: 100, operationId: "grant-1", amount: 100, status: "granted" });

  const retry = await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "grant-1" });
  assert.equal(retry.balance, 100);
  assert.equal(await count(db, "credits_ledger"), 1);

  await rejection(grantCredits(db, { ownerId: "owner-a", amount: 250, operationId: "grant-1" }), "conflict");
  await rejection(grantCredits(db, { ownerId: "owner-b", amount: 100, operationId: "grant-1" }), "conflict");
  assert.equal((await getBalance(db, { ownerId: "owner-a" })).balance, 100);
  assert.equal(await count(db, "credits_accounts"), 1);
});

test("reserves before work, settles at actual cost and releases the remainder", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "g" });

  const reserved = await reserveCredits(db, { ownerId: "owner-a", amount: 40, operationId: "op-1" });
  assert.deepEqual(reserved, { ownerId: "owner-a", balance: 100, reserved: 40, available: 60, operationId: "op-1", amount: 40, status: "reserved", capturedAmount: null });

  const settled = await settleReservation(db, { ownerId: "owner-a", operationId: "op-1", actualCost: 25 });
  assert.equal(settled.status, "captured");
  assert.equal(settled.capturedAmount, 25);
  assert.deepEqual(await getBalance(db, { ownerId: "owner-a" }), { ownerId: "owner-a", balance: 75, reserved: 0, available: 75 });

  // Idempotent settle replay, then a conflicting amount.
  assert.equal((await settleReservation(db, { ownerId: "owner-a", operationId: "op-1", actualCost: 25 })).balance, 75);
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "op-1", actualCost: 10 }), "conflict");
  await rejection(releaseReservation(db, { ownerId: "owner-a", operationId: "op-1" }), "invalid_operation");
  assert.equal((await getBalance(db, { ownerId: "owner-a" })).balance, 75);

  const failed = await reserveCredits(db, { ownerId: "owner-a", amount: 30, operationId: "op-2" });
  assert.equal(failed.available, 45);
  assert.equal((await releaseReservation(db, { ownerId: "owner-a", operationId: "op-2" })).available, 75);
  assert.equal((await releaseReservation(db, { ownerId: "owner-a", operationId: "op-2" })).status, "released");
  assert.deepEqual(await getBalance(db, { ownerId: "owner-a" }), { ownerId: "owner-a", balance: 75, reserved: 0, available: 75 });
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "op-2", actualCost: 5 }), "invalid_operation");
});

test("reservation retries never double-hold and cannot overspend", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "g" });

  await reserveCredits(db, { ownerId: "owner-a", amount: 60, operationId: "op-1" });
  const retry = await reserveCredits(db, { ownerId: "owner-a", amount: 60, operationId: "op-1" });
  assert.equal(retry.reserved, 60);
  assert.equal(retry.status, "reserved");
  assert.equal(await count(db, "credits_ledger", "entry_type = 'reserve'"), 1);

  await rejection(reserveCredits(db, { ownerId: "owner-a", amount: 70, operationId: "op-1" }), "conflict");
  await rejection(reserveCredits(db, { ownerId: "owner-a", amount: 50, operationId: "op-2" }), "insufficient_balance");
  assert.deepEqual(await getBalance(db, { ownerId: "owner-a" }), { ownerId: "owner-a", balance: 100, reserved: 60, available: 40 });
  assert.equal(await count(db, "credits_operations", "kind = 'reserve'"), 1);
});

test("concurrent reservations cannot overspend", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "g" });

  const attempts = await Promise.allSettled([
    reserveCredits(db, { ownerId: "owner-a", amount: 60, operationId: "op-1" }),
    reserveCredits(db, { ownerId: "owner-a", amount: 60, operationId: "op-2" }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "insufficient_balance");

  const balance = await getBalance(db, { ownerId: "owner-a" });
  assert.ok(balance.reserved <= balance.balance);
  assert.equal(balance.reserved, 60);
  await assert.rejects(
    db.query("UPDATE credits_accounts SET reserved = balance + 1 WHERE owner_id = 'owner-a'"),
    "the database constraint rejects an over-reserved account",
  );
});

test("unknown accounts are read as empty and never receive free credits", async (t) => {
  const db = await database(t);
  assert.deepEqual(await getBalance(db, { ownerId: "ghost" }), { ownerId: "ghost", balance: 0, reserved: 0, available: 0 });
  assert.equal(await count(db, "credits_accounts"), 0);
  assert.equal(await count(db, "credits_ledger"), 0);

  await rejection(reserveCredits(db, { ownerId: "ghost", amount: 1, operationId: "op-1" }), "insufficient_balance");
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "missing", actualCost: 1 }), "not_found");
  await rejection(releaseReservation(db, { ownerId: "owner-a", operationId: "missing" }), "not_found");
  assert.equal(await count(db, "credits_accounts"), 0);
});

test("accounts are isolated by opaque owner ID", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 100, operationId: "g-a" });
  await grantCredits(db, { ownerId: "owner-b", amount: 5, operationId: "g-b" });

  await reserveCredits(db, { ownerId: "owner-a", amount: 80, operationId: "op-a" });
  assert.deepEqual(await getBalance(db, { ownerId: "owner-a" }), { ownerId: "owner-a", balance: 100, reserved: 80, available: 20 });
  assert.deepEqual(await getBalance(db, { ownerId: "owner-b" }), { ownerId: "owner-b", balance: 5, reserved: 0, available: 5 });

  // A key already used by one account cannot be reused by another.
  await rejection(reserveCredits(db, { ownerId: "owner-b", amount: 5, operationId: "op-a" }), "conflict");
  await rejection(settleReservation(db, { ownerId: "owner-b", operationId: "g-b", actualCost: 0 }), "invalid_operation");
});

test("invalid and unsafe values never reach ledger writes", async (t) => {
  const db = await database(t);
  const badAmounts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "10", null, undefined];
  for (const amount of badAmounts) {
    await rejection(grantCredits(db, { ownerId: "owner-a", amount, operationId: `g-${String(amount)}` }), "invalid_input");
    await rejection(reserveCredits(db, { ownerId: "owner-a", amount, operationId: `r-${String(amount)}` }), "invalid_input");
  }
  for (const ownerId of ["", null, 7, "x".repeat(201), "bad\0id"]) {
    await rejection(grantCredits(db, { ownerId, amount: 10, operationId: "g" }), "invalid_input");
  }
  await rejection(reserveCredits(db, { ownerId: "owner-a", amount: 10, operationId: "" }), "invalid_input");
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "op", actualCost: -1 }), "invalid_input");
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "op", actualCost: 2.5 }), "invalid_input");
  assert.equal(await count(db, "credits_accounts"), 0);
  assert.equal(await count(db, "credits_operations"), 0);
  assert.equal(await count(db, "credits_ledger"), 0);
});

test("settlement cannot exceed the reservation and the audit trail is append-only", async (t) => {
  const db = await database(t);
  await grantCredits(db, { ownerId: "owner-a", amount: 50, operationId: "g" });
  await reserveCredits(db, { ownerId: "owner-a", amount: 20, operationId: "op-1" });
  await rejection(settleReservation(db, { ownerId: "owner-a", operationId: "op-1", actualCost: 21 }), "conflict");

  const entries = (await db.query("SELECT entry_type, status, amount, balance_after, reserved_after, created_at FROM credits_ledger ORDER BY id")).rows;
  assert.deepEqual(entries.map((entry) => [entry.entry_type, entry.status]).flat(), ["grant", "granted", "reserve", "reserved"]);
  assert.equal(Number(entries[1].reserved_after), 20);
  assert.ok(entries.every((entry) => entry.created_at instanceof Date));
  await assert.rejects(db.query("UPDATE credits_ledger SET amount = 0"), "append-only audit rows cannot be updated");
  await assert.rejects(db.query("DELETE FROM credits_ledger"), "append-only audit rows cannot be deleted");
});
