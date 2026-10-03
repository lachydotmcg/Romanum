import { CREDIT_MARKUP } from "../../credits/pricing.ts";
import { getModel } from "../catalog.ts";
import { reservationCredits } from "../estimate.ts";
import { ceilingCostUsage } from "../usage.ts";
import { NATIVE_BOUND_STRATEGY, NATIVE_BOUND_VERSION, NATIVE_INPUT_CAPACITY } from "../providers/native-capacity.ts";
import type { NormalizedUsage } from "../types.ts";
import type {
  AccountingContract, AccountingDecision, AttemptOutcome, AttemptState, ContractPolicy,
  HeldAttempt, RetentionReason, SettlementCandidate, Submission,
} from "./types.ts";
import {
  array, count, exactSnapshot, fail, fingerprint, freeze, identifier, prepareAttempt,
  readHoldBinding, readOutcome, record, sha256, timestamp, validatePolicy,
} from "./validate.ts";

export { ContractError } from "./validate.ts";
export const EMPTY_POLICY: ContractPolicy = freeze({ reviewedBounds: [] });
const MAX_EVIDENCE = 32;
const COUNTERS = ["inputMissTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "totalInputTokens", "outputTokens"] as const;

function revision(state: AttemptState, expected: unknown): void {
  if (count(expected) !== state.revision) fail("revision_conflict");
}
function active(state: AttemptState): void {
  if (state.phase === "candidate" || state.phase === "released") fail("terminal_state");
}
function initial(held: HeldAttempt): AttemptState {
  return freeze({ version: 1, revision: 0, phase: "held", held, submission: null, uncertain: false, evidence: [], decision: null });
}
function submit(state: AttemptState, value: unknown): AttemptState {
  const r = record(value, ["expectedRevision", "dispatchId", "requestHash", "submittedAt"]);
  revision(state, r.expectedRevision);
  active(state);
  if (state.phase !== "held" || state.submission !== null || state.uncertain) fail("invalid_transition");
  const requestHash = sha256(r.requestHash), submittedAt = timestamp(r.submittedAt);
  const p = state.held.prepared;
  if (requestHash !== p.requestHash) fail("request_mismatch");
  if (submittedAt < p.preparedAt) fail("invalid_timestamp");
  const submission: Submission = {
    attemptId: p.attemptId, holdId: state.held.holdId, bindingFingerprint: p.bindingFingerprint,
    dispatchId: identifier(r.dispatchId), requestHash, submittedAt,
  };
  // This is a durable-claim proposal. Its winning persisted CAS must precede any transport.
  return freeze({ ...state, revision: state.revision + 1, phase: "submitted", submission, uncertain: true });
}
function retain(state: AttemptState, reason: RetentionReason): AccountingDecision {
  return { action: "retain_for_reconciliation", attemptId: state.held.prepared.attemptId,
    holdId: state.held.holdId, bindingFingerprint: state.held.bindingFingerprint, reason };
}
function usageIdentity(usage: Readonly<NormalizedUsage>, state: AttemptState): boolean {
  const p = state.held.prepared;
  return usage.provider === p.provider && usage.modelId === p.modelId &&
    usage.at === state.submission?.submittedAt;
}
function validUsageTotals(usage: Readonly<NormalizedUsage>): boolean {
  const total = usage.inputMissTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  return Number.isSafeInteger(total) && total === usage.totalInputTokens &&
    Number.isSafeInteger(usage.totalInputTokens + usage.outputTokens);
}

function evaluate(state: AttemptState, outcome: AttemptOutcome): AccountingDecision {
  const p = state.held.prepared, evidence = outcome.usage, dispatch = state.submission;
  if (state.decision?.action === "retain_for_reconciliation" && state.decision.reason === "conflicting_evidence") return retain(state, "conflicting_evidence");
  const laterThan = state.evidence.length ? state.evidence[state.evidence.length - 1].observedAt : dispatch?.submittedAt ?? p.preparedAt;
  if (outcome.observedAt < laterThan) return retain(state, "conflicting_evidence");
  if (outcome.submission === "not_submitted") {
    if (state.uncertain || dispatch !== null) return retain(state, "submission_unknown");
    if (evidence.kind !== "none" || !["failed", "cancelled"].includes(outcome.result)) return retain(state, "conflicting_evidence");
    return { action: "release_unused", attemptId: p.attemptId, holdId: state.held.holdId, bindingFingerprint: p.bindingFingerprint };
  }
  if (dispatch === null || outcome.submission === "uncertain") return retain(state, "submission_unknown");
  if (evidence.kind === "none") return retain(state, "usage_incomplete");
  if (evidence.kind === "invalid") return retain(state, evidence.reason);
  const usage = evidence.usage;
  if (!usageIdentity(usage, state)) return retain(state, "identity_mismatch");
  if (usage.rateCardVersion !== p.quote.rateCardVersion || getModel(p.modelId)!.rateCardVersion !== p.quote.rateCardVersion) return retain(state, "rate_card_unavailable");
  if (!validUsageTotals(usage)) return retain(state, "invalid_usage");
  for (const prior of state.evidence) {
    const previous = prior.usage;
    if (previous.kind === "partial" && (!usageIdentity(previous.usage, state) ||
        previous.usage.rateCardVersion !== usage.rateCardVersion || !validUsageTotals(previous.usage) ||
        COUNTERS.some((key) => previous.usage[key] > usage[key]))) return retain(state, "conflicting_evidence");
  }
  if (evidence.kind === "partial") return retain(state, "usage_incomplete");
  if (evidence.kind === "unverified_final") return retain(state,
    evidence.reason === "pricing_unverified" ? "unsupported_pricing" : evidence.reason);
  const provenance = evidence.provenance;
  if (provenance.provider !== p.provider || provenance.adapterVersion !== p.adapterVersion ||
      provenance.reportedModelId !== p.modelId || provenance.requestHash !== p.requestHash ||
      provenance.dispatchId !== dispatch.dispatchId) return retain(state, "identity_mismatch");
  if (provenance.rateCardVersion !== p.quote.rateCardVersion) return retain(state, "rate_card_unavailable");
  if (provenance.pricingProfile !== p.pricingProfile || provenance.unsupportedCharges) return retain(state, "unsupported_pricing");
  // Current completed adapter union can include refusal/truncation. Its failed union proves no final attribution.
  if (outcome.result === "failed" || outcome.result === "cancelled") return retain(state, "invalid_response");
  // Earlier incomplete cumulative snapshots can grow. Conflicting final/invalid evidence requires reconciliation.
  let lastPartial: Readonly<NormalizedUsage> | null = null;
  for (const prior of state.evidence) {
    const previous = prior.usage;
    if (previous.kind === "none") continue;
    if (previous.kind !== "partial" || !usageIdentity(previous.usage, state) ||
        previous.usage.rateCardVersion !== usage.rateCardVersion || !validUsageTotals(previous.usage) ||
        COUNTERS.some((key) => previous.usage[key] > usage[key]) ||
        (lastPartial !== null && COUNTERS.some((key) => lastPartial![key] > previous.usage[key]))) return retain(state, "conflicting_evidence");
    lastPartial = previous.usage;
  }
  const budget = p.bounds.budget;
  if (p.bounds.strategyId === NATIVE_BOUND_STRATEGY && p.bounds.strategyVersion === NATIVE_BOUND_VERSION &&
      usage.totalInputTokens + usage.outputTokens > NATIVE_INPUT_CAPACITY[p.modelId]!) return retain(state, "bounds_exceeded");
  if (usage.totalInputTokens > budget.maxInputTokens || usage.outputTokens > budget.maxOutputTokens) return retain(state, "bounds_exceeded");
  let ceiling: number;
  try {
    // Eligibility ceiling only. The ledger's existing Math.round settlement policy is NOT replaced here.
    ceiling = Math.ceil(ceilingCostUsage(usage) * CREDIT_MARKUP);
    if (!Number.isSafeInteger(ceiling) || ceiling < 0) return retain(state, "invalid_usage");
  } catch { return retain(state, "unsupported_pricing"); }
  if (ceiling > p.quote.reservationPriceNanoUsd) return retain(state, "quote_exceeded");
  if (ceiling > 0 && reservationCredits(ceiling) > state.held.reservedCredits) return retain(state, "reservation_exceeded");
  const ttl = budget.cacheTtl ?? getModel(p.modelId)!.cacheTtls[0];
  if ((usage.cacheWriteTokens > 0 && ttl !== "30m") ||
      (usage.cacheWrite5mTokens > 0 && ttl !== "5m" && ttl !== "1h") ||
      (usage.cacheWrite1hTokens > 0 && ttl !== "1h")) return retain(state, "bounds_exceeded");
  const body = {
    version: 1 as const, attemptId: p.attemptId, ownerId: p.ownerId, feature: p.feature,
    conversationId: p.conversationId, runId: p.runId, step: p.step,
    holdId: state.held.holdId, bindingFingerprint: p.bindingFingerprint, dispatchId: dispatch.dispatchId,
    providerMessageId: provenance.providerMessageId, requestHash: p.requestHash, submittedAt: dispatch.submittedAt,
    provider: p.provider, modelId: p.modelId, reportedModelId: provenance.reportedModelId,
    adapterVersion: p.adapterVersion, usage, rateCardVersion: p.quote.rateCardVersion,
    pricingProfile: p.pricingProfile, accountingPolicyVersion: "legacy-credit-policy-v1" as const,
  };
  const candidate: SettlementCandidate = { ...body, fingerprint: fingerprint("candidate", body) };
  return { action: "settle_candidate", candidate };
}

function decide(state: AttemptState, outcome: AttemptOutcome): AttemptState {
  active(state);
  if (state.evidence.length >= MAX_EVIDENCE) fail("evidence_limit");
  if (outcome.attemptId !== state.held.prepared.attemptId || outcome.holdId !== state.held.holdId ||
      outcome.bindingFingerprint !== state.held.bindingFingerprint) fail("identity_mismatch");
  const decision = evaluate(state, outcome);
  const phase = decision.action === "settle_candidate" ? "candidate" : decision.action === "release_unused" ? "released" : "retained";
  return freeze({ ...state, revision: state.revision + 1, phase,
    // This flag is monotonic: candidate eligibility resolves accounting proof without erasing dispatch history.
    uncertain: state.uncertain || phase === "retained", evidence: [...state.evidence, outcome], decision });
}

/**
 * Pure snapshots and transition proposals only. No dispatch, hold, ledger, authorization or global uniqueness.
 * The default registry is empty; every review must originate in independently reviewed trusted server code.
 */
export function createAccountingContract(input: unknown = EMPTY_POLICY): AccountingContract {
  const policy = validatePolicy(input);
  const prepare = (value: unknown) => prepareAttempt(value, policy);
  const validatePrepared = (value: unknown) => prepareAttempt(value, policy, true);
  const hold = (preparedValue: unknown, value: unknown): AttemptState => {
    const prepared = validatePrepared(preparedValue), binding = readHoldBinding(value, prepared);
    return initial(freeze({ prepared, ...binding }));
  };
  const validateState = (value: unknown): AttemptState => {
    const r = record(value, ["version", "revision", "phase", "held", "submission", "uncertain", "evidence", "decision"]);
    const h = record(r.held, ["prepared", "holdId", "ownerId", "feature", "maxPriceNanoUsd", "reservedCredits", "bindingFingerprint"]);
    let rebuilt = hold(h.prepared, { holdId: h.holdId, ownerId: h.ownerId, feature: h.feature,
      maxPriceNanoUsd: h.maxPriceNanoUsd, reservedCredits: h.reservedCredits, bindingFingerprint: h.bindingFingerprint });
    if (r.submission !== null) {
      const s = record(r.submission, ["attemptId", "holdId", "bindingFingerprint", "dispatchId", "requestHash", "submittedAt"]);
      rebuilt = submit(rebuilt, { expectedRevision: 0, dispatchId: s.dispatchId, requestHash: s.requestHash, submittedAt: s.submittedAt });
      exactSnapshot(r.submission, rebuilt.submission);
    }
    for (const item of array(r.evidence, MAX_EVIDENCE)) rebuilt = decide(rebuilt, readOutcome(item));
    // Replaying the bounded history validates phase, revisions, monotonic uncertainty and derived decisions.
    exactSnapshot(value, rebuilt);
    return rebuilt;
  };
  return Object.freeze({
    prepare, validatePrepared, hold, validateState,
    submit(value: unknown, submissionValue: unknown) { return submit(validateState(value), submissionValue); },
    decide(value: unknown, outcomeValue: unknown, revisionValue: unknown) {
      const state = validateState(value), r = record(revisionValue, ["expectedRevision"]);
      revision(state, r.expectedRevision);
      return decide(state, readOutcome(outcomeValue));
    },
  });
}
