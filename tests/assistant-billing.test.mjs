import test from "node:test";
import assert from "node:assert/strict";
import { meteredStream, meteredCompletion, quoteAssistantCall, reportedCallUsage } from "../src/lib/assistant/billing.ts";
import { priceCalls } from "../src/lib/credits/pricing.ts";

const params = { model: "deepseek-flash", messages: [{ role: "user", content: "Compare these games" }], max_tokens: 16000, stream: true };
const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 50, total_tokens: 150 };
const signal = () => new AbortController().signal;
function fixture(create) {
  const events = [];
  const billing = {
    credits: 0,
    async reserve(quote) { events.push(["reserve", quote]); return "hold"; },
    async settle(id, call) { events.push(["settle", id, call]); },
    async finish(id, uncertain) { events.push(["finish", id, uncertain]); },
  };
  const client = { chat: { completions: { create: async (request, options) => { events.push(["provider", options]); return create(request, options); } } } };
  return { events, billing, client };
}
const collect = async (stream) => { for await (const chunk of stream) assert.ok(chunk); };

test("quotes cover peak uncached text, framing and capped output, irrespective of cache discounts", () => {
  const quote = quoteAssistantCall(params);
  const { price } = priceCalls([{ model: params.model, at: new Date("2026-09-28T02:00:00Z"), input: 2000, cachedInput: 0, output: 16000 }]);
  assert.ok(quote >= price);
  assert.throws(() => quoteAssistantCall({ ...params, max_tokens: undefined }));
  assert.throws(() => quoteAssistantCall({ ...params, max_tokens: 16001 }));
  assert.throws(() => quoteAssistantCall({ ...params, model: "unreviewed-model" }));
  assert.throws(() => quoteAssistantCall({ ...params, messages: [{ role: "user", content: "x".repeat(2_000_001) }] }));
});

test("inline images are quoted as image tokens; external URLs are rejected", () => {
  const request = (url) => ({ ...params, messages: [{ role: "user", content: [{ type: "text", text: "Review" }, { type: "image_url", image_url: { url } }] }] });
  assert.equal(quoteAssistantCall(request("data:image/png;base64,AAAA")), quoteAssistantCall(request(`data:image/png;base64,${"A".repeat(100_000)}`)));
  assert.ok(quoteAssistantCall(request("data:image/png;base64,AAAA")) > quoteAssistantCall(params));
  assert.throws(() => quoteAssistantCall(request("https://example.com/private.png")));
});

test("no provider call when credits cannot be reserved", async () => {
  const f = fixture(() => assert.fail("provider ran"));
  f.billing.reserve = async () => { throw new Error("insufficient_balance"); };
  await assert.rejects(collect(meteredStream(f.client, params, f.billing, signal())), /insufficient_balance/);
  assert.deepEqual(f.events, []);
});

test("stream reserves before calling and settles final usage before returning; SDK retries disabled", async () => {
  const f = fixture(async function* () { yield { choices: [], usage }; });
  await collect(meteredStream(f.client, params, f.billing, signal()));
  assert.deepEqual(f.events.map(([name]) => name), ["reserve", "provider", "settle"]);
  assert.equal(f.events[1][1].maxRetries, 0);
  assert.equal(f.events[2][2].input, 80);
  assert.equal(f.events[2][2].cachedInput, 20);
  assert.equal(f.events[2][2].output, 50);
});

test("usage is settled even if the transport fails after its final report", async () => {
  const f = fixture(async function* () { yield { choices: [], usage }; throw new Error("disconnected"); });
  await assert.rejects(collect(meteredStream(f.client, params, f.billing, signal())), /disconnected/);
  assert.equal(f.events.at(-1)[0], "settle");
});

test("client-side cancellation after reported usage still settles", async () => {
  const f = fixture(async function* () { yield { choices: [], usage }; });
  for await (const chunk of meteredStream(f.client, params, f.billing, signal())) { assert.ok(chunk); break; }
  assert.equal(f.events.at(-1)[0], "settle");
});

test("explicit provider rejection releases, ambiguous failures retain the reservation", async () => {
  for (const [status, uncertain] of [[400, false], [401, false], [429, false], [500, true], [undefined, true]]) {
    const f = fixture(() => { throw Object.assign(new Error("failed"), { status }); });
    await assert.rejects(collect(meteredStream(f.client, params, f.billing, signal())));
    assert.deepEqual(f.events.at(-1), ["finish", "hold", uncertain]);
  }
});

test("abort before dispatch releases without making a call", async () => {
  const f = fixture(() => assert.fail("provider ran"));
  await assert.rejects(collect(meteredStream(f.client, params, f.billing, AbortSignal.abort())));
  assert.deepEqual(f.events.map(([name]) => name), ["reserve", "finish"]);
  assert.deepEqual(f.events.at(-1), ["finish", "hold", false]);
});

test("missing or invalid usage stops the loop and leaves an uncertain hold", async () => {
  for (const report of [null, { ...usage, completion_tokens: -1 }, { ...usage, prompt_cache_hit_tokens: 900 }]) {
    const f = fixture(async function* () { yield { choices: [], usage: report }; });
    await assert.rejects(collect(meteredStream(f.client, params, f.billing, signal())));
    assert.deepEqual(f.events.at(-1), ["finish", "hold", true]);
  }
  assert.throws(() => reportedCallUsage(new Date(), { ...usage, completion_tokens: Infinity }));
});

test("failed settlement cannot return a successful completed stream", async () => {
  const f = fixture(async function* () { yield { choices: [], usage }; });
  f.billing.settle = async () => { throw new Error("database unavailable"); };
  await assert.rejects(collect(meteredStream(f.client, params, f.billing, signal())), /database unavailable/);
});

test("non-streaming follow-ups use the same reservation and settlement rules", async () => {
  const f = fixture(() => ({ choices: [], usage }));
  await meteredCompletion(f.client, { ...params, stream: false, max_tokens: 40 }, f.billing, signal(), 8000);
  assert.deepEqual(f.events.map(([name]) => name), ["reserve", "provider", "settle"]);
  assert.equal(f.events[1][1].timeout, 8000);
  assert.equal(f.events[1][1].maxRetries, 0);
  const missing = fixture(() => ({ choices: [] }));
  await assert.rejects(meteredCompletion(missing.client, { ...params, stream: false }, missing.billing, signal(), 8000));
  assert.deepEqual(missing.events.at(-1), ["finish", "hold", true]);
});
