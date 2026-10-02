import { createHash } from "node:crypto";
import { CREDIT_MARKUP, NANO_USD_PER_CREDIT } from "../../credits/pricing.ts";
import { getModel } from "../catalog.ts";
import { quoteModel, validBudget } from "../estimate.ts";
import { costUsage } from "../usage.ts";
import type { ModelId, ModelQuote, NormalizedUsage, ProviderId, TokenBudget } from "../types.ts";
import type {
  AttemptOutcome, ContractErrorCode, ContractPolicy, HoldBinding, Immutable,
  PreparedAttempt, PreparedAttemptInput, ReviewedBoundStrategy, UsageEvidence,
} from "./types.ts";

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  constructor(code: ContractErrorCode) {
    super(`Provider accounting contract: ${code}.`);
    this.name = "ContractError";
    this.code = code;
  }
}
export function fail(code: ContractErrorCode): never { throw new ContractError(code); }

/** Reject unknown fields, accessors, exotic prototypes and symbols before reading values. */
export function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_shape");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("invalid_shape");
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) fail("invalid_shape");
  for (const key of keys) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail("invalid_shape");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail("invalid_shape");
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail("invalid_shape");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown, max = 128): string {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) fail("invalid_identifier");
  return value;
}
export function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_identifier");
  return value;
}
export function count(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || Object.is(value, -0)) fail("invalid_count");
  return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail("invalid_timestamp");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail("invalid_timestamp");
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail("invalid_shape");
  return value as T;
}
function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) fail("invalid_shape");
  return expected;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("invalid_shape");
  return value;
}
export function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype) fail("invalid_shape");
  // Reject holes, attached fields, symbols and getters. Length is the sole non-index property.
  if (Reflect.ownKeys(value).length !== value.length + 1) fail("invalid_shape");
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("invalid_shape");
  }
  return value;
}
function set<T extends string>(value: unknown, choices: readonly T[]): T[] {
  const entries = array(value, choices.length).map((item) => choice(item, choices));
  if (entries.length === 0 || new Set(entries).size !== entries.length) fail("invalid_shape");
  return choices.filter((entry) => entries.includes(entry));
}
const CAPABILITIES = ["text", "tools", "images"] as const;
const TTLS = ["automatic", "30m", "5m", "1h"] as const;
export function provider(value: unknown): ProviderId { return choice(value, ["deepseek", "openai", "anthropic"]); }
export function modelId(value: unknown): ModelId {
  const model = getModel(value);
  if (!model) fail("unsupported_model");
  return model.id;
}
export function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
/** Internal only: callers must supply bounded snapshots built in fixed known-field order. */
export function fingerprint(domain: string, snapshot: unknown): string {
  return createHash("sha256").update(`romanum.execution-accounting.v1:${domain}\n`).update(JSON.stringify(snapshot)).digest("hex");
}

export function validatePolicy(value: unknown): ContractPolicy {
  const policy = record(value, ["reviewedBounds"]);
  const reviewedBounds = array(policy.reviewedBounds, 128).map((item): ReviewedBoundStrategy => {
    const r = record(item, ["strategyId", "strategyVersion", "provider", "modelId", "adapterVersion", "requestFormatVersion", "capabilities", "cacheTtls", "maxInputTokens", "maxOutputTokens"]);
    const id = modelId(r.modelId), model = getModel(id)!;
    const capabilities = set(r.capabilities, CAPABILITIES);
    const cacheTtls = set(r.cacheTtls, TTLS);
    const p = provider(r.provider);
    const maxInputTokens = count(r.maxInputTokens, true), maxOutputTokens = count(r.maxOutputTokens, true);
    if (model.provider !== p || !capabilities.includes("text") || capabilities.some((cap) => !model.capabilities[cap]) ||
        cacheTtls.some((ttl) => !model.cacheTtls.includes(ttl)) ||
        maxInputTokens + maxOutputTokens > model.contextTokens || maxOutputTokens > model.maxOutputTokens) fail("unreviewed_bounds");
    return {
      strategyId: identifier(r.strategyId), strategyVersion: identifier(r.strategyVersion), provider: p, modelId: id,
      adapterVersion: identifier(r.adapterVersion), requestFormatVersion: identifier(r.requestFormatVersion),
      capabilities, cacheTtls, maxInputTokens, maxOutputTokens,
    };
  });
  const keys = reviewedBounds.map((r) => JSON.stringify([r.strategyId, r.strategyVersion, r.provider, r.modelId, r.adapterVersion, r.requestFormatVersion]));
  if (new Set(keys).size !== keys.length) fail("unreviewed_bounds");
  return freeze({ reviewedBounds });
}

function budget(value: unknown): TokenBudget {
  const r = record(value, ["inputTokens", "maxInputTokens", "outputTokens", "maxOutputTokens"], ["cacheTtl"]);
  const b: TokenBudget = {
    inputTokens: count(r.inputTokens), maxInputTokens: count(r.maxInputTokens, true),
    outputTokens: count(r.outputTokens), maxOutputTokens: count(r.maxOutputTokens, true),
    ...(r.cacheTtl === undefined ? {} : { cacheTtl: choice(r.cacheTtl, TTLS) }),
  };
  if (!validBudget(b)) fail("invalid_budget");
  return b;
}

const USAGE_KEYS = ["provider", "modelId", "at", "rateCardVersion", "inputMissTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "totalInputTokens", "outputTokens"] as const;
/** Shape is strict; semantic discrepancies are retained by the decision reducer. */
export function readUsage(value: unknown): NormalizedUsage {
  const r = record(value, USAGE_KEYS);
  return {
    provider: provider(r.provider), modelId: modelId(r.modelId), at: timestamp(r.at), rateCardVersion: identifier(r.rateCardVersion),
    inputMissTokens: count(r.inputMissTokens), cacheReadTokens: count(r.cacheReadTokens), cacheWriteTokens: count(r.cacheWriteTokens),
    cacheWrite5mTokens: count(r.cacheWrite5mTokens), cacheWrite1hTokens: count(r.cacheWrite1hTokens),
    totalInputTokens: count(r.totalInputTokens), outputTokens: count(r.outputTokens),
  };
}

function quote(value: unknown, id: ModelId, b: TokenBudget, at: string): ModelQuote {
  const r = record(value, ["modelId", "rateCardVersion", "estimatedCostNanoUsd", "estimatedPriceNanoUsd", "estimatedCredits", "reservationPriceNanoUsd", "reservationCredits", "estimateBasis", "estimatedCacheReadTokens", "cacheHitGuaranteed", "minimumReservationCredits"]);
  const q: ModelQuote = {
    modelId: modelId(r.modelId), rateCardVersion: identifier(r.rateCardVersion),
    estimatedCostNanoUsd: count(r.estimatedCostNanoUsd), estimatedPriceNanoUsd: count(r.estimatedPriceNanoUsd),
    estimatedCredits: typeof r.estimatedCredits === "number" && Number.isFinite(r.estimatedCredits) && r.estimatedCredits >= 0 ? r.estimatedCredits : fail("invalid_quote"),
    reservationPriceNanoUsd: count(r.reservationPriceNanoUsd, true), reservationCredits: count(r.reservationCredits, true),
    estimateBasis: choice(r.estimateBasis, ["uncached", "compatible_cache_scenario"]), estimatedCacheReadTokens: count(r.estimatedCacheReadTokens),
    cacheHitGuaranteed: literal(r.cacheHitGuaranteed, false), minimumReservationCredits: literal(r.minimumReservationCredits, 2),
  };
  if (q.modelId !== id) fail("identity_mismatch");
  if (q.rateCardVersion !== getModel(id)!.rateCardVersion) fail("rate_card_unavailable");
  let fresh: ModelQuote;
  try { fresh = quoteModel(id, b, { at }); } catch { fail("invalid_quote"); }
  if (q.reservationPriceNanoUsd !== fresh.reservationPriceNanoUsd || q.reservationCredits !== fresh.reservationCredits) fail("quote_mismatch");
  if (q.estimatedCacheReadTokens > b.inputTokens || (q.estimatedCacheReadTokens > 0) !== (q.estimateBasis === "compatible_cache_scenario")) fail("invalid_quote");
  // Estimates may use a compatible cache scenario; they never reduce the uncached reservation.
  let estimated: number;
  try {
    estimated = costUsage({ provider: getModel(id)!.provider, modelId: id, at, rateCardVersion: q.rateCardVersion,
      inputMissTokens: b.inputTokens - q.estimatedCacheReadTokens, cacheReadTokens: q.estimatedCacheReadTokens,
      cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      totalInputTokens: b.inputTokens, outputTokens: b.outputTokens });
  } catch { fail("invalid_quote"); }
  if (q.estimatedCostNanoUsd !== estimated || q.estimatedPriceNanoUsd !== Math.ceil(estimated * CREDIT_MARKUP) ||
      q.estimatedCredits !== q.estimatedPriceNanoUsd / NANO_USD_PER_CREDIT || q.estimatedPriceNanoUsd > q.reservationPriceNanoUsd) fail("invalid_quote");
  return q;
}

const PREPARED_KEYS = ["version", "attemptId", "ownerId", "feature", "conversationId", "runId", "step", "selection", "modelId", "provider", "adapterVersion", "requestFormatVersion", "requestHash", "bounds", "pricingProfile", "quote", "preparedAt"] as const;
export function prepareAttempt(value: unknown, policy: ContractPolicy, stored = false): PreparedAttempt {
  const r = record(value, stored ? [...PREPARED_KEYS, "reviewFingerprint", "bindingFingerprint"] : PREPARED_KEYS);
  literal(r.version, 1);
  const id = modelId(r.modelId), p = provider(r.provider), model = getModel(id)!;
  if (model.provider !== p) fail("identity_mismatch");
  const selection = record(r.selection, ["mode"], ["modelId"]);
  const mode = choice(selection.mode, ["auto", "explicit"]);
  if ((mode === "auto" && Object.hasOwn(selection, "modelId")) || (mode === "explicit" && modelId(selection.modelId) !== id)) fail("identity_mismatch");
  const adapterVersion = identifier(r.adapterVersion), requestFormatVersion = identifier(r.requestFormatVersion);
  const requestHash = sha256(r.requestHash), preparedAt = timestamp(r.preparedAt);
  const bound = record(r.bounds, ["strategyId", "strategyVersion", "requestHash", "capabilities", "budget"]);
  const strategyId = identifier(bound.strategyId), strategyVersion = identifier(bound.strategyVersion);
  const boundHash = sha256(bound.requestHash), capabilities = set(bound.capabilities, CAPABILITIES), b = budget(bound.budget);
  if (boundHash !== requestHash) fail("request_mismatch");
  const review = policy.reviewedBounds.find((entry) => entry.strategyId === strategyId && entry.strategyVersion === strategyVersion &&
    entry.provider === p && entry.modelId === id && entry.adapterVersion === adapterVersion && entry.requestFormatVersion === requestFormatVersion);
  if (!review || !capabilities.includes("text") || capabilities.some((cap) => !review.capabilities.includes(cap)) ||
      !review.cacheTtls.includes(b.cacheTtl ?? model.cacheTtls[0])) fail("unreviewed_bounds");
  if (b.maxInputTokens > review.maxInputTokens || b.maxOutputTokens > review.maxOutputTokens) fail("bounds_exceeded");
  const feature = choice(r.feature, ["ask", "chat"]), runId = r.runId === null ? null : identifier(r.runId);
  const input: PreparedAttemptInput = {
    version: 1, attemptId: identifier(r.attemptId), ownerId: identifier(r.ownerId), feature,
    conversationId: identifier(r.conversationId), runId, step: count(r.step),
    selection: mode === "auto" ? { mode } : { mode, modelId: id }, modelId: id, provider: p,
    adapterVersion, requestFormatVersion, requestHash,
    bounds: { strategyId, strategyVersion, requestHash: boundHash, capabilities, budget: b },
    pricingProfile: literal(r.pricingProfile, "standard-global-text-v1"), quote: quote(r.quote, id, b, preparedAt), preparedAt,
  };
  const reviewFingerprint = fingerprint("bounds-review", review);
  const bindingFingerprint = fingerprint("prepared", { ...input, reviewFingerprint });
  if (stored && (sha256(r.reviewFingerprint) !== reviewFingerprint || sha256(r.bindingFingerprint) !== bindingFingerprint)) fail("identity_mismatch");
  return freeze({ ...input, reviewFingerprint, bindingFingerprint });
}

export function readHoldBinding(value: unknown, prepared: PreparedAttempt): HoldBinding {
  const r = record(value, ["holdId", "ownerId", "feature", "maxPriceNanoUsd", "reservedCredits", "bindingFingerprint"]);
  const result = { holdId: identifier(r.holdId), ownerId: identifier(r.ownerId), feature: choice(r.feature, ["ask", "chat"]),
    maxPriceNanoUsd: count(r.maxPriceNanoUsd, true), reservedCredits: count(r.reservedCredits, true), bindingFingerprint: sha256(r.bindingFingerprint) };
  if (result.bindingFingerprint !== prepared.bindingFingerprint || result.reservedCredits !== prepared.quote.reservationCredits ||
      result.maxPriceNanoUsd !== prepared.quote.reservationPriceNanoUsd || result.ownerId !== prepared.ownerId || result.feature !== prepared.feature) fail("hold_mismatch");
  return freeze(result);
}

function evidence(value: unknown): UsageEvidence {
  const base = record(value, ["kind"], ["usage", "reason", "reportHash", "provenance"]);
  const kind = choice(base.kind, ["none", "partial", "invalid", "unverified_final", "final"]);
  if (kind === "none") { record(value, ["kind"]); return { kind }; }
  if (kind === "invalid") {
    const r = record(value, ["kind", "reason", "reportHash"]);
    return { kind, reason: choice(r.reason, ["invalid_usage", "invalid_response"]), reportHash: r.reportHash === null ? null : sha256(r.reportHash) };
  }
  if (kind === "partial") { const r = record(value, ["kind", "usage"]); return { kind, usage: readUsage(r.usage) }; }
  if (kind === "unverified_final") {
    const r = record(value, ["kind", "usage", "reason"]);
    return { kind, usage: readUsage(r.usage), reason: choice(r.reason, ["identity_mismatch", "pricing_unverified", "invalid_response"]) };
  }
  const r = record(value, ["kind", "usage", "provenance"]);
  const p = record(r.provenance, ["source", "adapterVersion", "provider", "providerMessageId", "reportedModelId", "requestHash", "dispatchId", "rateCardVersion", "pricingProfile", "terminalEvent", "unsupportedCharges"]);
  return { kind, usage: readUsage(r.usage), provenance: {
    source: literal(p.source, "adapter_completed"), adapterVersion: identifier(p.adapterVersion), provider: provider(p.provider),
    providerMessageId: identifier(p.providerMessageId, 192), reportedModelId: identifier(p.reportedModelId), requestHash: sha256(p.requestHash),
    dispatchId: identifier(p.dispatchId), rateCardVersion: identifier(p.rateCardVersion), pricingProfile: identifier(p.pricingProfile),
    terminalEvent: literal(p.terminalEvent, "completed"), unsupportedCharges: boolean(p.unsupportedCharges),
  } };
}

export function readOutcome(value: unknown): AttemptOutcome {
  const r = record(value, ["attemptId", "holdId", "bindingFingerprint", "submission", "result", "observedAt", "usage"]);
  return freeze({
    attemptId: identifier(r.attemptId), holdId: identifier(r.holdId), bindingFingerprint: sha256(r.bindingFingerprint),
    submission: choice(r.submission, ["not_submitted", "submitted", "uncertain"]),
    result: choice(r.result, ["completed", "truncated", "refused", "failed", "cancelled"]),
    observedAt: timestamp(r.observedAt), usage: evidence(r.usage),
  });
}

/** Compare against a constructed known-field snapshot without serializing an unvalidated object. */
export function exactSnapshot(value: unknown, expected: unknown): void {
  if (expected === null || typeof expected !== "object") {
    if (!Object.is(value, expected)) fail("invalid_shape");
  } else if (Array.isArray(expected)) {
    const entries = array(value, expected.length);
    if (entries.length !== expected.length) fail("invalid_shape");
    entries.forEach((entry, i) => exactSnapshot(entry, expected[i]));
  } else {
    const expectedRecord = expected as Record<string, unknown>;
    const actual = record(value, Object.keys(expectedRecord));
    for (const key of Object.keys(expectedRecord)) exactSnapshot(actual[key], expectedRecord[key]);
  }
}
