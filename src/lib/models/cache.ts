import { createHash } from "node:crypto";
import { z } from "zod";
import { getModel } from "./catalog.ts";
import { MODEL_IDS, type CacheBinding, type CacheObservation, type ModelId } from "./types.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  ownerId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200),
  provider: z.enum(["deepseek", "openai", "anthropic"]), modelId: z.enum(MODEL_IDS),
  prefixHash: hash, toolSchemaHash: hash, settingsHash: hash,
}).strict();
function parseBinding(value: unknown): CacheBinding {
  const result = bindingSchema.safeParse(value);
  if (!result.success || getModel(result.data.modelId)?.provider !== result.data.provider) throw new Error("Invalid cache binding.");
  return result.data;
}

/** Metadata digest only, not a security boundary or an answer cache. */
export function cacheKey(binding: CacheBinding): string {
  const value = parseBinding(binding);
  return createHash("sha256").update(JSON.stringify([
    value.ownerId, value.conversationId, value.provider, value.modelId,
    value.prefixHash, value.toolSchemaHash, value.settingsHash,
  ])).digest("hex");
}
export function cacheCompatible(expected: CacheBinding, observed: CacheBinding): boolean {
  try { return cacheKey(expected) === cacheKey(observed); } catch { return false; }
}

/**
 * A recent compatible hit supplies a scenario, never a guaranteed future hit.
 * A newer compatible miss replaces an older hit. No prompt or result is reused here.
 */
export function compatibleCacheReadTokens(
  modelId: ModelId, binding: CacheBinding | undefined, observations: readonly CacheObservation[],
  inputTokens: number, at: string,
): number {
  const model = getModel(modelId);
  const time = Date.parse(at);
  if (!model || !binding || binding.modelId !== modelId || binding.provider !== model.provider ||
    !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isFinite(time)) return 0;
  let latest: CacheObservation | undefined;
  for (const observation of observations) {
    const observed = Date.parse(observation.observedAt), expires = Date.parse(observation.expiresAt);
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > time || expires <= time || expires <= observed ||
      !Number.isSafeInteger(observation.cacheReadTokens) || observation.cacheReadTokens < 0 ||
      !cacheCompatible(binding, observation.binding)) continue;
    if (!latest || observed > Date.parse(latest.observedAt) ||
      (observed === Date.parse(latest.observedAt) && observation.cacheReadTokens < latest.cacheReadTokens)) latest = observation;
  }
  return Math.min(inputTokens, latest?.cacheReadTokens ?? 0);
}
