import { CREDIT_MARKUP, NANO_USD_PER_CREDIT } from "../credits/pricing.ts";
import { compatibleCacheReadTokens } from "./cache.ts";
import { getModel } from "./catalog.ts";
import { ceilingCostUsage, costUsage } from "./usage.ts";
import type { CacheBinding, CacheObservation, CacheTtl, ModelId, ModelQuote, NormalizedUsage, TokenBudget } from "./types.ts";

export function validBudget(budget: TokenBudget): boolean {
  return !!budget && [budget.inputTokens, budget.maxInputTokens, budget.outputTokens, budget.maxOutputTokens]
    .every((count) => Number.isSafeInteger(count) && count >= 0) &&
    budget.maxInputTokens > 0 && budget.maxOutputTokens > 0 &&
    budget.inputTokens <= budget.maxInputTokens && budget.outputTokens <= budget.maxOutputTokens &&
    (budget.cacheTtl === undefined || ["automatic", "30m", "5m", "1h"].includes(budget.cacheTtl));
}
/** Mirrors the existing hold policy exactly. It does not create a reservation. */
export function reservationCredits(priceNanoUsd: number): number {
  if (!Number.isSafeInteger(priceNanoUsd) || priceNanoUsd < 1) throw new Error("Invalid reservation quote.");
  const whole = Math.floor(priceNanoUsd / NANO_USD_PER_CREDIT);
  const amount = whole + (priceNanoUsd - whole * NANO_USD_PER_CREDIT > 0 ? 1 : 0) + 1;
  if (!Number.isSafeInteger(amount)) throw new Error("Reservation exceeds the safe accounting limit.");
  return amount;
}
function price(cost: number): number {
  const amount = Math.ceil(cost * CREDIT_MARKUP);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Price exceeds the safe accounting limit.");
  return amount;
}
function writeCategory(ttl: CacheTtl, count: number): Pick<NormalizedUsage, "cacheWriteTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens"> {
  return { cacheWriteTokens: ttl === "30m" ? count : 0,
    cacheWrite5mTokens: ttl === "5m" ? count : 0, cacheWrite1hTokens: ttl === "1h" ? count : 0 };
}

/** One-call text-token quote; supplied bounds must already include framing, tools, vision and reasoning. */
export function quoteModel(
  modelId: ModelId, budget: TokenBudget, options: {
    at: string; cacheBinding?: CacheBinding; cacheObservations?: readonly CacheObservation[];
  },
): ModelQuote {
  const model = getModel(modelId);
  if (!model || !validBudget(budget) || !Number.isFinite(Date.parse(options.at))) throw new Error("Invalid model quote.");
  if (budget.maxInputTokens + budget.maxOutputTokens > model.contextTokens || budget.maxOutputTokens > model.maxOutputTokens) {
    throw new Error("Request exceeds the reviewed token limits.");
  }
  const ttl = budget.cacheTtl ?? model.cacheTtls[0];
  if (!model.cacheTtls.includes(ttl)) throw new Error("Unsupported cache TTL.");
  const cacheRead = compatibleCacheReadTokens(model.id, options.cacheBinding, options.cacheObservations ?? [], budget.inputTokens, options.at);
  const base = { provider: model.provider, modelId: model.id, at: options.at, rateCardVersion: model.rateCardVersion,
    inputMissTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    totalInputTokens: 0, outputTokens: 0 };
  // With no compatible observation, estimate a cache miss. Writes are still covered by the ceiling.
  const estimatedCostNanoUsd = costUsage({ ...base, inputMissTokens: budget.inputTokens - cacheRead,
    cacheReadTokens: cacheRead, totalInputTokens: budget.inputTokens, outputTokens: budget.outputTokens });
  const miss = { ...base, inputMissTokens: budget.maxInputTokens, totalInputTokens: budget.maxInputTokens, outputTokens: budget.maxOutputTokens };
  const write = { ...miss, inputMissTokens: ttl === "automatic" ? budget.maxInputTokens : 0,
    ...writeCategory(ttl, budget.maxInputTokens) };
  // No future hit is needed to afford this; cover the more expensive all-miss or all-write case at peak.
  const reservationPriceNanoUsd = Math.max(1, price(Math.max(ceilingCostUsage(miss), ceilingCostUsage(write))));
  const estimatedPriceNanoUsd = price(estimatedCostNanoUsd);
  return { modelId: model.id, rateCardVersion: model.rateCardVersion, estimatedCostNanoUsd, estimatedPriceNanoUsd,
    estimatedCredits: estimatedPriceNanoUsd / NANO_USD_PER_CREDIT, reservationPriceNanoUsd,
    reservationCredits: reservationCredits(reservationPriceNanoUsd), minimumReservationCredits: 2,
    estimateBasis: cacheRead ? "compatible_cache_scenario" : "uncached", estimatedCacheReadTokens: cacheRead, cacheHitGuaranteed: false };
}
