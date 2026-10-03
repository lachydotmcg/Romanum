import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { getBalance, grantCredits } from "../src/lib/credits/ledger.ts";
import { reserveProviderAttempt, submitProviderAttempt, finishProviderAttempt, settleProviderAttempt, readProviderAttempt } from "../src/lib/credits/provider-attempts.ts";
import { costUsage } from "../src/lib/models/usage.ts";
import { fixture, AT, anthropicUsage, finalOutcome } from "./fixtures/provider-accounting-contract.mjs";

// Explicit local-only opt-in. Never use DATABASE_URL, discover credentials, provision
// Postgres, execute provider requests or apply migrations to shared/public tables.
// Set ROMANUM_PROVIDER_POSTGRES_TESTS=1 and exactly one task-specific target:
// ROMANUM_PROVIDER_POSTGRES_TEST_URL, or ROMANUM_PROVIDER_POSTGRES_TEST_CONFIG
// naming an existing JSON file containing {url}. The target must use loopback:55432.
const enabled = process.env.ROMANUM_PROVIDER_POSTGRES_TESTS === "1" &&
  !!(process.env.ROMANUM_PROVIDER_POSTGRES_TEST_URL || process.env.ROMANUM_PROVIDER_POSTGRES_TEST_CONFIG);
const options = { skip: enabled ? false : "Explicit ROMANUM_PROVIDER_POSTGRES_TESTS=1 and a local fixture target are required." };
const migrations = ["002_credits.sql", "010_usage.sql", "014_usage_holds.sql", "023_provider_attempts.sql"];
const schemaPrefix = "romanum_provider_pg_";
async function completeAll(operations) {
  // Finish every competing operation before fixture cleanup, including failures.
  const results = await Promise.allSettled(operations);
  const rejected = results.find(result => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results.map(result => result.value);
}
function validateSchema(schema) {
  if (!new RegExp(`^${schemaPrefix}[a-f0-9]{32}$`).test(schema)) throw new Error("Invalid disposable provider fixture schema.");
  return schema;
}
async function target() {
  const direct = process.env.ROMANUM_PROVIDER_POSTGRES_TEST_URL;
  const config = process.env.ROMANUM_PROVIDER_POSTGRES_TEST_CONFIG;
  if (!!direct === !!config) throw new Error("Provide exactly one task-specific PostgreSQL fixture target.");
  const connectionString = direct ?? JSON.parse(await readFile(config, "utf8")).url;
  let parsed;
  try { parsed = new URL(connectionString); } catch { throw new Error("Invalid PostgreSQL fixture target."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.port !== "55432" ||
      !/^\/[A-Za-z][A-Za-z0-9_]*$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error("PostgreSQL fixture target must be a loopback database on port 55432 without URL options.");
  }
  return connectionString;
}
async function database(t) {
  const connectionString = await target();
  const schema = validateSchema(`${schemaPrefix}${randomUUID().replaceAll("-", "")}`);
  const admin = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let pool, created = false;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.release();
    try { await pool?.end(); }
    finally {
      try {
        // This exact validated schema was freshly created by this fixture.
        if (created) await admin.query(`DROP SCHEMA "${validateSchema(schema)}" CASCADE`);
      } finally { await admin.end(); }
    }
  });
  await admin.query(`CREATE SCHEMA "${validateSchema(schema)}"`);
  created = true;
  pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000` });
  // Reserve independent physical connections for the entire test so races
  // cannot silently share a queued single-client transport as PGlite does.
  for (let i = 0; i < 6; i++) clients.push(await pool.connect());
  const identities = await completeAll(clients.map(client => client.query("SELECT pg_backend_pid() AS pid,current_schema() AS schema")));
  assert.equal(new Set(identities.map(result => result.rows[0].pid)).size, clients.length);
  assert.ok(identities.every(result => result.rows[0].schema === schema));
  const connections = clients.map(client => {
    const sql = { query: (text, values) => client.query(text, values), exec: async text => { await client.query(text); } };
    return { ...sql, close: async () => {}, transaction: async operation => {
      await client.query("BEGIN");
      try { const value = await operation(sql); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    } };
  });
  const db = connections[0];
  for (const migration of migrations) await db.exec(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"));
  return { db, connections };
}
function setup(ownerId = "synthetic-owner") {
  const f = fixture({ input: { attemptId: randomUUID(), ownerId } });
  return { ...f, prepared: f.contract.prepare(f.input) };
}
const fund = (db, ownerId = "synthetic-owner", amount = 100) => grantCredits(db, { ownerId, amount, operationId: `grant:${ownerId}` });
const count = async (db, table, where = "true") => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
const carry = async (db, ownerId = "synthetic-owner") => Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1", [ownerId])).rows[0]?.carry_nano_usd ?? 0);
const row = async (db, f) => (await db.query("SELECT * FROM provider_attempts WHERE attempt_id=$1", [f.prepared.attemptId])).rows[0];
async function submitted(db, f) {
  await reserveProviderAttempt(db, f.prepared, f.contract);
  return (await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).state;
}
function final(state, usage = anthropicUsage(), messageId = `msg:${state.held.prepared.attemptId}`) {
  const outcome = finalOutcome(state, usage);
  outcome.usage.provenance.providerMessageId = messageId;
  return outcome;
}
const finish = (db, f, outcome) => finishProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, outcome, f.contract);

test("PostgreSQL competing independent holds cannot overspend one account", options, async t => {
  const { db, connections } = await database(t), a = setup(), b = setup();
  const amount = a.prepared.quote.reservationCredits;
  await fund(db, a.prepared.ownerId, amount);
  const results = await Promise.allSettled([reserveProviderAttempt(connections[0], a.prepared, a.contract), reserveProviderAttempt(connections[1], b.prepared, b.contract)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "insufficient_balance");
  assert.deepEqual(await getBalance(db, { ownerId: a.prepared.ownerId }), { ownerId: a.prepared.ownerId, balance: amount, reserved: amount, available: 0 });
  assert.equal(await count(db, "provider_attempts"), 1);
  assert.equal(await count(db, "usage_holds"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type='reserve'"), 1);
});

test("PostgreSQL independent workers reserve and claim one identical durable attempt exactly once", options, async t => {
  const { db, connections } = await database(t), f = setup(); await fund(db);
  const reservations = await completeAll(connections.map(connection => reserveProviderAttempt(connection, f.prepared, f.contract)));
  assert.equal(new Set(reservations.map(state => state.held.holdId)).size, 1);
  assert.equal(await count(db, "provider_attempts"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type='reserve'"), 1);
  const claims = await completeAll(connections.map(connection => submitProviderAttempt(connection, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)));
  assert.equal(claims.filter(claim => claim.dispatch).length, 1);
  assert.equal(new Set(claims.map(claim => claim.state.submission.dispatchId)).size, 1);
  assert.equal(await readProviderAttempt(db, f.prepared.attemptId, "other-owner", f.contract), null);
});

test("PostgreSQL independent duplicate final callbacks capture once and return one price", options, async t => {
  const { db, connections } = await database(t), f = setup(); await fund(db);
  const state = await submitted(db, f), outcome = final(state);
  const results = await completeAll(connections.map(connection => finish(connection, f, outcome)));
  assert.ok(results.every(result => result.settled));
  assert.equal(results.filter(result => result.priceNanoUsd > 0).length, 1);
  assert.equal(results.reduce((sum, result) => sum + result.priceNanoUsd, 0), Math.round(costUsage(anthropicUsage()) * 2.5));
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "provider_final_claims"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 1);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, 0);
});

test("PostgreSQL cross-owner concurrent response claims charge globally once and retain the losing hold", options, async t => {
  const { db, connections } = await database(t), a = setup(), b = setup("other-owner");
  await fund(db); await fund(db, b.prepared.ownerId);
  const states = await completeAll([submitted(connections[0], a), submitted(connections[1], b)]);
  const outcomes = states.map(state => final(state, anthropicUsage(), "shared-response"));
  const results = await completeAll([finish(connections[0], a, outcomes[0]), finish(connections[1], b, outcomes[1])]);
  assert.equal(results.filter(result => result.settled).length, 1);
  assert.equal(results.filter(result => result.state.phase === "retained").length, 1);
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "provider_final_claims"), 1);
  const loserIndex = results.findIndex(result => !result.settled), loser = [a, b][loserIndex];
  const balance = await getBalance(db, { ownerId: loser.prepared.ownerId });
  assert.equal(balance.balance, 100); assert.equal(balance.reserved, loser.prepared.quote.reservationCredits);
  assert.equal(await carry(db, loser.prepared.ownerId), 0);
  assert.equal((await finish(db, loser, outcomes[loserIndex])).settled, false);
});

test("PostgreSQL concurrent distinct settlements serialize fractional carry without lost increments", options, async t => {
  const { db, connections } = await database(t); await fund(db);
  const fixtures = connections.map(() => setup());
  const states = await completeAll(connections.map((connection, i) => submitted(connection, fixtures[i])));
  const results = await completeAll(connections.map((connection, i) => finish(connection, fixtures[i], final(states[i]))));
  assert.ok(results.every(result => result.settled));
  const total = fixtures.length * Math.round(costUsage(anthropicUsage()) * 2.5), due = Math.floor(total / 10_000_000);
  assert.equal(results.reduce((sum, result) => sum + result.chargedCredits, 0), due);
  assert.equal(await carry(db), total % 10_000_000);
  assert.equal((await getBalance(db, { ownerId: "synthetic-owner" })).balance, 100 - due);
  assert.equal((await getBalance(db, { ownerId: "synthetic-owner" })).reserved, 0);
  assert.equal(await count(db, "usage_charges"), fixtures.length);
  assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), fixtures.length);
});

test("PostgreSQL failed capture retains final candidate and concurrent accounting-only retries charge once", options, async t => {
  const { db, connections } = await database(t), f = setup(); await fund(db);
  const state = await submitted(db, f), usage = anthropicUsage({ output_tokens: 1000 }), outcome = final(state, usage);
  const faulty = { ...db, transaction: operation => db.transaction(sql => operation({ ...sql, query: async (text, values) => {
    if (text.startsWith("INSERT INTO usage_charges")) throw new Error("synthetic capture interruption");
    return sql.query(text, values);
  } })) };
  await assert.rejects(finish(faulty, f, outcome), /synthetic capture interruption/);
  const candidate = await row(db, f);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.state.phase, "candidate");
  assert.equal(candidate.state.evidence.at(-1).usage.kind, "final");
  assert.equal(candidate.state.evidence.at(-1).usage.usage.outputTokens, 1000);
  assert.equal(candidate.usage_charge_id, null); assert.equal(candidate.ledger_receipt, null);
  assert.equal(await count(db, "provider_final_claims"), 1); assert.equal(await count(db, "usage_charges"), 0);
  assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 0); assert.equal(await carry(db), 0);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, f.prepared.quote.reservationCredits);
  assert.equal((await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).dispatch, false);
  const retries = await completeAll(connections.map(connection => settleProviderAttempt(connection, f.prepared.attemptId, f.prepared.ownerId, f.contract)));
  assert.ok(retries.every(result => result.settled));
  assert.equal(retries.reduce((sum, result) => sum + result.chargedCredits, 0), 5);
  assert.equal(retries.reduce((sum, result) => sum + result.priceNanoUsd, 0), Math.round(costUsage(usage) * 2.5));
  assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 1);
  assert.equal((await finish(db, f, outcome)).priceNanoUsd, 0);
});

test("PostgreSQL lost dispatch acknowledgement preserves committed claim and forbids concurrent replay", options, async t => {
  const { db, connections } = await database(t), f = setup(); await fund(db);
  await reserveProviderAttempt(db, f.prepared, f.contract);
  const acknowledgementLost = { ...db, transaction: async operation => {
    const result = await db.transaction(operation);
    if (result?.dispatch === true) throw new Error("synthetic committed dispatch acknowledgement lost");
    return result;
  } };
  await assert.rejects(submitProviderAttempt(acknowledgementLost, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT), /acknowledgement lost/);
  const saved = await readProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.contract);
  assert.equal(saved.phase, "submitted"); assert.ok(saved.submission.dispatchId);
  const replays = await completeAll(connections.map(connection => submitProviderAttempt(connection, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)));
  assert.ok(replays.every(result => !result.dispatch && result.state.submission.dispatchId === saved.submission.dispatchId));
  assert.equal(await count(db, "usage_charges"), 0);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, f.prepared.quote.reservationCredits);
});
