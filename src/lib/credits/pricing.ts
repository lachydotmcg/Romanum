import { CENTS_PER_CREDIT } from "./value.ts";

// Romanum's pricing blueprint: what each model costs Romanum, copied from the providers' official pricing pages
// on the date shown, and how that becomes credits. Providers change prices: re-check the sources before relying
// on them, and update `checked` with the rates.

/** US dollars per 1M tokens. */
export type TokenRates = {
  /** Uncached input (a cache miss). */
  input: number;
  /** Input served from the provider's prompt cache (a cache hit). */
  cachedInput: number;
  /** Writing input to the prompt cache, where the provider bills that separately. */
  cacheWrite?: number;
  output: number;
};

export type ModelPricing = {
  /** The model ID sent to the provider's API. */
  id: string;
  provider: "DeepSeek" | "OpenAI" | "Anthropic";
  /** Models in use are metered today; planned ones are priced here for routing decisions. */
  status: "in use" | "planned";
  role: string;
  rates: TokenRates;
  /** DeepSeek's rates outside its peak hours: half the peak rates. */
  offPeakRates?: TokenRates;
  /** Prompts above this many input tokens cost more for the whole request. */
  longContext?: { overInputTokens: number; inputMultiplier: number; outputMultiplier: number };
  source: string;
  checked: string;
};

const OPENAI_LONG_CONTEXT = { overInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 };

export const MODEL_PRICING: readonly ModelPricing[] = [
  {
    id: "deepseek-flash",
    provider: "DeepSeek",
    status: "in use",
    role: "Ask Romanum and Chats",
    rates: { input: 0.3, cachedInput: 0.006, output: 1.2 },
    offPeakRates: { input: 0.15, cachedInput: 0.003, output: 0.6 },
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    checked: "2026-09-27",
  },
  {
    id: "deepseek-v4-pro",
    provider: "DeepSeek",
    status: "planned",
    role: "Harder analysis",
    rates: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    offPeakRates: { input: 0.66, cachedInput: 0.022, output: 1.98 },
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    checked: "2026-09-27",
  },
  {
    id: "gpt-6-luna",
    provider: "OpenAI",
    status: "in use",
    role: "The daily insight's indie radar (web search); analytics, for the auto router",
    rates: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    longContext: OPENAI_LONG_CONTEXT,
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    checked: "2026-09-27",
  },
  {
    id: "gpt-6-sol",
    provider: "OpenAI",
    status: "planned",
    role: "Coding",
    rates: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    longContext: OPENAI_LONG_CONTEXT,
    source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
    checked: "2026-09-27",
  },
  {
    id: "claude-opus-5-5",
    provider: "Anthropic",
    status: "planned",
    role: "Coding",
    // Cache writes at the 5-minute rate; 1-hour writes cost $8. The full context window is standard-priced.
    rates: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checked: "2026-09-27",
  },
];

/**
 * OpenAI's web search tool: $10.00 per 1,000 calls, in nano-dollars per call. The search content it reads is
 * billed as input tokens at the model's rates. https://developers.openai.com/api/docs/pricing, checked 2026-09-27.
 */
export const WEB_SEARCH_CALL_NANO_USD = 10_000_000;

/** Romanum charges this multiple of what a request cost it (owner decision, 2026-09-27). */
export const CREDIT_MARKUP = 1.65;
/** Costs are kept in nano-dollars (billionths of a dollar) so small calls stay exact integers. */
export const NANO_USD_PER_CREDIT = CENTS_PER_CREDIT * 10_000_000;

/** Token counts from one model call, as the provider reported them. */
export type CallUsage = {
  model: string;
  /** When the request was sent, which sets DeepSeek's peak or off-peak rate. */
  at: Date;
  /** Uncached input tokens (cache misses). */
  input: number;
  /** Input tokens served from the prompt cache. */
  cachedInput: number;
  /** Input tokens written to the prompt cache, where billed separately. */
  cacheWrite?: number;
  output: number;
};

/**
 * DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. DeepSeek also bills Chinese public
 * holidays off-peak; those aren't tracked here, so their weekday peak hours are priced at peak.
 */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

export function modelPricing(model: string): ModelPricing {
  const pricing = MODEL_PRICING.find((item) => item.id === model);
  if (!pricing) throw new Error(`No price is recorded for model ${model}.`);
  return pricing;
}

/** The rates a call was billed at: DeepSeek's off-peak rates outside its peak hours. */
export function ratesFor(call: Pick<CallUsage, "model" | "at">): TokenRates {
  const pricing = modelPricing(call.model);
  return pricing.offPeakRates && !isDeepSeekPeak(call.at) ? pricing.offPeakRates : pricing.rates;
}

/** What one model call cost Romanum, in nano-dollars. */
export function callCost(call: CallUsage): number {
  const { longContext } = modelPricing(call.model);
  const rates = ratesFor(call);
  const inputTokens = call.input + call.cachedInput + (call.cacheWrite ?? 0);
  const long = longContext && inputTokens > longContext.overInputTokens ? longContext : null;
  // A price in dollars per 1M tokens is that many micro-dollars per token, so ×1000 gives nano-dollars per token.
  const nano = (tokens: number, perMillion: number, multiplier = 1) => tokens * Math.round(perMillion * 1000) * multiplier;
  return Math.round(
    nano(call.input, rates.input, long?.inputMultiplier) +
      nano(call.cachedInput, rates.cachedInput, long?.inputMultiplier) +
      nano(call.cacheWrite ?? 0, rates.cacheWrite ?? rates.input, long?.inputMultiplier) +
      nano(call.output, rates.output, long?.outputMultiplier),
  );
}

/** What an answer's model calls cost Romanum and what they cost the user after the markup, in nano-dollars. */
export function priceCalls(calls: CallUsage[]): { cost: number; price: number } {
  const cost = calls.reduce((sum, call) => sum + callCost(call), 0);
  return { cost, price: Math.round(cost * CREDIT_MARKUP) };
}
