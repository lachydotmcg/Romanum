import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, RATE_CARD_CHECKED_AT, RATE_CARD_VERSION, getModel } from "../src/lib/models/catalog.ts";
import { MODEL_IDS } from "../src/lib/models/types.ts";
import { publicModels, readModelReadiness } from "../src/lib/models/readiness.ts";

const environment = () => ({ DEEPSEEK_API_KEY: "fixture-deepseek", OPENAI_API_KEY: "fixture-openai", ANTHROPIC_API_KEY: "fixture-anthropic" });
test("catalog IDs, standard prices and provenance are explicit and immutable", () => {
  assert.deepEqual(MODEL_CATALOG.map((model) => model.id), [...MODEL_IDS]);
  assert.equal(getModel("claude-haiku-4-5-20251001").rates.cacheWrite1h, 2);
  assert.equal(getModel("gpt-6.1-sol").rates.cacheRead, 0.1);
  assert.equal(getModel("deepseek-v4-pro").capabilities.images, false);
  assert.equal(getModel("invented-frontier-model"), null);
  assert.equal(getModel({ toString: () => "gpt-6-astra" }), null);
  for (const model of MODEL_CATALOG) {
    assert.equal(model.rateCardVersion, RATE_CARD_VERSION);
    assert.equal(model.checkedAt, RATE_CARD_CHECKED_AT);
    for (const source of Object.values(model.sources)) assert.match(source, /^https:\/\//);
    assert.ok(Object.isFrozen(model) && Object.isFrozen(model.rates) && Object.isFrozen(model.capabilities));
  }
  assert.throws(() => { getModel("gpt-6.1-sol").rates.input = 0; }, TypeError);
});

test("missing keys and disabled adapters are distinct; key presence cannot enable new execution", () => {
  const missing = readModelReadiness({});
  assert.ok(missing.every((model) => !model.configured && !model.selectable && model.reason === "missing_key"));
  const configured = readModelReadiness(environment());
  const flash = configured.find((model) => model.modelId === "deepseek-flash");
  assert.equal(flash.selectable, true);
  assert.equal(flash.entitlementVerified, false);
  for (const model of configured.filter((model) => model.modelId !== "deepseek-flash")) {
    assert.equal(model.configured, true);
    assert.equal(model.adapterSupported, false);
    assert.equal(model.executionEnabled, false);
    assert.equal(model.selectable, false);
    assert.equal(model.reason, "adapter_not_supported");
    assert.equal(model.entitlementVerified, false);
  }
  const supported = readModelReadiness(environment(), { "gpt-6.1-sol": { adapterSupported: true, executionEnabled: false } });
  assert.equal(supported.find((model) => model.modelId === "gpt-6.1-sol").reason, "execution_disabled");
  assert.equal(readModelReadiness({ DEEPSEEK_API_KEY: "   " })[0].reason, "missing_key");
});

test("key removal is observed on the next invocation; public output contains only catalog and safe status", () => {
  const fixture = environment();
  assert.equal(readModelReadiness(fixture)[0].selectable, true);
  delete fixture.DEEPSEEK_API_KEY;
  assert.equal(readModelReadiness(fixture)[0].selectable, false);
  const response = publicModels({ ...environment(), PRIVATE_DIAGNOSTIC: "must-never-leak" });
  const json = JSON.stringify(response);
  for (const forbidden of ["fixture-deepseek", "fixture-openai", "fixture-anthropic", "must-never-leak", "API_KEY", "PRIVATE_DIAGNOSTIC"]) {
    assert.ok(!json.includes(forbidden));
  }
  assert.deepEqual(Object.keys(response).sort(), ["models", "rateCardVersion"]);
  assert.ok(response.models.every((model) => typeof model.configured === "boolean" && typeof model.selectable === "boolean"));
});

test("readiness refuses a browser environment instead of inspecting credentials there", () => {
  globalThis.window = {};
  try { assert.throws(() => publicModels(environment()), /server-only/); }
  finally { delete globalThis.window; }
});
