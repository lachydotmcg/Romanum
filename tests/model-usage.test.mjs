import test from "node:test";
import assert from "node:assert/strict";
import { costUsage, normalizeUsage } from "../src/lib/models/usage.ts";
const at = "2026-10-02T07:00:00.000Z";

test("DeepSeek hit and miss categories partition prompt tokens; reasoning is not billed twice", () => {
  const usage = normalizeUsage("deepseek-flash", { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
    completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 50 } }, { at });
  assert.equal(usage.inputMissTokens, 200);
  assert.equal(usage.cacheReadTokens, 800);
  assert.equal(usage.outputTokens, 100);
  assert.equal(costUsage(usage), 184800);
  assert.equal(costUsage({ ...usage, at: "2026-10-03T07:00:00.000Z" }), 92400);
  assert.throws(() => normalizeUsage("deepseek-flash", { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 201, completion_tokens: 1 }, { at }));
  assert.throws(() => normalizeUsage("deepseek-flash", { prompt_tokens: 1000, prompt_cache_hit_tokens: 800,
    prompt_tokens_details: { cached_tokens: 799 }, completion_tokens: 1 }, { at }));
});

test("OpenAI cache writes replace ordinary input; Responses and Chat Completions normalize identically", () => {
  const responses = normalizeUsage("gpt-6.1-sol", { input_tokens: 1000, output_tokens: 100,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, output_tokens_details: { reasoning_tokens: 70 } }, { at });
  const chat = normalizeUsage("gpt-6.1-sol", { prompt_tokens: 1000, completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } }, { at });
  assert.deepEqual(chat, responses);
  assert.equal(responses.inputMissTokens, 100);
  assert.equal(costUsage(responses), 2010000); // .0002 + .00006 + .00075 + .001 dollars.
  assert.throws(() => normalizeUsage("gpt-6.1-sol", { input_tokens: 100, output_tokens: 1,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 50 } }, { at }));
  assert.throws(() => normalizeUsage("gpt-6.1-sol", { input_tokens: 100, prompt_tokens: 200, output_tokens: 1 }, { at }));
});

test("Anthropic input excludes read/write categories and mixed 5m/1h writes keep their separate prices", () => {
  const usage = normalizeUsage("claude-opus-5-5", { input_tokens: 100, cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }, output_tokens: 100 }, { at });
  assert.equal(usage.totalInputTokens, 1000);
  assert.equal(usage.cacheWriteTokens, 0);
  assert.equal(usage.cacheWrite5mTokens, 200);
  assert.equal(usage.cacheWrite1hTokens, 100);
  assert.equal(costUsage(usage), 4320000);
  const raw = { input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 10 };
  assert.throws(() => normalizeUsage("claude-opus-5-5", raw, { at }), /TTL/);
  assert.equal(normalizeUsage("claude-opus-5-5", raw, { at, cacheTtl: "1h" }).cacheWrite1hTokens, 100);
  assert.throws(() => normalizeUsage("claude-opus-5-5", { ...raw, cache_creation: { ephemeral_5m_input_tokens: 99 } }, { at }));
});

test("invalid counts, forged models and rate-card/provider changes cannot produce cheaper actual accounting", () => {
  for (const invalid of [-1, 0.1, Number.NaN, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeUsage("gpt-6-luna", { input_tokens: invalid, output_tokens: 1 }, { at }));
  }
  assert.throws(() => normalizeUsage("invented-model", { input_tokens: 1, output_tokens: 1 }, { at }));
  assert.throws(() => normalizeUsage("gpt-6-luna", { input_tokens: 1, output_tokens: 1 }, { at: "invalid" }));
  const usage = normalizeUsage("gpt-6-luna", { input_tokens: 100, output_tokens: 1 }, { at });
  assert.throws(() => costUsage({ ...usage, rateCardVersion: "stale" }), /mismatch/);
  assert.throws(() => costUsage({ ...usage, provider: "anthropic" }), /mismatch/);
  assert.throws(() => costUsage({ ...usage, inputMissTokens: 99 }), /total/);
});

test("OpenAI long-context pricing applies to the full read/write/miss/output request", () => {
  const usage = normalizeUsage("gpt-6-luna", { input_tokens: 273000, output_tokens: 100,
    input_tokens_details: { cached_tokens: 100000, cache_write_tokens: 100000 } }, { at });
  assert.equal(costUsage(usage), 41675000);
  const threshold = normalizeUsage("gpt-6-luna", { input_tokens: 272000, output_tokens: 100 }, { at });
  assert.equal(costUsage(threshold), 27250000);
});
