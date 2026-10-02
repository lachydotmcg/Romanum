// Synthetic accounting fixtures only: no credentials, prompts, recorded provider data or DB.
import { normalizeUsage } from "../../src/lib/models/usage.ts";
import { quoteModel } from "../../src/lib/models/estimate.ts";
import { getModel } from "../../src/lib/models/catalog.ts";
import { createAccountingContract } from "../../src/lib/models/execution-accounting/decision.ts";

export const AT = "2026-10-02T07:00:00.000Z";
export const REQUEST_HASH = "a".repeat(64);
export const OTHER_HASH = "b".repeat(64);
export const OPUS = "claude-opus-5-5";

/** Explicit synthetic review only; the product ships with no bound review in this module. */
export function fixture(options = {}) {
  const modelId = options.modelId ?? OPUS;
  const model = getModel(modelId);
  const budget = { inputTokens: 1000, maxInputTokens: 2000, outputTokens: 100,
    maxOutputTokens: 1000, cacheTtl: options.cacheTtl ?? model.cacheTtls.at(-1), ...options.budget };
  const review = { strategyId: "synthetic-bound", strategyVersion: "1", provider: model.provider,
    modelId, adapterVersion: "synthetic-adapter-v1", requestFormatVersion: "synthetic-request-v1",
    capabilities: ["text", "tools", "images"], cacheTtls: [...model.cacheTtls],
    maxInputTokens: 10000, maxOutputTokens: 1000, ...options.review };
  const policy = { reviewedBounds: [review] };
  const contract = createAccountingContract(policy);
  const input = { version: 1, attemptId: "00000000-0000-4000-8000-000000000001", ownerId: "synthetic-owner",
    feature: "chat", conversationId: "synthetic-conversation", runId: "synthetic-run", step: 0,
    selection: { mode: "explicit", modelId }, modelId, provider: model.provider,
    adapterVersion: review.adapterVersion, requestFormatVersion: review.requestFormatVersion,
    requestHash: REQUEST_HASH,
    bounds: { strategyId: review.strategyId, strategyVersion: review.strategyVersion,
      requestHash: REQUEST_HASH, capabilities: ["text"], budget },
    pricingProfile: "standard-global-text-v1", quote: quoteModel(modelId, budget, { at: AT }), preparedAt: AT,
    ...options.input };
  return { contract, input, policy, review };
}

export function heldFixture(options = {}) {
  const base = fixture(options);
  const prepared = base.contract.prepare(base.input);
  const hold = { holdId: "00000000-0000-4000-8000-000000000002",
    ownerId: prepared.ownerId, feature: prepared.feature,
    maxPriceNanoUsd: prepared.quote.reservationPriceNanoUsd,
    reservedCredits: prepared.quote.reservationCredits, bindingFingerprint: prepared.bindingFingerprint };
  return { ...base, prepared, hold, state: base.contract.hold(prepared, hold) };
}

export function submittedFixture(options = {}) {
  const base = heldFixture(options);
  const submission = { expectedRevision: base.state.revision,
    dispatchId: "00000000-0000-4000-8000-000000000003", requestHash: REQUEST_HASH, submittedAt: AT };
  return { ...base, submission, state: base.contract.submit(base.state, submission) };
}

export function finalOutcome(state, usage = anthropicUsage()) {
  const { prepared, holdId, bindingFingerprint } = state.held;
  return { attemptId: prepared.attemptId, holdId, bindingFingerprint,
    submission: "submitted", result: "completed", observedAt: AT,
    usage: { kind: "final", usage, provenance: { source: "adapter_completed",
      adapterVersion: prepared.adapterVersion, provider: prepared.provider,
      providerMessageId: "synthetic-message-001", reportedModelId: prepared.modelId,
      requestHash: prepared.requestHash, dispatchId: state.submission.dispatchId,
      rateCardVersion: prepared.quote.rateCardVersion, pricingProfile: prepared.pricingProfile,
      terminalEvent: "completed", unsupportedCharges: false } } };
}

export function anthropicUsage(overrides = {}) {
  return normalizeUsage(OPUS, {
    input_tokens: 100,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    output_tokens: 100,
    ...overrides,
  }, { at: AT });
}

export function oneHourUsage() {
  return anthropicUsage({ input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    output_tokens: 0 });
}

export function openaiUsage(modelId = "gpt-6.1-sol") {
  return normalizeUsage(modelId, { input_tokens: 1000, output_tokens: 100,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    output_tokens_details: { reasoning_tokens: 70 } }, { at: AT });
}

export function deepseekUsage() {
  return normalizeUsage("deepseek-flash", { prompt_tokens: 1000, completion_tokens: 100,
    prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400,
    completion_tokens_details: { reasoning_tokens: 70 } }, { at: AT });
}

/** Reproduces the released wrapper's missing model check without any provider work. */
export function legacyMismatchedStream() {
  const events = [];
  const billing = {
    async reserve() { events.push("reserve"); return "synthetic-hold"; },
    async settle(id, call) { events.push({ settle: id, call }); },
    async finish(id, uncertain) { events.push({ finish: id, uncertain }); },
  };
  const client = { chat: { completions: { async create() {
    events.push("provider-stub");
    return (async function* () {
      yield { id: "synthetic-message", model: "gpt-6-astra", choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    })();
  } } } };
  const params = { model: "deepseek-flash", messages: [{ role: "user", content: "fixture" }],
    max_tokens: 1, stream: true };
  return { events, billing, client, params };
}
