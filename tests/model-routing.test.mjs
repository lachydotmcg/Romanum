import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG } from "../src/lib/models/catalog.ts";
import { quoteModel, reservationCredits } from "../src/lib/models/estimate.ts";
import { readModelReadiness } from "../src/lib/models/readiness.ts";
import { parseModelSelection, routeModel } from "../src/lib/models/route.ts";
import { costUsage, normalizeUsage } from "../src/lib/models/usage.ts";
const at = "2026-10-02T12:00:00.000Z";
const budget = { inputTokens: 1000, maxInputTokens: 2000, outputTokens: 500, maxOutputTokens: 4000 };
const request = (extra = {}) => ({ selection: { mode: "auto" }, availableCredits: 10, budget, at, ...extra });
// Review overrides simulate later integration approval; they create no clients or calls.
const ready = (ids = MODEL_CATALOG.map((model) => model.id)) => readModelReadiness({
  DEEPSEEK_API_KEY: "fixture", OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture",
}, Object.fromEntries(ids.map((id) => [id, { adapterSupported: true, executionEnabled: true }])));
const explicit = (modelId) => ({ mode: "explicit", modelId });
const binding = { ownerId: "owner-a", conversationId: "chat-a", modelId: "gpt-6.1-sol", provider: "openai",
  prefixHash: "a".repeat(64), toolSchemaHash: "b".repeat(64), settingsHash: "c".repeat(64) };
const cache = { binding, observedAt: "2026-10-02T11:55:00.000Z", expiresAt: "2026-10-02T12:25:00.000Z", cacheReadTokens: 100000 };

test("Auto selects a ready affordable compatible model; new models are disabled by the actual defaults", () => {
  const auto = routeModel(request(), ready());
  assert.equal(auto.status, "selected");
  assert.equal(auto.modelId, "gpt-6-luna");
  assert.ok(auto.quote.reservationCredits <= 10);
  const defaults = routeModel(request(), readModelReadiness({ DEEPSEEK_API_KEY: "fixture", OPENAI_API_KEY: "fixture" }));
  assert.equal(defaults.modelId, "deepseek-flash");
  assert.equal(routeModel(request(), readModelReadiness({ OPENAI_API_KEY: "fixture" })).reason, "no_ready_model");
  assert.equal(routeModel(request({ capabilities: { images: true } }), ready(["deepseek-v4-pro"])).reason, "capability_mismatch");
});

test("explicit choice persists; an unaffordable frontier choice offers a clearly separate fallback", () => {
  const selected = routeModel(request({ selection: explicit("gpt-6.1-sol"), availableCredits: 100 }), ready());
  assert.equal(selected.status, "selected");
  assert.equal(selected.modelId, "gpt-6.1-sol");
  assert.equal(selected.reason, "explicit_selection");
  const blocked = routeModel(request({ selection: explicit("gpt-6-astra"), availableCredits: 3 }), ready());
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.modelId, "gpt-6-astra");
  assert.equal(blocked.reason, "insufficient_balance");
  assert.equal(blocked.fallback.modelId, "gpt-6-luna");
  assert.equal(blocked.fallback.reason, "affordable_alternative");
  assert.equal(routeModel(request({ selection: explicit("gpt-6-astra") }), ready(["deepseek-flash"])).reason, "model_unavailable");
  const proImages = routeModel(request({ selection: explicit("deepseek-v4-pro"), capabilities: { images: true } }), ready());
  assert.equal(proImages.status, "blocked");
  assert.equal(proImages.reason, "capability_mismatch");
});

test("forged IDs, injected configuration and unsupported capabilities cannot become a route", () => {
  for (const selection of [explicit("invented"), { mode: "auto", apiKey: "injection" }, { mode: "explicit", modelId: "gpt-6-luna", baseURL: "https://internal" }, "auto", null]) {
    assert.equal(parseModelSelection(selection), null);
    assert.equal(routeModel(request({ selection }), ready()).reason, "invalid_selection");
  }
  assert.equal(routeModel(request({ capabilities: { video: true } }), ready()).reason, "invalid_request");
  const inconsistent = ready().map((model) => ({ ...model, configured: false }));
  assert.equal(routeModel(request(), inconsistent).reason, "no_ready_model");
  assert.equal(routeModel(request(), [...ready(), ...ready()]).reason, "no_ready_model");
});

test("low balances obey the unchanged ceil-plus-one hold policy; zero/one credit cannot be promised usable", () => {
  assert.equal(reservationCredits(1), 2);
  assert.equal(reservationCredits(10000000), 2);
  assert.equal(reservationCredits(10000001), 3);
  for (const availableCredits of [0, 1]) {
    const decision = routeModel(request({ availableCredits }), ready());
    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "minimum_hold");
    assert.equal(decision.fallback, null);
  }
  const cheap = routeModel(request({ availableCredits: 2 }), ready());
  assert.equal(cheap.status, "selected");
  assert.equal(cheap.modelId, "gpt-6-luna");
  assert.equal(cheap.quote.minimumReservationCredits, 2);
  assert.equal(routeModel(request({ availableCredits: -1 }), ready()).reason, "invalid_request");
  assert.equal(routeModel(request({ budget: { ...budget, inputTokens: 3000 } }), ready()).reason, "invalid_request");
});

test("quotes cover a cache miss/write even after an observed hit, and cover DeepSeek peak-boundary crossings", () => {
  const large = { inputTokens: 100000, maxInputTokens: 100000, outputTokens: 0, maxOutputTokens: 1 };
  const quote = quoteModel("gpt-6.1-sol", large, { at, cacheBinding: binding, cacheObservations: [cache] });
  assert.equal(quote.estimateBasis, "compatible_cache_scenario");
  assert.equal(quote.cacheHitGuaranteed, false);
  const miss = normalizeUsage("gpt-6.1-sol", { input_tokens: 100000, output_tokens: 1,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, { at });
  const write = normalizeUsage("gpt-6.1-sol", { input_tokens: 100000, output_tokens: 1,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100000 } }, { at });
  assert.ok(costUsage(miss) > quote.estimatedCostNanoUsd);
  assert.ok(Math.ceil(costUsage(write) * 1.65) <= quote.reservationPriceNanoUsd);
  assert.ok(Math.ceil(costUsage(miss) * 1.65) <= quote.reservationPriceNanoUsd);
  const flash = quoteModel("deepseek-flash", budget, { at }); // noon: off-peak estimate, peak ceiling.
  const peak = normalizeUsage("deepseek-flash", { prompt_tokens: 2000, completion_tokens: 4000 }, { at: "2026-10-02T07:00:00.000Z" });
  assert.ok(Math.ceil(costUsage(peak) * 1.65) <= flash.reservationPriceNanoUsd);
  const anthropic = quoteModel("claude-opus-5-5", { ...budget, cacheTtl: "1h" }, { at });
  const created = normalizeUsage("claude-opus-5-5", { input_tokens: 0, cache_creation_input_tokens: 2000, output_tokens: 4000 }, { at, cacheTtl: "1h" });
  assert.ok(Math.ceil(costUsage(created) * 1.65) <= anthropic.reservationPriceNanoUsd);
});

test("compatible cache scenarios affect Auto ranking only when their worst-case reservation is affordable", () => {
  const large = { inputTokens: 100000, maxInputTokens: 100000, outputTokens: 0, maxOutputTokens: 1 };
  const hint = request({ budget: large, availableCredits: 100, cacheBinding: binding, cacheObservations: [cache] });
  const chosen = routeModel(hint, ready(["gpt-6.1-sol", "deepseek-v4-pro"]));
  assert.equal(chosen.modelId, "gpt-6.1-sol");
  assert.equal(chosen.reason, "auto_cache_scenario");
  const mismatch = routeModel({ ...hint, cacheObservations: [{ ...cache, binding: { ...binding, ownerId: "owner-b" } }] }, ready(["gpt-6.1-sol", "deepseek-v4-pro"]));
  assert.equal(mismatch.modelId, "deepseek-v4-pro");
  const unaffordable = routeModel({ ...hint, availableCredits: 25 }, ready(["gpt-6.1-sol", "deepseek-v4-pro"]));
  assert.equal(unaffordable.modelId, "deepseek-v4-pro");
  const latestMiss = { ...cache, observedAt: "2026-10-02T11:59:00.000Z", cacheReadTokens: 0 };
  assert.equal(routeModel({ ...hint, cacheObservations: [cache, latestMiss] }, ready(["gpt-6.1-sol", "deepseek-v4-pro"])).modelId, "deepseek-v4-pro");
});

test("reviewed request bounds and cache TTL settings fail closed", () => {
  assert.equal(routeModel(request({ budget: { ...budget, maxInputTokens: 200000 } }), ready()).reason, "context_limit");
  assert.equal(routeModel(request({ budget: { ...budget, maxOutputTokens: 16001 } }), ready()).reason, "context_limit");
  assert.equal(routeModel(request({ budget: { ...budget, cacheTtl: "forever" } }), ready()).reason, "invalid_request");
  assert.equal(routeModel(request({ selection: explicit("gpt-6-luna"), budget: { ...budget, cacheTtl: "1h" } }), ready()).reason, "invalid_request");
});
