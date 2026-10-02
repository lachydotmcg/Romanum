import type { CacheTtl, ModelId, ModelQuote, ModelSelection, NormalizedUsage, ProviderId, TokenBudget } from "../types.ts";

/** Server-owned DTOs. A valid shape or fingerprint is never an authorization grant. */
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type Sha256 = string;
export type PricingProfile = "standard-global-text-v1";
export type Capability = "text" | "tools" | "images";
export type ReviewedBoundStrategy = Immutable<{
  strategyId: string; strategyVersion: string; provider: ProviderId; modelId: ModelId;
  adapterVersion: string; requestFormatVersion: string;
  capabilities: Capability[]; cacheTtls: CacheTtl[];
  maxInputTokens: number; maxOutputTokens: number;
}>;
/** Inject from reviewed server code, never request JSON, environment flags, or browser assertions. */
export type ContractPolicy = Immutable<{ reviewedBounds: ReviewedBoundStrategy[] }>;
export type PreparedAttemptInput = Immutable<{
  version: 1; attemptId: string; ownerId: string; feature: "ask" | "chat";
  conversationId: string; runId: string | null; step: number;
  selection: ModelSelection; modelId: ModelId; provider: ProviderId;
  adapterVersion: string; requestFormatVersion: string; requestHash: Sha256;
  bounds: {
    strategyId: string; strategyVersion: string; requestHash: Sha256;
    capabilities: Capability[]; budget: TokenBudget;
  };
  pricingProfile: PricingProfile; quote: ModelQuote; preparedAt: string;
}>;
export type PreparedAttempt = PreparedAttemptInput & Immutable<{
  reviewFingerprint: Sha256; bindingFingerprint: Sha256;
}>;
export type HoldBinding = Immutable<{
  holdId: string; ownerId: string; feature: "ask" | "chat";
  maxPriceNanoUsd: number; reservedCredits: number; bindingFingerprint: Sha256;
}>;
export type HeldAttempt = HoldBinding & Immutable<{ prepared: PreparedAttempt }>;
export type SubmissionInput = Immutable<{
  expectedRevision: number; dispatchId: string; requestHash: Sha256; submittedAt: string;
}>;
export type Submission = Immutable<{
  attemptId: string; holdId: string; bindingFingerprint: Sha256;
  dispatchId: string; requestHash: Sha256; submittedAt: string;
}>;

export type UsageEvidence = Immutable<
  | { kind: "none" }
  | { kind: "partial"; usage: NormalizedUsage }
  | { kind: "invalid"; reason: "invalid_usage" | "invalid_response"; reportHash: Sha256 | null }
  | { kind: "unverified_final"; usage: NormalizedUsage;
      reason: "identity_mismatch" | "pricing_unverified" | "invalid_response" }
  | { kind: "final"; usage: NormalizedUsage; provenance: {
      source: "adapter_completed"; adapterVersion: string; provider: ProviderId;
      providerMessageId: string; reportedModelId: string; requestHash: Sha256;
      dispatchId: string; rateCardVersion: string; pricingProfile: string;
      terminalEvent: "completed"; unsupportedCharges: boolean;
    } }
>;
export type AttemptOutcome = Immutable<{
  attemptId: string; holdId: string; bindingFingerprint: Sha256;
  submission: "not_submitted" | "submitted" | "uncertain";
  result: "completed" | "truncated" | "refused" | "failed" | "cancelled";
  observedAt: string; usage: UsageEvidence;
}>;
export type RetentionReason = "submission_unknown" | "usage_incomplete" | "identity_mismatch"
  | "unsupported_pricing" | "bounds_exceeded" | "quote_exceeded" | "reservation_exceeded"
  | "conflicting_evidence" | "rate_card_unavailable" | "invalid_usage" | "invalid_response";

/** Immutable accounting evidence only: no authorized price, debit, charge, or ledger receipt. */
export type SettlementCandidate = Immutable<{
  version: 1; attemptId: string; ownerId: string; feature: "ask" | "chat";
  conversationId: string; runId: string | null; step: number;
  holdId: string; bindingFingerprint: Sha256; dispatchId: string;
  providerMessageId: string; requestHash: Sha256; submittedAt: string;
  provider: ProviderId; modelId: ModelId; reportedModelId: string;
  adapterVersion: string; usage: NormalizedUsage; rateCardVersion: string;
  pricingProfile: PricingProfile; accountingPolicyVersion: "legacy-credit-policy-v1";
  fingerprint: Sha256;
}>;
export type AccountingDecision = Immutable<
  | { action: "release_unused"; attemptId: string; holdId: string; bindingFingerprint: Sha256 }
  | { action: "settle_candidate"; candidate: SettlementCandidate }
  | { action: "retain_for_reconciliation"; attemptId: string; holdId: string;
      bindingFingerprint: Sha256; reason: RetentionReason }
>;
export type AttemptState = Immutable<{
  version: 1; revision: number; phase: "held" | "submitted" | "retained" | "candidate" | "released";
  held: HeldAttempt; submission: Submission | null; uncertain: boolean;
  evidence: AttemptOutcome[]; decision: AccountingDecision | null;
}>;
/** Created ONLY by the future atomic ledger bridge; this module never constructs one. */
export type LedgerSettledReceipt = Immutable<{
  kind: "ledger_settled"; attemptId: string; holdId: string; candidateFingerprint: Sha256;
  ledgerReceiptId: string; settledAt: string;
}>;
export type RevisionCheck = Immutable<{ expectedRevision: number }>;
export type AccountingContract = {
  prepare(input: unknown): PreparedAttempt;
  validatePrepared(input: unknown): PreparedAttempt;
  hold(prepared: unknown, binding: unknown): AttemptState;
  submit(state: unknown, submission: unknown): AttemptState;
  decide(state: unknown, outcome: unknown, revision: unknown): AttemptState;
  validateState(state: unknown): AttemptState;
};
export type ContractErrorCode = "invalid_shape" | "invalid_identifier" | "invalid_timestamp"
  | "invalid_count" | "invalid_usage" | "invalid_budget" | "invalid_quote" | "unsupported_model"
  | "identity_mismatch" | "unreviewed_bounds" | "bounds_exceeded" | "request_mismatch"
  | "quote_mismatch" | "hold_mismatch" | "revision_conflict" | "invalid_transition"
  | "terminal_state" | "evidence_limit" | "rate_card_unavailable";
