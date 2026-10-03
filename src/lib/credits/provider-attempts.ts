import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../history/database.ts";
import type { AccountingContract, AttemptOutcome, AttemptState, LedgerSettledReceipt, PreparedAttempt } from "../models/execution-accounting/types.ts";
import { fingerprint, identifier, readOutcome, sha256, timestamp } from "../models/execution-accounting/validate.ts";
import { costUsage } from "../models/usage.ts";
import { CreditsError, releaseReservation, reserveCredits, settleReservation } from "./ledger.ts";
import { NANO_USD_PER_CREDIT } from "./pricing.ts";
import { markedUpPrice, quotePricingPolicy } from "./pricing-policy.ts";
import { pricingHoldId } from "./hold-policy.ts";

type AttemptRow = {
  attempt_id: string; owner_id: string; hold_id: string; binding_fingerprint: string;
  state: unknown; last_outcome_hash: string | null; status: "open" | "candidate" | "settled" | "released";
  candidate_fingerprint: string | null; usage_charge_id: string | null; ledger_receipt: LedgerSettledReceipt | null;
};
type HoldRow = {
  owner_id: string; feature: string; operation_id: string; status: string;
  max_price_nano_usd: number | string; reserved_credits: number | string;
  call_fingerprint: string | null; settled_charge_id: string | null;
};
export type ProviderAttemptFinish = { state: AttemptState; chargedCredits: number; settled: boolean; priceNanoUsd: number };
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: operation => operation(sql), close: async () => {} });
function conflict(): never { throw new CreditsError("conflict", "Provider attempt conflicts with saved accounting evidence."); }
function notFound(): never { throw new CreditsError("not_found", "Unknown provider attempt for this account."); }

function savedState(row: AttemptRow, contract: AccountingContract): AttemptState {
  const state = contract.validateState(row.state), p = state.held.prepared;
  if (p.attemptId !== row.attempt_id || p.ownerId !== row.owner_id || state.held.holdId !== row.hold_id ||
      state.held.bindingFingerprint !== row.binding_fingerprint) conflict();
  if (row.status === "settled") {
    const receipt = row.ledger_receipt;
    if (state.decision?.action !== "settle_candidate" || !receipt || receipt.kind !== "ledger_settled" ||
        receipt.attemptId !== p.attemptId || receipt.holdId !== state.held.holdId ||
        receipt.candidateFingerprint !== state.decision.candidate.fingerprint ||
        row.candidate_fingerprint !== receipt.candidateFingerprint || !row.usage_charge_id) conflict();
    identifier(receipt.ledgerReceiptId); timestamp(receipt.settledAt);
  } else {
    if (row.ledger_receipt !== null || row.usage_charge_id !== null) conflict();
    if (row.status === "candidate") {
      if (state.decision?.action !== "settle_candidate" || row.candidate_fingerprint !== state.decision.candidate.fingerprint || !row.last_outcome_hash) conflict();
    } else if (row.candidate_fingerprint !== null ||
        (row.status === "released" ? state.phase !== "released" : ["candidate", "released"].includes(state.phase))) conflict();
  }
  return state;
}
async function readRow(sql: Sql, attemptId: string, ownerId: string, lock = false): Promise<AttemptRow | undefined> {
  return (await sql.query<AttemptRow>(`SELECT * FROM provider_attempts WHERE attempt_id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [attemptId, ownerId])).rows[0];
}
async function lockHold(sql: Sql, row: AttemptRow, state: AttemptState): Promise<HoldRow> {
  const hold = (await sql.query<HoldRow>("SELECT * FROM usage_holds WHERE id=$1 FOR UPDATE", [row.hold_id])).rows[0];
  if (!hold || hold.owner_id !== row.owner_id || hold.feature !== state.held.feature ||
      hold.operation_id !== `model-call:${row.hold_id}` || Number(hold.reserved_credits) !== state.held.reservedCredits ||
      Number(hold.max_price_nano_usd) !== state.held.maxPriceNanoUsd ||
      (row.status === "settled" ? hold.status !== "settled" || hold.call_fingerprint !== row.candidate_fingerprint || hold.settled_charge_id !== row.usage_charge_id
        : row.status === "released" ? hold.status !== "released" : !["reserved", "uncertain"].includes(hold.status))) conflict();
  return hold;
}
// Observation time may differ on delivery replay; attribution/counters must not.
function outcomeHash(outcome: AttemptOutcome): string {
  return fingerprint("provider-outcome", { attemptId: outcome.attemptId, holdId: outcome.holdId,
    bindingFingerprint: outcome.bindingFingerprint, submission: outcome.submission, result: outcome.result, usage: outcome.usage });
}
async function saveOpen(sql: Sql, row: AttemptRow, state: AttemptState, hash: string): Promise<void> {
  await sql.query("UPDATE provider_attempts SET state=$2, last_outcome_hash=$3, updated_at=now() WHERE attempt_id=$1", [row.attempt_id, JSON.stringify(state), hash]);
  await sql.query("UPDATE usage_holds SET status='uncertain', updated_at=now() WHERE id=$1 AND status='reserved'", [row.hold_id]);
}

/** Trusted server boundary only. Authorize owner and review policy before calling; never dispatches. */
export async function reserveProviderAttempt(db: Database, prepared: PreparedAttempt, contract: AccountingContract): Promise<AttemptState> {
  const p = contract.validatePrepared(prepared);
  return db.transaction(async sql => {
    // The absent-row case needs a transaction lock too. A duplicate ID cannot
    // race two independently generated wallet operation IDs into existence.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`provider-attempt:${p.attemptId}`]);
    const prior = (await sql.query<AttemptRow>("SELECT * FROM provider_attempts WHERE attempt_id=$1 FOR UPDATE", [p.attemptId])).rows[0];
    if (prior) {
      const state = savedState(prior, contract);
      if (prior.owner_id !== p.ownerId || prior.binding_fingerprint !== p.bindingFingerprint) conflict();
      await lockHold(sql, prior, state);
      return state;
    }
    const holdId = pricingHoldId(quotePricingPolicy(p.quote)), operationId = `model-call:${holdId}`;
    const state = contract.hold(p, { holdId, ownerId: p.ownerId, feature: p.feature,
      maxPriceNanoUsd: p.quote.reservationPriceNanoUsd, reservedCredits: p.quote.reservationCredits, bindingFingerprint: p.bindingFingerprint });
    await reserveCredits(withinTransaction(sql), { ownerId: p.ownerId, operationId, amount: p.quote.reservationCredits });
    await sql.query("INSERT INTO usage_holds(id,owner_id,feature,operation_id,status,max_price_nano_usd,reserved_credits) VALUES ($1,$2,$3,$4,'reserved',$5,$6)",
      [holdId, p.ownerId, p.feature, operationId, p.quote.reservationPriceNanoUsd, p.quote.reservationCredits]);
    await sql.query("INSERT INTO provider_attempts(attempt_id,owner_id,hold_id,binding_fingerprint,state,status) VALUES ($1,$2,$3,$4,$5,'open')",
      [p.attemptId, p.ownerId, holdId, p.bindingFingerprint, JSON.stringify(state)]);
    return state;
  });
}

/** The true result is returned only after the single durable dispatch claim commits. */
export async function submitProviderAttempt(db: Database, attemptId: string, ownerId: string, requestHash: string,
  contract: AccountingContract, at: string): Promise<{ state: AttemptState; dispatch: boolean }> {
  identifier(attemptId); identifier(ownerId); sha256(requestHash); timestamp(at);
  return db.transaction(async sql => {
    const row = await readRow(sql, attemptId, ownerId, true); if (!row) return notFound();
    const state = savedState(row, contract); await lockHold(sql, row, state);
    if (requestHash !== state.held.prepared.requestHash) conflict();
    if (state.phase !== "held" || state.submission !== null || state.uncertain) return { state, dispatch: false };
    const next = contract.submit(state, { expectedRevision: state.revision, dispatchId: randomUUID(), requestHash, submittedAt: at });
    await sql.query("UPDATE provider_attempts SET state=$2, updated_at=now() WHERE attempt_id=$1", [attemptId, JSON.stringify(next)]);
    // A crash after committing the claim remains uncertain even if no request
    // reached the provider. No retry or later definite-cancel can release it.
    await sql.query("UPDATE usage_holds SET status='uncertain', updated_at=now() WHERE id=$1", [row.hold_id]);
    return { state: next, dispatch: true };
  });
}

export async function readProviderAttempt(db: Database, attemptId: string, ownerId: string, contract: AccountingContract): Promise<AttemptState | null> {
  identifier(attemptId); identifier(ownerId);
  const row = await readRow(db, attemptId, ownerId);
  return row ? savedState(row, contract) : null;
}

/** Commit validated evidence/candidate before attempting wallet settlement.
 * A matching callback can retry accounting only; no transport or automatic retry occurs. */
export async function finishProviderAttempt(db: Database, attemptId: string, ownerId: string, outcome: AttemptOutcome,
  contract: AccountingContract): Promise<ProviderAttemptFinish> {
  identifier(attemptId); identifier(ownerId);
  const observed = readOutcome(outcome), hash = outcomeHash(observed);
  const ingested: ProviderAttemptFinish = await db.transaction(async sql => {
    const row = await readRow(sql, attemptId, ownerId, true); if (!row) return notFound();
    const state = savedState(row, contract), hold = await lockHold(sql, row, state);
    if (observed.attemptId !== attemptId || observed.holdId !== row.hold_id || observed.bindingFingerprint !== row.binding_fingerprint) conflict();
    if (row.last_outcome_hash === hash) return { state, chargedCredits: 0, settled: row.status === "settled", priceNanoUsd: 0 };
    // Never alter an already charged/released final state. Differing callbacks
    // are explicit conflicts, not another debit or a reverted reservation.
    if (row.status !== "open") return conflict();
    let next = contract.decide(state, observed, { expectedRevision: state.revision });
    if (next.decision?.action === "retain_for_reconciliation") {
      await saveOpen(sql, row, next, hash);
      return { state: next, chargedCredits: 0, settled: false, priceNanoUsd: 0 };
    }
    if (next.decision?.action === "release_unused") {
      await releaseReservation(withinTransaction(sql), { ownerId, operationId: hold.operation_id });
      await sql.query("UPDATE usage_holds SET status='released', updated_at=now() WHERE id=$1", [row.hold_id]);
      await sql.query("UPDATE provider_attempts SET state=$2,status='released',last_outcome_hash=$3,updated_at=now() WHERE attempt_id=$1", [attemptId, JSON.stringify(next), hash]);
      return { state: next, chargedCredits: 0, settled: false, priceNanoUsd: 0 };
    }
    if (next.decision?.action !== "settle_candidate") return conflict();
    const candidate = next.decision.candidate;
    const claim = await sql.query("INSERT INTO provider_final_claims(provider,provider_message_id,attempt_id,candidate_fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,provider_message_id) DO NOTHING RETURNING attempt_id",
      [candidate.provider, candidate.providerMessageId, attemptId, candidate.fingerprint]);
    if (!claim.rows.length) {
      // Another attempt already attributed this provider response. Preserve the
      // reservation, without authorizing a candidate or contaminating carry.
      next = contract.decide(state, { ...observed, usage: { kind: "unverified_final", usage: candidate.usage, reason: "identity_mismatch" } }, { expectedRevision: state.revision });
      await saveOpen(sql, row, next, hash);
      return { state: next, chargedCredits: 0, settled: false, priceNanoUsd: 0 };
    }
    await sql.query("UPDATE provider_attempts SET state=$2,status='candidate',last_outcome_hash=$3,candidate_fingerprint=$4,updated_at=now() WHERE attempt_id=$1",
      [attemptId, JSON.stringify(next), hash, candidate.fingerprint]);
    await sql.query("UPDATE usage_holds SET status='uncertain',updated_at=now() WHERE id=$1", [row.hold_id]);
    return { state: next, chargedCredits: 0, settled: false, priceNanoUsd: 0 };
  });
  if (ingested.state.phase === "candidate" && !ingested.settled) return settleProviderAttempt(db, attemptId, ownerId, contract);
  return ingested;
}

/** Explicit accounting-only retry from durable evidence. Never calls a provider.
 * Revalidates current contract/rate card/bounds and the saved global final claim,
 * then commits capture, carry, usage charge and ledger receipt as one unit. */
export async function settleProviderAttempt(db: Database, attemptId: string, ownerId: string,
  contract: AccountingContract): Promise<ProviderAttemptFinish> {
  identifier(attemptId); identifier(ownerId);
  return db.transaction(async sql => {
    const row = await readRow(sql, attemptId, ownerId, true); if (!row) return notFound();
    const state = savedState(row, contract), hold = await lockHold(sql, row, state);
    if (row.status === "settled") return { state, chargedCredits: 0, settled: true, priceNanoUsd: 0 };
    if (row.status !== "candidate" || state.decision?.action !== "settle_candidate") {
      throw new CreditsError("invalid_operation", "Only a durable settlement candidate can be charged.");
    }
    const candidate = state.decision.candidate;
    const claim = (await sql.query<{ attempt_id: string; candidate_fingerprint: string }>(
      "SELECT attempt_id,candidate_fingerprint FROM provider_final_claims WHERE provider=$1 AND provider_message_id=$2 FOR UPDATE",
      [candidate.provider, candidate.providerMessageId])).rows[0];
    if (!claim || claim.attempt_id !== attemptId || claim.candidate_fingerprint !== candidate.fingerprint) return conflict();
    const policy = quotePricingPolicy(state.held.prepared.quote);
    const cost = costUsage(candidate.usage, policy), price = markedUpPrice(cost, policy);
    if (!Number.isSafeInteger(price) || price < 0 || price > state.held.maxPriceNanoUsd) return conflict();
    await sql.query("INSERT INTO usage_carry(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING", [ownerId]);
    const carry = (await sql.query<{ carry_nano_usd: string | number }>("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1 FOR UPDATE", [ownerId])).rows[0];
    const total = Number(carry.carry_nano_usd) + price;
    if (!Number.isSafeInteger(total)) return conflict();
    const due = Math.floor(total / NANO_USD_PER_CREDIT), remaining = total - due * NANO_USD_PER_CREDIT;
    if (due > state.held.reservedCredits) return conflict();
    await settleReservation(withinTransaction(sql), { ownerId, operationId: hold.operation_id, actualCost: due });
    const chargeId = randomUUID();
    // Legacy historical display/SQL aggregates read model/input/cachedInput/
    // output. These aliases describe the same counters once; financial pricing
    // above uses only normalized usage with distinct 5m/1h cache write rates.
    const auditCall = { format: "normalized-usage-v1", ...candidate.usage, pricingPolicyVersion: policy, model: candidate.modelId,
      input: candidate.usage.inputMissTokens, cachedInput: candidate.usage.cacheReadTokens, output: candidate.usage.outputTokens,
      costNanoUsd: cost, candidateFingerprint: candidate.fingerprint };
    await sql.query("INSERT INTO usage_charges(id,owner_id,feature,calls,cost_nano_usd,price_nano_usd,credits_charged,unpaid_nano_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,0)",
      [chargeId, ownerId, state.held.feature, JSON.stringify([auditCall]), cost, price, due]);
    await sql.query("UPDATE usage_carry SET carry_nano_usd=$2,updated_at=now() WHERE owner_id=$1", [ownerId, remaining]);
    const capture = (await sql.query<{ id: string | number }>("SELECT id FROM credits_ledger WHERE operation_id=$1 AND entry_type='capture'", [hold.operation_id])).rows;
    if (capture.length !== 1) return conflict();
    const receipt: LedgerSettledReceipt = { kind: "ledger_settled", attemptId, holdId: row.hold_id,
      candidateFingerprint: candidate.fingerprint, ledgerReceiptId: `ledger:${capture[0].id}`, settledAt: new Date().toISOString() };
    await sql.query("UPDATE usage_holds SET status='settled',settled_charge_id=$2,settled_cost_nano_usd=$3,settled_price_nano_usd=$4,settled_credits_charged=$5,call_fingerprint=$6,updated_at=now() WHERE id=$1",
      [row.hold_id, chargeId, cost, price, due, candidate.fingerprint]);
    await sql.query("UPDATE provider_attempts SET status='settled',usage_charge_id=$2,ledger_receipt=$3,updated_at=now() WHERE attempt_id=$1",
      [attemptId, chargeId, JSON.stringify(receipt)]);
    return { state, chargedCredits: due, settled: true, priceNanoUsd: price };
  });
}
