import test from "node:test";
import assert from "node:assert/strict";
import { CREDIT_MARKUP, MODEL_PRICING, NANO_USD_PER_CREDIT, callCost, isDeepSeekPeak, priceCalls } from "../src/lib/credits/pricing.ts";
import { formatCredits } from "../src/lib/credits/value.ts";

// 2026-09-23 is a Wednesday; 2026-09-26 is a Saturday.
const at = (iso) => new Date(iso);

test("every model's price has an official source and a checked date, and DeepSeek off-peak is half its peak", () => {
  for (const model of MODEL_PRICING) {
    assert.match(model.source, /^https:\/\/(api-docs\.deepseek\.com|developers\.openai\.com|platform\.claude\.com)\//);
    assert.match(model.checked, /^\d{4}-\d{2}-\d{2}$/);
    if (model.offPeakRates) for (const key of ["input", "cachedInput", "output"]) assert.equal(model.offPeakRates[key] * 2, model.rates[key]);
  }
  assert.deepEqual(MODEL_PRICING.filter((model) => model.status === "in use").map((model) => model.id), ["deepseek-flash"]);
  assert.equal(CREDIT_MARKUP, 1.65);
  assert.equal(NANO_USD_PER_CREDIT, 10_000_000);
});

test("DeepSeek's peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays", () => {
  const cases = {
    "2026-09-23T00:59:00Z": false, "2026-09-23T01:00:00Z": true, "2026-09-23T03:59:00Z": true, "2026-09-23T04:00:00Z": false,
    "2026-09-23T05:59:00Z": false, "2026-09-23T06:00:00Z": true, "2026-09-23T09:59:00Z": true, "2026-09-23T10:00:00Z": false,
    "2026-09-26T02:00:00Z": false, "2026-09-27T07:00:00Z": false,
  };
  for (const [iso, peak] of Object.entries(cases)) assert.equal(isDeepSeekPeak(at(iso)), peak, iso);
});

test("a call's cost follows its token counts and DeepSeek's rate at that hour, exactly, in nano-dollars", () => {
  const call = { model: "deepseek-flash", input: 10_000, cachedInput: 20_000, output: 500 };
  // 10,000 × $0.30/M + 20,000 × $0.006/M + 500 × $1.20/M = $0.00372.
  assert.equal(callCost({ ...call, at: at("2026-09-23T02:00:00Z") }), 3_720_000);
  // Off-peak, every rate halves.
  assert.equal(callCost({ ...call, at: at("2026-09-23T12:00:00Z") }), 1_860_000);
  const { cost, price } = priceCalls([{ ...call, at: at("2026-09-23T02:00:00Z") }, { ...call, at: at("2026-09-26T02:00:00Z") }]);
  assert.equal(cost, 5_580_000);
  assert.equal(price, Math.round(5_580_000 * 1.65));
  assert.throws(() => callCost({ ...call, model: "unknown-model", at: new Date() }), /No price is recorded/);
});

test("OpenAI's long prompts cost double input and 1.5× output for the whole request, and cache writes are priced", () => {
  const luna = (input, extra = {}) => callCost({ model: "gpt-6-luna", at: new Date(), input, cachedInput: 0, output: 1_000, ...extra });
  assert.equal(luna(200_000), 200_000 * 100 + 1_000 * 500);
  assert.equal(luna(300_000), 300_000 * 100 * 2 + 1_000 * 500 * 1.5);
  assert.equal(luna(0, { cacheWrite: 1_000 }), 1_000 * 125 + 1_000 * 500);
  // Claude bills its whole context window at the standard rate.
  assert.equal(callCost({ model: "claude-opus-5-5", at: new Date(), input: 300_000, cachedInput: 0, output: 1_000 }), 300_000 * 4_000 + 1_000 * 20_000);
});

test("an answer's price reads as a short credit amount", () => {
  assert.equal(formatCredits(0.6138), "0.61 credits");
  assert.equal(formatCredits(0.004), "<0.01 credits");
  assert.equal(formatCredits(1), "1 credit");
  assert.equal(formatCredits(12.5), "12.5 credits");
  assert.equal(formatCredits(0), "0 credits");
});
