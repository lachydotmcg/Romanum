import test from "node:test";
import assert from "node:assert/strict";
import { cacheCompatible, cacheKey, compatibleCacheReadTokens } from "../src/lib/models/cache.ts";

const at = "2026-10-02T12:00:00.000Z";
const binding = (extra = {}) => ({ ownerId: "owner-a", conversationId: "chat-a", provider: "openai", modelId: "gpt-6.1-sol",
  prefixHash: "a".repeat(64), toolSchemaHash: "b".repeat(64), settingsHash: "c".repeat(64), ...extra });
const observation = (extra = {}) => ({ binding: binding(), observedAt: "2026-10-02T11:50:00.000Z",
  expiresAt: "2026-10-02T12:20:00.000Z", cacheReadTokens: 1500, ...extra });

test("cache compatibility binds owner, conversation, provider, exact model, prefix, tools and settings", () => {
  assert.equal(cacheCompatible(binding(), binding()), true);
  assert.match(cacheKey(binding()), /^[a-f0-9]{64}$/);
  for (const extra of [
    { ownerId: "owner-b" }, { conversationId: "chat-b" }, { modelId: "gpt-6-astra" },
    { provider: "anthropic", modelId: "claude-opus-5-5" }, { prefixHash: "d".repeat(64) },
    { toolSchemaHash: "d".repeat(64) }, { settingsHash: "d".repeat(64) },
  ]) {
    assert.equal(cacheCompatible(binding(), binding(extra)), false);
    assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [observation({ binding: binding(extra) })], 2000, at), 0);
  }
  assert.throws(() => cacheKey(binding({ provider: "anthropic" })), /Invalid cache binding/);
  assert.throws(() => cacheKey(binding({ result: "private answer" })), /Invalid cache binding/);
  assert.ok(!cacheKey(binding()).includes("owner-a"));
});

test("recent hits are scenarios, expired/future/invalid observations are ignored and newer misses replace hits", () => {
  assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [observation()], 2000, at), 1500);
  assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [observation()], 500, at), 500);
  assert.equal(compatibleCacheReadTokens("gpt-6-astra", binding(), [observation()], 2000, at), 0);
  for (const extra of [
    { expiresAt: at }, { observedAt: "2026-10-02T12:01:00.000Z" }, { observedAt: "invalid" },
    { cacheReadTokens: -1 }, { cacheReadTokens: 0.5 }, { expiresAt: "2026-10-02T11:40:00.000Z" },
  ]) assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [observation(extra)], 2000, at), 0);
  const miss = observation({ observedAt: "2026-10-02T11:59:00.000Z", cacheReadTokens: 0 });
  assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [observation(), miss], 2000, at), 0);
  assert.equal(compatibleCacheReadTokens("gpt-6.1-sol", binding(), [miss, observation()], 2000, at), 0);
});
