import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { CreditsError, getBalance, grantCredits } from "../src/lib/credits/ledger.ts";
import { reserveProviderAttempt, submitProviderAttempt, finishProviderAttempt, settleProviderAttempt, readProviderAttempt } from "../src/lib/credits/provider-attempts.ts";
import { costUsage, normalizeUsage } from "../src/lib/models/usage.ts";
import { createAccountingContract } from "../src/lib/models/execution-accounting/decision.ts";
import { adapterOutcome } from "../src/lib/models/execution-accounting/adapter-evidence.ts";
import { createOpenAIAdapter, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT } from "../src/lib/models/providers/openai.ts";
import { fixture, AT, anthropicUsage, finalOutcome, openaiUsage } from "./fixtures/provider-accounting-contract.mjs";
import * as o from "./fixtures/openai-provider.mjs";

// Ephemeral schema artifacts only: no app connection, provider, credential or
// environment access. PGlite serializes transactions; Promise.all exercises
// delivery races, not an independent PostgreSQL multi-process lock proof.
async function database(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "010_usage.sql", "014_usage_holds.sql", "023_provider_attempts.sql"]) {
    await db.exec(await readFile(path.join(process.cwd(), "db/migrations", file), "utf8"));
  }
  return db;
}
const count = async (db, table, where = "true", values = []) => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n;
const carry = async (db, owner) => Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1", [owner])).rows[0]?.carry_nano_usd ?? 0);
const row = async (db, id) => (await db.query("SELECT * FROM provider_attempts WHERE attempt_id=$1", [id])).rows[0];
const rejection = async (promise, code) => {
  const error = await promise.then(() => assert.fail("expected CreditsError"), e => e);
  assert.ok(error instanceof CreditsError, `${error?.name}: ${error?.message}`); assert.equal(error.code, code);
};
function setup(extra = {}) {
  const f = fixture({ ...extra, input: { attemptId: randomUUID(), ...extra.input } });
  return { ...f, prepared: f.contract.prepare(f.input) };
}
async function fund(db, ownerId = "synthetic-owner", amount = 100) { await grantCredits(db, { ownerId, amount, operationId: `grant:${ownerId}` }); }
async function submitted(db, f) {
  await reserveProviderAttempt(db, f.prepared, f.contract);
  return (await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).state;
}
function final(state, usage = anthropicUsage(), messageId = `msg:${state.held.prepared.attemptId}`) {
  const result = finalOutcome(state, usage); result.usage.provenance.providerMessageId = messageId; return result;
}
const finish = (db, f, outcome) => finishProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, outcome, f.contract);
const unreported = (state, submission = "uncertain") => ({ attemptId: state.held.prepared.attemptId, holdId: state.held.holdId,
  bindingFingerprint: state.held.bindingFingerprint, submission, result: "cancelled", observedAt: AT, usage: { kind: "none" } });

test("a historical prepared native attempt settles and replays at its original 1.65x price", async t => {
  const db = await database(t);
  const saved = JSON.parse(await readFile("tests/fixtures/legacy-pricing-v1.json", "utf8"));
  const f = { prepared: saved.prepared, contract: createAccountingContract(saved.policy) };
  await fund(db, f.prepared.ownerId);
  const state = await submitted(db, f);
  const result = await finish(db, f, final(state));
  assert.equal(result.priceNanoUsd, 7_128_000);
  assert.equal(result.chargedCredits, 0);
  assert.equal(await carry(db, f.prepared.ownerId), 7_128_000);
  const snapshot = await row(db, f.prepared.attemptId);
  const charge = (await db.query("SELECT * FROM usage_charges WHERE id=$1", [snapshot.usage_charge_id])).rows[0];
  assert.equal(charge.calls[0].pricingPolicyVersion, "legacy-credit-policy-v1");
  assert.equal(snapshot.state.decision.candidate.accountingPolicyVersion, "legacy-credit-policy-v1");
  assert.equal((await finish(db, f, final(state))).priceNanoUsd, 0);
  assert.deepEqual(await row(db, f.prepared.attemptId), snapshot);
  assert.equal(await count(db, "usage_charges"), 1);
});

test("exhausted accounts leave no attempt, hold or wallet mutation; no default reviewed policy", async t => {
  const db = await database(t), f = setup(); await fund(db, f.prepared.ownerId, 1);
  await assert.rejects(reserveProviderAttempt(db, f.prepared, createAccountingContract()), e => e.code === "unreviewed_bounds");
  await rejection(reserveProviderAttempt(db, f.prepared, f.contract), "insufficient_balance");
  assert.equal(await count(db, "provider_attempts"), 0); assert.equal(await count(db, "usage_holds"), 0);
  assert.equal(await count(db, "credits_operations"), 1); assert.equal(await count(db, "credits_ledger"), 1);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, 0);
});

test("concurrent reservation and durable dispatch are each exactly once and owner scoped", async t => {
  const db = await database(t), f = setup(); await fund(db);
  const reserved = await Promise.all(Array.from({ length: 6 }, () => reserveProviderAttempt(db, f.prepared, f.contract)));
  assert.equal(new Set(reserved.map(s => s.held.holdId)).size, 1);
  assert.equal(await count(db, "provider_attempts"), 1); assert.equal(await count(db, "usage_holds"), 1);
  assert.equal(await count(db, "credits_ledger", "entry_type='reserve'"), 1);
  const submissions = await Promise.all(Array.from({ length: 6 }, () => submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)));
  assert.equal(submissions.filter(s => s.dispatch).length, 1);
  assert.equal(new Set(submissions.map(s => s.state.submission.dispatchId)).size, 1);
  assert.equal((await row(db, f.prepared.attemptId)).state.phase, "submitted");
  assert.equal(await readProviderAttempt(db, f.prepared.attemptId, "other-owner", f.contract), null);
  await rejection(submitProviderAttempt(db, f.prepared.attemptId, "other-owner", f.prepared.requestHash, f.contract, AT), "not_found");
  await rejection(submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, "b".repeat(64), f.contract, AT), "conflict");
  const changed = setup({ input: { attemptId: f.prepared.attemptId, conversationId: "changed" } });
  await rejection(reserveProviderAttempt(db, changed.prepared, changed.contract), "conflict");
  assert.equal(await count(db, "credits_ledger", "entry_type='reserve'"), 1);
});

test("normalized cache categories, 2.5x pricing and carry charge once across concurrent callbacks", async t => {
  const db = await database(t); await fund(db);
  const a = setup(), s = await submitted(db, a), usage = anthropicUsage();
  const cost = costUsage(usage), price = Math.round(cost * 2.5);
  assert.equal(cost, 4_320_000); assert.equal(price, 10_800_000);
  const first = await Promise.all(Array.from({ length: 6 }, () => finish(db, a, final(s, usage))));
  assert.ok(first.every(r => r.settled)); assert.equal(first.reduce((n, r) => n + r.chargedCredits, 0), 1);
  assert.equal(first.filter(r => r.priceNanoUsd > 0).length, 1);
  assert.equal(first.reduce((n, r) => n + r.priceNanoUsd, 0), price);
  assert.equal(await carry(db, "synthetic-owner"), 800_000);
  assert.equal(await count(db, "usage_charges"), 1); assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 1);
  const b = setup(), bs = await submitted(db, b);
  const callbacks = await Promise.all(Array.from({ length: 6 }, () => finish(db, b, final(bs, usage))));
  assert.equal(callbacks.reduce((n, r) => n + r.chargedCredits, 0), 1);
  assert.equal(await carry(db, "synthetic-owner"), 1_600_000);
  assert.equal((await getBalance(db, { ownerId: "synthetic-owner" })).balance, 98);
  assert.equal((await getBalance(db, { ownerId: "synthetic-owner" })).reserved, 0);
  const saved = await row(db, b.prepared.attemptId), charge = (await db.query("SELECT * FROM usage_charges WHERE id=$1", [saved.usage_charge_id])).rows[0];
  assert.equal(charge.calls[0].cacheWrite5mTokens, 200); assert.equal(charge.calls[0].cacheWrite1hTokens, 100);
  assert.equal(charge.calls[0].format, "normalized-usage-v1"); assert.equal(charge.calls[0].model, usage.modelId);
  // Mirrors the existing admin SQL projection: each stored call contributes
  // once despite its additional normalized accounting fields.
  const projection = (await db.query("SELECT sum((call->>'input')::numeric) AS input,sum((call->>'output')::numeric) AS output FROM usage_charges CROSS JOIN LATERAL jsonb_array_elements(calls) AS call")).rows[0];
  assert.equal(Number(projection.input), 200); assert.equal(Number(projection.output), 200);
  assert.equal(saved.candidate_fingerprint, callbacks[0].state.decision.candidate.fingerprint);
  assert.equal(saved.ledger_receipt.candidateFingerprint, saved.candidate_fingerprint);
  assert.match(saved.ledger_receipt.ledgerReceiptId, /^ledger:\d+$/);
  const laterReplay = { ...final(bs, usage), observedAt: "2026-10-02T08:00:00.000Z" };
  const replay = await finish(db, b, laterReplay); assert.equal(replay.chargedCredits, 0); assert.equal(replay.priceNanoUsd, 0);
  const changed = final(bs, anthropicUsage({ output_tokens: 101 }));
  await rejection(finish(db, b, changed), "conflict");
  assert.equal(await count(db, "usage_charges"), 2); assert.equal(await carry(db, "synthetic-owner"), 1_600_000);
});

test("distinct 5m, 1h and OpenAI cache write prices settle without flattened categories or reasoning add-ons", async t => {
  const db = await database(t); await fund(db);
  const variants = [
    { modelId: "claude-opus-5-5", cacheTtl: "5m", raw: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } }, cost: 5_020_000 },
    { modelId: "claude-opus-5-5", cacheTtl: "1h", raw: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }, cost: 8_020_000 },
    { modelId: "gpt-6.1-sol", cacheTtl: "30m", usage: openaiUsage(), cost: 2_010_000 },
    { modelId: "gpt-6-luna", cacheTtl: "30m", raw: { input_tokens: 1, output_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 } }, cost: 125 },
  ];
  for (const variant of variants) {
    const f = setup({ modelId: variant.modelId, cacheTtl: variant.cacheTtl }), state = await submitted(db, f);
    const usage = variant.usage ?? normalizeUsage(variant.modelId, variant.raw, { at: AT, cacheTtl: variant.cacheTtl });
    assert.equal(costUsage(usage), variant.cost);
    const result = await finish(db, f, final(state, usage)); assert.equal(result.settled, true);
    const charge = (await db.query("SELECT cost_nano_usd,price_nano_usd FROM usage_charges WHERE id=$1", [(await row(db, f.prepared.attemptId)).usage_charge_id])).rows[0];
    assert.equal(Number(charge.cost_nano_usd), variant.cost); assert.equal(Number(charge.price_nano_usd), Math.round(variant.cost * 2.5));
    assert.equal(result.priceNanoUsd, Math.round(variant.cost * 2.5));
  }
});

test("global provider response claim blocks duplicate charging across owners and keeps later reservation", async t => {
  const db = await database(t); await fund(db); await fund(db, "other-owner");
  const a = setup(), b = setup({ input: { ownerId: "other-owner" } });
  const sa = await submitted(db, a), sb = await submitted(db, b);
  const results = await Promise.all([finish(db, a, final(sa, anthropicUsage(), "shared-message")), finish(db, b, final(sb, anthropicUsage(), "shared-message"))]);
  assert.equal(results.filter(r => r.settled).length, 1); assert.equal(results.filter(r => r.state.phase === "retained").length, 1);
  assert.equal(await count(db, "provider_final_claims"), 1); assert.equal(await count(db, "usage_charges"), 1);
  const retainedIndex = results.findIndex(r => !r.settled), later = [a, b][retainedIndex], ls = [sa, sb][retainedIndex];
  assert.equal((await getBalance(db, { ownerId: later.prepared.ownerId })).reserved, later.prepared.quote.reservationCredits);
  assert.equal(await carry(db, later.prepared.ownerId), 0);
  assert.equal((await finish(db, later, final(ls, anthropicUsage(), "shared-message"))).settled, false);
});

test("uncertain outcomes retain, cannot redispatch or release, and may reconcile from final attributed usage", async t => {
  const db = await database(t); await fund(db); const f = setup(), state = await submitted(db, f);
  const retained = await finish(db, f, unreported(state)); assert.equal(retained.state.phase, "retained");
  assert.equal((await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).dispatch, false);
  const cancelled = await finish(db, f, unreported(state, "not_submitted")); assert.equal(cancelled.state.phase, "retained");
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, f.prepared.quote.reservationCredits);
  const reconciled = await finish(db, f, final(state)); assert.equal(reconciled.settled, true);
  assert.equal(await count(db, "usage_charges"), 1);
});

test("definite undispatched cancellation releases once while a persisted dispatch claim always retains", async t => {
  const db = await database(t); await fund(db); const f = setup(), state = await reserveProviderAttempt(db, f.prepared, f.contract);
  const outcome = unreported(state, "not_submitted");
  const results = await Promise.all(Array.from({ length: 5 }, () => finish(db, f, outcome)));
  assert.ok(results.every(r => r.state.phase === "released"));
  assert.equal(await count(db, "credits_ledger", "entry_type='release'"), 1);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, 0);
  assert.equal((await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).dispatch, false);
  const g = setup(), gs = await submitted(db, g); await finish(db, g, unreported(gs, "not_submitted"));
  assert.equal((await readProviderAttempt(db, g.prepared.attemptId, g.prepared.ownerId, g.contract)).phase, "retained");
  assert.equal(await count(db, "credits_ledger", "entry_type='release'"), 1);
});

test("overbound and identity/pricing mismatches retain without claim, carry or settlement", async t => {
  const db = await database(t); await fund(db);
  for (const mutate of [
    outcome => { outcome.usage.usage.outputTokens = 1001; },
    outcome => { outcome.usage.provenance.reportedModelId = "gpt-6-astra"; },
    outcome => { outcome.usage.provenance.requestHash = "b".repeat(64); },
    outcome => { outcome.usage.provenance.unsupportedCharges = true; },
  ]) {
    const f = setup(), state = await submitted(db, f), outcome = final(state); mutate(outcome);
    const result = await finish(db, f, outcome); assert.equal(result.state.phase, "retained"); assert.equal(result.settled, false);
    assert.equal((await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).dispatch, false);
  }
  assert.equal(await count(db, "provider_final_claims"), 0); assert.equal(await count(db, "usage_charges"), 0); assert.equal(await count(db, "usage_carry"), 0);
});

test("adapter evidence crosses the durable bridge without private output, continuation or diagnostics", async t => {
  const db = await database(t); await fund(db);
  const req = o.request({ modelId: "gpt-6.1-sol" }), compiled = compileOpenAIRequest(req);
  const f = setup({ modelId: req.modelId, cacheTtl: "30m", review: { adapterVersion: OPENAI_ADAPTER_VERSION, requestFormatVersion: OPENAI_REQUEST_FORMAT },
    budget: { maxInputTokens: req.maxInputTokens, maxOutputTokens: req.maxTokens }, input: { requestHash: compiled.requestHash,
      bounds: { strategyId: "synthetic-bound", strategyVersion: "1", requestHash: compiled.requestHash, capabilities: ["text"],
        budget: { inputTokens: 1000, maxInputTokens: req.maxInputTokens, outputTokens: 100, maxOutputTokens: req.maxTokens, cacheTtl: "30m" } } } });
  const state = await submitted(db, f);
  const result = await createOpenAIAdapter({ executionEnabled: true, getApiKey: () => "PRIVATE_SYNTHETIC_KEY",
    fetch: async () => o.response(o.envelope({ model: req.modelId })) }).complete(req, { binding: { expectedRequestHash: compiled.requestHash, submittedAt: AT } });
  const outcome = adapterOutcome(state, result, AT), settled = await finish(db, f, outcome); assert.equal(settled.settled, true);
  const stored = JSON.stringify((await db.query("SELECT * FROM provider_attempts")).rows) + JSON.stringify((await db.query("SELECT * FROM usage_charges")).rows);
  for (const privateText of ["PRIVATE_SYNTHETIC_KEY", "synthetic_opaque_reasoning", "Inspect the fixture", "Synthetic café response"]) assert.ok(!stored.includes(privateText));
});

test("stored snapshots and caller DTOs validate before any wallet action", async t => {
  const db = await database(t); await fund(db); const f = setup(), state = await submitted(db, f);
  const outcome = final(state); outcome.privatePrompt = "PRIVATE";
  await assert.rejects(finish(db, f, outcome), e => e.code === "invalid_shape");
  await db.query("UPDATE provider_attempts SET state=jsonb_set(state,'{revision}','99') WHERE attempt_id=$1", [f.prepared.attemptId]);
  await assert.rejects(readProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.contract), e => e.code === "invalid_shape");
  await assert.rejects(submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT), e => e.code === "invalid_shape");
  await assert.rejects(finish(db, f, final(state)), e => e.code === "invalid_shape");
  assert.equal(await count(db, "usage_charges"), 0); assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 0);
});

test("ledger failure preserves final usage, candidate and response claim; explicit accounting retry charges once", async t => {
  const db = await database(t); await fund(db); const f = setup(), state = await submitted(db, f);
  const outcome = final(state, anthropicUsage({ output_tokens: 1000 }));
  const faulty = { ...db, transaction: operation => db.transaction(sql => operation({ ...sql, query: async (text, values) => {
    if (text.startsWith("INSERT INTO usage_charges")) throw new Error("synthetic storage interruption");
    return sql.query(text, values);
  } })) };
  await assert.rejects(finish(faulty, f, outcome), /synthetic storage interruption/);
  assert.equal(await count(db, "provider_final_claims"), 1); assert.equal(await count(db, "usage_charges"), 0);
  assert.equal(await count(db, "usage_carry"), 0); assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 0);
  const candidate = await readProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.contract);
  assert.equal(candidate.phase, "candidate"); assert.equal(candidate.evidence.at(-1).usage.kind, "final");
  assert.equal(candidate.evidence.at(-1).usage.usage.outputTokens, 1000);
  assert.equal(candidate.decision.candidate.providerMessageId, outcome.usage.provenance.providerMessageId);
  const stored = await row(db, f.prepared.attemptId); assert.equal(stored.status, "candidate");
  assert.equal(stored.ledger_receipt, null); assert.equal(stored.usage_charge_id, null);
  assert.equal(stored.candidate_fingerprint, candidate.decision.candidate.fingerprint);
  assert.equal((await reserveProviderAttempt(db, f.prepared, f.contract)).phase, "candidate");
  assert.equal((await submitProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.prepared.requestHash, f.contract, AT)).dispatch, false);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).reserved, f.prepared.quote.reservationCredits);
  assert.equal((await getBalance(db, { ownerId: f.prepared.ownerId })).balance, 100);
  const duplicate = setup(), duplicateState = await submitted(db, duplicate);
  const blocked = await finish(db, duplicate, final(duplicateState, anthropicUsage({ output_tokens: 1000 }), outcome.usage.provenance.providerMessageId));
  assert.equal(blocked.state.phase, "retained"); assert.equal(blocked.settled, false);
  assert.equal(await count(db, "usage_charges"), 0); assert.equal(await count(db, "provider_final_claims"), 1);
  await rejection(settleProviderAttempt(db, f.prepared.attemptId, "other-owner", f.contract), "not_found");
  await assert.rejects(settleProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, createAccountingContract()), e => e.code === "unreviewed_bounds");
  const retries = await Promise.all(Array.from({ length: 5 }, () => settleProviderAttempt(db, f.prepared.attemptId, f.prepared.ownerId, f.contract)));
  assert.ok(retries.every(r => r.settled)); assert.equal(retries.reduce((n, r) => n + r.chargedCredits, 0), 5);
  assert.equal(retries.reduce((n, r) => n + r.priceNanoUsd, 0), Math.round(costUsage(anthropicUsage({ output_tokens: 1000 })) * 2.5));
  assert.equal(await count(db, "usage_charges"), 1); assert.equal(await count(db, "credits_ledger", "entry_type='capture'"), 1);
  assert.equal((await finish(db, f, outcome)).priceNanoUsd, 0);
});

test("matching callback retries candidate accounting only and conflicting pending callback cannot replace evidence", async t => {
  const db = await database(t); await fund(db); const f = setup(), state = await submitted(db, f), outcome = final(state);
  const faulty = { ...db, transaction: operation => db.transaction(sql => operation({ ...sql, query: async (text, values) => {
    if (text.startsWith("INSERT INTO usage_charges")) throw new Error("synthetic storage interruption");
    return sql.query(text, values);
  } })) };
  await assert.rejects(finish(faulty, f, outcome), /synthetic storage interruption/);
  const pending = await row(db, f.prepared.attemptId);
  await rejection(finish(db, f, final(state, anthropicUsage({ output_tokens: 101 }))), "conflict");
  assert.deepEqual((await row(db, f.prepared.attemptId)).state, pending.state);
  const retry = await finish(db, f, { ...outcome, observedAt: "2026-10-02T08:00:00.000Z" });
  assert.equal(retry.settled, true); assert.equal(retry.priceNanoUsd, 10_800_000);
  assert.equal(retry.chargedCredits, 1); assert.equal(await count(db, "usage_charges"), 1);
  assert.equal(await count(db, "provider_final_claims"), 1);
  const unused = setup(); await reserveProviderAttempt(db, unused.prepared, unused.contract);
  await rejection(settleProviderAttempt(db, unused.prepared.attemptId, unused.prepared.ownerId, unused.contract), "invalid_operation");
});
