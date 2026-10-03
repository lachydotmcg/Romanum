/** Public contracts only: no credentials, provider clients, or financial mutations. */
export const MODEL_IDS = [
  "deepseek-flash", "deepseek-v4-pro", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra",
  "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export type ProviderId = "deepseek" | "openai" | "anthropic";
export type ModelCapabilities = { text: boolean; tools: boolean; images: boolean };
export type CapabilityRequirements = Partial<ModelCapabilities>;
export type ModelSelection = { mode: "auto" } | { mode: "explicit"; modelId: ModelId };
export type CacheTtl = "automatic" | "30m" | "5m" | "1h";

/** USD per million tokens. All input categories are mutually exclusive. */
export type TokenRates = {
  input: number; cacheRead: number; output: number;
  cacheWrite?: number; cacheWrite5m?: number; cacheWrite1h?: number;
};
export type ModelDefinition = {
  id: ModelId; label: string; provider: ProviderId; capabilities: ModelCapabilities;
  /** Conservative Romanum request limits, not the providers' advertised maximums. */
  contextTokens: number; maxOutputTokens: number; cacheTtls: readonly CacheTtl[];
  rates: TokenRates; offPeakRates?: TokenRates;
  longContext?: { overInputTokens: number; inputMultiplier: number; outputMultiplier: number };
  rateCardVersion: string; checkedAt: string;
  sources: { model: string; pricing: string; caching: string };
  /** Integration constraints beyond the broad capabilities, not an execution adapter. */
  notes: readonly string[];
};
export type ReadinessReason = "ready" | "missing_key" | "adapter_not_supported" | "execution_disabled";
export type ModelReadiness = {
  modelId: ModelId; configured: boolean; adapterSupported: boolean;
  executionEnabled: boolean; selectable: boolean; reason: ReadinessReason;
  /** Presence is not a successful authentication or model-entitlement check. */
  entitlementVerified: false;
};
export type ExecutionReview = { adapterSupported: boolean; executionEnabled: boolean };
export type ExecutionReviews = Partial<Record<ModelId, ExecutionReview>>;
/** Server-priced display metadata; standard customer credits per million tokens, not a call quote. */
export type CreditRateCard = {
  rateCardVersion: string;
  pricingPolicyVersion: import("../credits/pricing-policy.ts").PricingPolicyVersion;
  unit: "credits_per_million_tokens";
  rates: { input: number; output: number; cacheRead: number };
};
export type PublicModel = ModelDefinition & ModelReadiness & { creditRateCards?: readonly CreditRateCard[] };
export type ModelsResponse = { rateCardVersion: string; models: PublicModel[] };

/** Compatibility metadata only; never raw prompts, private tool data, or cached answers. */
export type CacheBinding = {
  ownerId: string; conversationId: string; provider: ProviderId; modelId: ModelId;
  prefixHash: string; toolSchemaHash: string; settingsHash: string;
};
export type CacheObservation = {
  binding: CacheBinding; observedAt: string; expiresAt: string; cacheReadTokens: number;
};
export type TokenBudget = {
  /** Trusted integration must supply bounds for framing, tools, images and reasoning too. */
  inputTokens: number; maxInputTokens: number; outputTokens: number; maxOutputTokens: number;
  cacheTtl?: CacheTtl;
};
export type ModelQuote = {
  /** Absent only on historical 1.65x server snapshots. */
  pricingPolicyVersion?: import("../credits/pricing-policy.ts").PricingPolicyVersion;
  modelId: ModelId; rateCardVersion: string; estimatedCostNanoUsd: number;
  estimatedPriceNanoUsd: number; estimatedCredits: number;
  reservationPriceNanoUsd: number; reservationCredits: number;
  estimateBasis: "uncached" | "compatible_cache_scenario";
  estimatedCacheReadTokens: number; cacheHitGuaranteed: false;
  minimumReservationCredits: 2;
};
export type RouteReason = "explicit_selection" | "auto_affordable" | "auto_cache_scenario"
  | "invalid_selection" | "invalid_request" | "model_unavailable" | "capability_mismatch"
  | "context_limit" | "insufficient_balance" | "minimum_hold" | "no_ready_model";
export type RouteDecision =
  | { status: "selected"; modelId: ModelId; reason: RouteReason; quote: ModelQuote; fallback: null }
  | { status: "blocked"; reason: RouteReason; modelId?: ModelId; quote?: ModelQuote;
      /** A suggestion only; never a substituted explicit model or an executed retry. */
      fallback: { modelId: ModelId; quote: ModelQuote; reason: "affordable_alternative" } | null };
export type RouteRequest = {
  /** Trusted server policy, never accepted from browser routing assertions. */
  pricingPolicyVersion?: import("../credits/pricing-policy.ts").PricingPolicyVersion;
  selection: unknown; availableCredits: number; budget: TokenBudget;
  capabilities?: CapabilityRequirements; at: string;
  /** Required for cache-aware estimates; exact owner/model/etc. matches only. */
  cacheBinding?: CacheBinding; cacheObservations?: readonly CacheObservation[];
};

/** Provider-reported categories, never estimated usage. No reads/writes counted twice. */
export type NormalizedUsage = {
  provider: ProviderId; modelId: ModelId; at: string; rateCardVersion: string;
  inputMissTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  cacheWrite5mTokens: number; cacheWrite1hTokens: number;
  totalInputTokens: number; outputTokens: number;
};
export type UsageOptions = { at: string; cacheTtl?: CacheTtl };
