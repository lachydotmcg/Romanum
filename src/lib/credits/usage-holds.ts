import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "../history/database.ts";
import { CreditsError, releaseReservation, reserveCredits, settleReservation } from "./ledger.ts";
import { NANO_USD_PER_CREDIT, callCost, isDeepSeekPeak, modelPricing, priceCalls, type CallUsage } from "./pricing.ts";

// Bounded per-call credit reservations for metered AI usage.
//
// A hold quotes the most a single model call may cost the user (its marked-up
// price ceiling) and, before any provider work starts, reserves whole credits
// for it: ceil(quote / credit) + 1. The extra credit is deliberate -- an owner's
// fractional carry is added at settlement, and that carry can be up to one
// credit short of a whole credit, so the hold must be ample for both the call
// and the carry rounding. The ledger reservation and the durable hold row commit
// together, so an in-flight call can never be charged without a hold, and a hold
// can never linger without a reservation.
//
// Settlement then records the real usage exactly once. The feature and the
// ledger operation id are read from the hold, never from the caller, so a client
// cannot relabel a call or aim a settlement at someone else's reservation. A
// settlement that would cost more than the quote fails and leaves the hold held
// for reconciliation instead of silently writing the cost off. Replaying an
// identical settlement returns the saved result; replaying a different call is a
// conflict.
//
// When a provider's outcome is unknown (a timed-out or dropped request), the hold
// is marked uncertain and its reservation is kept: the cost may still be real,
// so it is never auto-released or auto-charged. It can settle later from the
// reported usage, and a settled hold is final.

export type UsageHoldStatus = "reserved" | "uncertain" | "settled" | "released";

type HoldRow = {
  id: string;
  owner_id: string;
  feature: string;
  operation_id: string;
  status: UsageHoldStatus;
  max_price_nano_usd: string | number;
  reserved_credits: string | number;
  settled_price_nano_usd: string | number | null;
  settled_credits_charged: string | number | null;
  call_fingerprint: string | null;
};

type NormalizedCall = { model: string; at: Date; input: number; cachedInput: number; cacheWrite: number; output: number };

const asNumber = (value: string | number): number => (typeof value === "number" ? value : Number(value));

// Runs ledger operations inside the caller's transaction, so the hold, the
// ledger reservation and the charge commit as one unit without nesting
// transactions.
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: (operation) => operation(sql), close: async () => {} });

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.includes("\0")) {
    throw new CreditsError("invalid_input", `${field} must be a non-empty string of at most 200 characters.`);
  }
  return value;
}

const HOLD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function holdId(value: unknown): string {
  if (typeof value !== "string" || !HOLD_ID.test(value)) throw new CreditsError("invalid_input", "id must be a usage hold UUID.");
  return value;
}

function featureOf(value: unknown): "ask" | "chat" {
  if (value !== "ask" && value !== "chat") throw new CreditsError("invalid_input", "feature must be 'ask' or 'chat'.");
  return value;
}

// The quote is the marked-up price ceiling in nano-dollars: a positive safe integer.
function quoteNanoUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CreditsError("invalid_input", "maxPriceNanoUsd must be a positive safe integer of nano-dollars.");
  }
  return value;
}

// ceil(quote / credit) + 1, computed with integer arithmetic so large quotes stay exact.
function heldCredits(maxPriceNanoUsd: number): number {
  const whole = Math.floor(maxPriceNanoUsd / NANO_USD_PER_CREDIT);
  const amount = whole + (maxPriceNanoUsd - whole * NANO_USD_PER_CREDIT > 0 ? 1 : 0) + 1;
  if (!Number.isSafeInteger(amount)) throw new CreditsError("invalid_input", "The reservation exceeds the safe credit limit.");
  return amount;
}

function tokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CreditsError("invalid_input", `${field} must be a finite non-negative safe integer.`);
  }
  return value;
}

function callTime(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new CreditsError("invalid_input", "call.at must be a valid date.");
  return value;
}

function callModel(value: unknown): string {
  if (typeof value !== "string") throw new CreditsError("invalid_input", "call.model must be a priced model.");
  // modelPricing throws for models without a recorded price; treat that as invalid input.
  try { modelPricing(value); } catch { throw new CreditsError("invalid_input", "call.model must be a priced model."); }
  return value;
}

function normalizeCall(value: unknown): NormalizedCall {
  if (!value || typeof value !== "object") throw new CreditsError("invalid_input", "call must be a model call.");
  const call = value as Partial<CallUsage>;
  return {
    model: callModel(call.model),
    at: callTime(call.at),
    input: tokenCount(call.input, "call.input"),
    cachedInput: tokenCount(call.cachedInput, "call.cachedInput"),
    cacheWrite: call.cacheWrite === undefined ? 0 : tokenCount(call.cacheWrite, "call.cacheWrite"),
    output: tokenCount(call.output, "call.output"),
  };
}

// A stable identity for a call, so an identical replay is recognised and any
// other call is a conflict.
function callFingerprint(call: NormalizedCall): string {
  const identity = JSON.stringify([call.model, call.at.toISOString(), call.input, call.cachedInput, call.cacheWrite, call.output]);
  return createHash("sha256").update(identity).digest("hex");
}

// The audit record written to usage_charges, matching the shape metering.ts uses.
const callRecord = (call: NormalizedCall) => ({
  model: call.model,
  at: call.at.toISOString(),
  peak: modelPricing(call.model).offPeakRates ? isDeepSeekPeak(call.at) : null,
  input: call.input,
  cachedInput: call.cachedInput,
  cacheWrite: call.cacheWrite,
  output: call.output,
  costNanoUsd: callCost(call),
});

async function lockHold(sql: Sql, id: string): Promise<HoldRow | undefined> {
  const { rows } = await sql.query<HoldRow>(
    "SELECT id, owner_id, feature, operation_id, status, max_price_nano_usd, reserved_credits, settled_price_nano_usd, settled_credits_charged, call_fingerprint FROM usage_holds WHERE id=$1 FOR UPDATE",
    [id],
  );
  return rows[0];
}

/**
 * Reserve bounded credits for one model call before it runs. Always called from
 * trusted server code; it never runs a provider. The reservation is
 * ceil(maxPriceNanoUsd / credit) + 1 credits, enough for the call and the
 * owner's fractional carry, and refuses to hold more than the account has
 * available.
 */
export async function reserveUsage(
  database: Database,
  input: { ownerId: string; feature: "ask" | "chat"; maxPriceNanoUsd: number },
): Promise<{ id: string; amount: number }> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const feature = featureOf(input?.feature);
  const maxPriceNanoUsd = quoteNanoUsd(input?.maxPriceNanoUsd);
  const id = randomUUID();
  const operationId = `model-call:${id}`;
  const amount = heldCredits(maxPriceNanoUsd);

  return database.transaction(async (sql) => {
    // The ledger reservation and the hold row are written under one transaction,
    // so a hold can never exist without the credits it claims to hold.
    await reserveCredits(withinTransaction(sql), { ownerId, operationId, amount });
    await sql.query(
      "INSERT INTO usage_holds(id, owner_id, feature, operation_id, status, max_price_nano_usd, reserved_credits) VALUES ($1,$2,$3,$4,'reserved',$5,$6)",
      [id, ownerId, feature, operationId, maxPriceNanoUsd, amount],
    );
    return { id, amount };
  });
}

/**
 * Settle a hold at the reported usage: charge the marked-up price, releasing the
 * unused part of the reservation. Replaying an identical call returns the saved
 * result; any other replay, or a cost above the quote, fails without touching the
 * hold.
 */
export async function settleUsage(
  database: Database,
  input: { ownerId: string; id: string; call: CallUsage },
): Promise<{ credits: number; charged: number }> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const id = holdId(input?.id);
  const call = normalizeCall(input?.call);
  const { cost, price } = priceCalls([call]);
  if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(price) || cost < 0 || price < 0) {
    throw new CreditsError("invalid_input", "Usage cost exceeds the safe accounting limit.");
  }
  const fingerprint = callFingerprint(call);

  return database.transaction(async (sql) => {
    const hold = await lockHold(sql, id);
    if (!hold || hold.owner_id !== ownerId) throw new CreditsError("not_found", "Unknown usage hold for this account.");

    if (hold.status === "settled") {
      // Idempotent replay: the same call returns the saved result, anything else is a conflict.
      if (hold.call_fingerprint !== fingerprint) throw new CreditsError("conflict", "Usage hold was already settled with a different call.");
      return {
        credits: asNumber(hold.settled_price_nano_usd ?? 0) / NANO_USD_PER_CREDIT,
        charged: asNumber(hold.settled_credits_charged ?? 0),
      };
    }
    if (hold.status === "released") throw new CreditsError("invalid_operation", "Usage hold was already released.");

    // Over-quote usage is never written off: fail and leave the hold held so an
    // operator can reconcile the real cost.
    if (price > asNumber(hold.max_price_nano_usd)) {
      throw new CreditsError("conflict", "Usage costs more than the reservation's quote.");
    }

    await sql.query("INSERT INTO usage_carry(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING", [ownerId]);
    const { rows: carryRows } = await sql.query<{ carry_nano_usd: string | number }>(
      "SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1 FOR UPDATE",
      [ownerId],
    );
    const total = asNumber(carryRows[0].carry_nano_usd) + price;
    const due = Math.floor(total / NANO_USD_PER_CREDIT);
    const remaining = total - due * NANO_USD_PER_CREDIT;
    if (due > asNumber(hold.reserved_credits)) throw new CreditsError("conflict", "Usage costs more credits than the reservation holds.");

    // Settles the ledger reservation in this same transaction (no nested BEGIN).
    await settleReservation(withinTransaction(sql), { ownerId, operationId: hold.operation_id, actualCost: due });

    const chargeId = randomUUID();
    await sql.query(
      "INSERT INTO usage_charges(id, owner_id, feature, calls, cost_nano_usd, price_nano_usd, credits_charged, unpaid_nano_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,0)",
      [chargeId, ownerId, hold.feature, JSON.stringify([callRecord(call)]), cost, price, due],
    );
    await sql.query("UPDATE usage_carry SET carry_nano_usd=$2, updated_at=now() WHERE owner_id=$1", [ownerId, remaining]);
    await sql.query(
      "UPDATE usage_holds SET status='settled', settled_charge_id=$2, settled_cost_nano_usd=$3, settled_price_nano_usd=$4, settled_credits_charged=$5, call_fingerprint=$6, updated_at=now() WHERE id=$1",
      [id, chargeId, cost, price, due, fingerprint],
    );
    return { credits: price / NANO_USD_PER_CREDIT, charged: due };
  });
}

/**
 * Close a hold whose call never reported usage. If the call definitely didn't
 * run, release the reservation. If the provider's outcome is uncertain, mark the
 * hold uncertain and keep the reservation for reconciliation. Idempotent: an
 * uncertain hold is never auto-released by a later report that it didn't run, and
 * a settled hold can never be reverted.
 */
export async function finishUnreportedUsage(
  database: Database,
  input: { ownerId: string; id: string; uncertain: boolean },
): Promise<void> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const id = holdId(input?.id);
  if (typeof input?.uncertain !== "boolean") throw new CreditsError("invalid_input", "uncertain must be a boolean.");

  await database.transaction(async (sql) => {
    const hold = await lockHold(sql, id);
    if (!hold || hold.owner_id !== ownerId) throw new CreditsError("not_found", "Unknown usage hold for this account.");
    // A settled or released hold is final; a late callback cannot change it.
    if (hold.status === "settled" || hold.status === "released") return;

    if (input.uncertain) {
      if (hold.status === "reserved") await sql.query("UPDATE usage_holds SET status='uncertain', updated_at=now() WHERE id=$1", [id]);
      return;
    }
    // Definitely not run, but an uncertain outcome is never auto-released: it may
    // still be charged from the provider's reported usage later.
    if (hold.status === "uncertain") return;
    await releaseReservation(withinTransaction(sql), { ownerId, operationId: hold.operation_id });
    await sql.query("UPDATE usage_holds SET status='released', updated_at=now() WHERE id=$1", [id]);
  });
}
