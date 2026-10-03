import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIAdapter, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT } from "../src/lib/models/providers/openai.ts";
import { createAnthropicAdapter, compileAnthropicRequest, ANTHROPIC_ADAPTER_VERSION, ANTHROPIC_REQUEST_FORMAT } from "../src/lib/models/providers/anthropic.ts";
import { adapterOutcome } from "../src/lib/models/execution-accounting/adapter-evidence.ts";
import { fixture } from "./fixtures/provider-accounting-contract.mjs";
import * as o from "./fixtures/openai-provider.mjs";
import * as a from "./fixtures/anthropic-provider.mjs";

function held(req, compile, adapterVersion, requestFormatVersion) {
  const compiled = compile(req);
  const f = fixture({ modelId: req.modelId, cacheTtl: req.cacheTtl ?? (req.modelId.startsWith("gpt-") ? "30m" : "5m"),
    budget: { maxInputTokens: req.maxInputTokens, maxOutputTokens: req.maxTokens }, review: { adapterVersion, requestFormatVersion } });
  const input = { ...f.input, requestHash: compiled.requestHash, bounds: { ...f.input.bounds, requestHash: compiled.requestHash } };
  const prepared = f.contract.prepare(input);
  const state = f.contract.hold(prepared, { holdId: "synthetic-hold", ownerId: prepared.ownerId, feature: prepared.feature,
    bindingFingerprint: prepared.bindingFingerprint, maxPriceNanoUsd: prepared.quote.reservationPriceNanoUsd, reservedCredits: prepared.quote.reservationCredits });
  return { ...f, state, compiled };
}
function submit(f) {
  const state = f.contract.submit(f.state, { expectedRevision: 0, dispatchId: "synthetic-dispatch", requestHash: f.compiled.requestHash, submittedAt: o.at });
  return { ...f, state, binding: { expectedRequestHash: f.compiled.requestHash, submittedAt: o.at } };
}
function decide(f, result) {
  return f.contract.decide(f.state, adapterOutcome(f.state, result, o.at), { expectedRevision: f.state.revision });
}
const openai = body => createOpenAIAdapter({ executionEnabled: true, getApiKey: () => "synthetic-key", now: () => "2026-10-03T08:00:00.000Z",
  fetch: async () => o.response(body) });
const anthropic = body => createAnthropicAdapter({ executionEnabled: true, getApiKey: () => "synthetic-key", now: () => "2026-10-03T08:00:00.000Z",
  fetch: async () => a.responseFrom(JSON.stringify(body), { contentType: "application/json" }) });

test("every OpenAI model's verified actual usage produces only a candidate separate from its quote", async () => {
  for (const modelId of o.models) {
    const req = o.request({ modelId }), f = submit(held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT));
    const result = await openai(o.envelope({ model: modelId })).complete(req, { binding: f.binding });
    assert.equal(result.status, "completed"); assert.equal(result.usage.at, o.at);
    const state = decide(f, result); assert.equal(state.phase, "candidate");
    assert.equal(state.decision.action, "settle_candidate"); assert.equal(state.decision.candidate.modelId, modelId);
    assert.equal(state.decision.candidate.reportedModelId, modelId);
    assert.equal(state.decision.candidate.usage.cacheWriteTokens, 300);
    assert.ok(result.providerCostNanoUsd < f.state.held.prepared.quote.reservationPriceNanoUsd);
    assert.equal(state.decision.candidate.priceNanoUsd, undefined); assert.equal(state.decision.candidate.ledgerReceiptId, undefined);
    assert.ok(!JSON.stringify(state).includes("synthetic_opaque_reasoning")); assert.ok(!JSON.stringify(state).includes("Inspect the fixture"));
    assert.throws(() => f.contract.submit(state, { expectedRevision: state.revision, dispatchId: "retry", requestHash: f.compiled.requestHash, submittedAt: o.at }));
  }
});
test("Anthropic 5m/1h actual usage remains distinct through adapter, evidence and candidate", async () => {
  const req = a.request({ modelId: "claude-opus-5-5", stream: false, cacheTtl: "1h" });
  const f = submit(held(req, compileAnthropicRequest, ANTHROPIC_ADAPTER_VERSION, ANTHROPIC_REQUEST_FORMAT));
  const body = a.jsonMessage({ model: req.modelId, usage: { input_tokens: 100, cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    output_tokens: 100, output_tokens_details: { thinking_tokens: 70 }, service_tier: "standard", inference_geo: "global" } });
  const result = await anthropic(body).complete(req, { binding: f.binding });
  assert.equal(result.providerCostNanoUsd, 4320000); assert.equal(result.usage.outputTokens, 100);
  const state = decide(f, result); assert.equal(state.phase, "candidate");
  assert.equal(state.decision.candidate.usage.cacheWrite5mTokens, 200); assert.equal(state.decision.candidate.usage.cacheWrite1hTokens, 100);
});
test("both verified refusals and truncations may yield attributable accounting candidates, with zero tool intents", async () => {
  const req = o.request(), cases = [o.envelope({ output: [{ ...o.text(), content: [{ type: "refusal", refusal: "Fixture" }] }] }),
    o.envelope({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [o.call({ status: "incomplete", arguments: "{" })] })];
  for (const body of cases) {
    const f = submit(held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT));
    const result = await openai(body).complete(req, { binding: f.binding });
    assert.deepEqual(result.toolCalls, []); assert.equal(decide(f, result).phase, "candidate");
  }
});
test("semantic failure with usageComplete=true cannot become a settlement candidate", async () => {
  const req = o.request(), f = submit(held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT));
  const result = await openai(o.envelope({ output: [o.call({ arguments: "[]" })] })).complete(req, { binding: f.binding });
  assert.equal(result.status, "failed"); assert.equal(result.usageComplete, true);
  const outcome = adapterOutcome(f.state, result, o.at); assert.equal(outcome.usage.kind, "unverified_final");
  const state = decide(f, result); assert.equal(state.phase, "retained"); assert.equal(state.decision.action, "retain_for_reconciliation");
});
test("mismatched request, provider, model, timestamp or format evidence cannot authorize actual settlement", async () => {
  const req = o.request(), f = submit(held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT));
  const result = await openai(o.envelope()).complete(req, { binding: f.binding });
  for (const extra of [{ requestHash: "b".repeat(64) }, { provider: "anthropic" }, { reportedModelId: o.models[1] },
    { submittedAt: "2026-10-03T08:00:00.000Z" }, { requestFormatVersion: "changed" }, { adapterVersion: "changed" }, { pricingProfile: "unreviewed" }]) {
    assert.equal(decide(f, { ...result, evidence: { ...result.evidence, ...extra } }).phase, "retained");
  }
});
test("disabled pre-dispatch outcomes may propose unused release; any saved claim retains the hold", async () => {
  const req = o.request(), f = held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT);
  const result = await createOpenAIAdapter().complete(req);
  assert.equal(decide(f, result).phase, "released");
  const claimed = submit(f), retained = decide(claimed, result);
  assert.equal(retained.phase, "retained"); assert.equal(retained.decision.reason, "submission_unknown");
  assert.equal(retained.held.reservedCredits, f.state.held.reservedCredits);
  assert.equal(f.state.held.prepared.quote.minimumReservationCredits, 2);
});
test("adapter request recheck blocks changed bytes before transport and preserves post-claim uncertainty", async () => {
  const req = o.request(), f = submit(held(req, compileOpenAIRequest, OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT));
  let calls = 0;
  const adapter = createOpenAIAdapter({ executionEnabled: true, getApiKey: () => "synthetic", fetch: async () => { calls++; throw Error(); } });
  const result = await adapter.complete({ ...req, system: "Changed after quote" }, { binding: f.binding });
  assert.equal(result.submission, "not_submitted"); assert.equal(calls, 0); assert.equal(decide(f, result).phase, "retained");
});
