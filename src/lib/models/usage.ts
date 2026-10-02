import { getModel, ratesAt } from "./catalog.ts";
import type { ModelDefinition, ModelId, NormalizedUsage, TokenRates, UsageOptions } from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider usage.");
  return value as Record<string, unknown>;
}
function tokens(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid provider token count.");
  return value as number;
}
function optionalTokens(value: unknown): number { return value === undefined ? 0 : tokens(value); }
function sum(values: number[]): number { return tokens(values.reduce((total, value) => total + value, 0)); }
function modelFor(id: unknown): ModelDefinition {
  const model = getModel(id);
  if (!model) throw new Error("Unknown model.");
  return model;
}

/** Accept final/cumulative usage, not a stream delta. Adapters must merge stream usage first. */
export function normalizeUsage(modelId: ModelId, raw: unknown, options: UsageOptions): NormalizedUsage {
  const model = modelFor(modelId), usage = record(raw);
  ratesAt(model, options.at); // Validate time before returning an auditable usage record.
  if (options.cacheTtl && !model.cacheTtls.includes(options.cacheTtl)) throw new Error("Unsupported cache TTL.");
  if ((usage.service_tier !== undefined && !["standard", "default"].includes(String(usage.service_tier))) ||
    (usage.inference_geo !== undefined && usage.inference_geo !== "global")) throw new Error("Unsupported provider pricing modifier.");
  let inputMissTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  let cacheWrite5mTokens = 0, cacheWrite1hTokens = 0, totalInputTokens = 0, outputTokens = 0;
  if (model.provider === "deepseek") {
    totalInputTokens = tokens(usage.prompt_tokens);
    outputTokens = tokens(usage.completion_tokens); // Already includes reasoning; don't add child counts.
    const details = usage.prompt_tokens_details === undefined ? {} : record(usage.prompt_tokens_details);
    cacheReadTokens = optionalTokens(usage.prompt_cache_hit_tokens ?? details.cached_tokens);
    inputMissTokens = usage.prompt_cache_miss_tokens === undefined ? tokens(totalInputTokens - cacheReadTokens) : tokens(usage.prompt_cache_miss_tokens);
    if ((usage.prompt_cache_hit_tokens !== undefined && details.cached_tokens !== undefined && tokens(details.cached_tokens) !== cacheReadTokens) ||
      optionalTokens(details.cache_write_tokens) !== 0) throw new Error("Conflicting DeepSeek cache usage.");
  } else if (model.provider === "openai") {
    const responses = usage.input_tokens !== undefined;
    totalInputTokens = tokens(responses ? usage.input_tokens : usage.prompt_tokens);
    outputTokens = tokens(responses ? usage.output_tokens : usage.completion_tokens);
    const rawDetails = responses ? usage.input_tokens_details : usage.prompt_tokens_details;
    const details = rawDetails === undefined ? {} : record(rawDetails);
    cacheReadTokens = optionalTokens(details.cached_tokens);
    cacheWriteTokens = optionalTokens(details.cache_write_tokens);
    inputMissTokens = tokens(totalInputTokens - sum([cacheReadTokens, cacheWriteTokens]));
    // Mixed Responses/chat totals must agree, rather than choosing whichever makes a smaller bill.
    if ((usage.prompt_tokens !== undefined && tokens(usage.prompt_tokens) !== totalInputTokens) ||
      (usage.completion_tokens !== undefined && tokens(usage.completion_tokens) !== outputTokens)) throw new Error("Conflicting OpenAI usage totals.");
  } else {
    inputMissTokens = tokens(usage.input_tokens); // Anthropic excludes BOTH cache reads and writes here.
    outputTokens = tokens(usage.output_tokens);
    cacheReadTokens = optionalTokens(usage.cache_read_input_tokens);
    const created = optionalTokens(usage.cache_creation_input_tokens);
    if (usage.cache_creation !== undefined) {
      const creation = record(usage.cache_creation);
      cacheWrite5mTokens = optionalTokens(creation.ephemeral_5m_input_tokens);
      cacheWrite1hTokens = optionalTokens(creation.ephemeral_1h_input_tokens);
      if (sum([cacheWrite5mTokens, cacheWrite1hTokens]) !== created) throw new Error("Conflicting Anthropic cache creation totals.");
    } else if (created > 0) {
      if (options.cacheTtl === "5m") cacheWrite5mTokens = created;
      else if (options.cacheTtl === "1h") cacheWrite1hTokens = created;
      else throw new Error("Cache write TTL is required for Anthropic usage without a breakdown.");
    }
    totalInputTokens = sum([inputMissTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens]);
    if (usage.total_input_tokens !== undefined && tokens(usage.total_input_tokens) !== totalInputTokens) throw new Error("Conflicting Anthropic input total.");
  }
  if (sum([inputMissTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens]) !== totalInputTokens) {
    throw new Error("Provider input token categories do not match the reported total.");
  }
  if (usage.total_tokens !== undefined && tokens(usage.total_tokens) !== sum([totalInputTokens, outputTokens])) {
    throw new Error("Provider total tokens do not match input and output.");
  }
  return { provider: model.provider, modelId: model.id, at: options.at, rateCardVersion: model.rateCardVersion,
    inputMissTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens, totalInputTokens, outputTokens };
}

/** Pure standard/global text-token cost. No ledger settlement or provider calls. */
function costWithRates(usage: NormalizedUsage, rates: TokenRates): number {
  const model = modelFor(usage.modelId);
  if (usage.provider !== model.provider || usage.rateCardVersion !== model.rateCardVersion) throw new Error("Usage rate card or provider mismatch.");
  const counts = [usage.inputMissTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.cacheWrite5mTokens, usage.cacheWrite1hTokens];
  counts.forEach(tokens);
  if (sum(counts) !== tokens(usage.totalInputTokens)) throw new Error("Invalid normalized input total.");
  tokens(usage.outputTokens);
  ratesAt(model, usage.at);
  if ((!rates.cacheWrite && usage.cacheWriteTokens) || (!rates.cacheWrite5m && usage.cacheWrite5mTokens) || (!rates.cacheWrite1h && usage.cacheWrite1hTokens)) {
    throw new Error("Unsupported cache write category.");
  }
  const long = model.longContext && usage.totalInputTokens > model.longContext.overInputTokens ? model.longContext : null;
  const inputRates = [rates.input, rates.cacheRead, rates.cacheWrite ?? 0, rates.cacheWrite5m ?? 0, rates.cacheWrite1h ?? 0];
  const nano = (count: number, rate: number, multiplier: number) => count * rate * 1000 * multiplier;
  const cost = Math.ceil(counts.reduce((total, count, i) => total + nano(count, inputRates[i], long?.inputMultiplier ?? 1), 0)
    + nano(usage.outputTokens, rates.output, long?.outputMultiplier ?? 1));
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Usage cost exceeds the safe accounting limit.");
  return cost;
}

export function costUsage(usage: NormalizedUsage): number {
  return costWithRates(usage, ratesAt(modelFor(usage.modelId), usage.at));
}
/** Only raises the DeepSeek rate to peak; not an alternate rate supplied by a caller. */
export function ceilingCostUsage(usage: NormalizedUsage): number {
  return costWithRates(usage, modelFor(usage.modelId).rates);
}
