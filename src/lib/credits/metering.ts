import { randomUUID } from "node:crypto";
import type { AssistantEvent } from "../assistant/types.ts";
import type { Database, Sql } from "../history/database.ts";
import { reserveCredits, settleReservation } from "./ledger.ts";
import { callCost, isDeepSeekPeak, modelPricing, NANO_USD_PER_CREDIT, priceCalls, type CallUsage } from "./pricing.ts";

export type UsageCharge = {
  id: string;
  /** What the answer cost the user, in credits: usually a fraction of one. */
  credits: number;
  /** Whole credits taken from the balance now. The rest carries over to the owner's next answer. */
  charged: number;
  /** Provider cost, marked-up price and written-off shortfall, in nano-dollars. */
  cost: number;
  price: number;
  unpaid: number;
};

// Runs ledger operations inside the caller's transaction, so a charge and its ledger entries commit together.
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: (operation) => operation(sql), close: async () => {} });

/**
 * Charges an answer's model calls to its owner: the provider cost times the markup, in credits. Only whole
 * credits leave the ledger; the remainder carries over to the owner's next answer. If the balance can't cover
 * what's due, it goes to zero and the rest is recorded as unpaid and written off.
 */
export async function chargeUsage(
  database: Database,
  input: { ownerId: string; feature: "ask" | "chat"; calls: CallUsage[] },
): Promise<UsageCharge> {
  const calls = input.calls.map((call) => ({
    model: call.model,
    at: call.at.toISOString(),
    peak: modelPricing(call.model).offPeakRates ? isDeepSeekPeak(call.at) : null,
    input: call.input,
    cachedInput: call.cachedInput,
    cacheWrite: call.cacheWrite ?? 0,
    output: call.output,
    costNanoUsd: callCost(call),
  }));
  const { cost, price } = priceCalls(input.calls);
  const id = randomUUID();

  return database.transaction(async (sql) => {
    await sql.query("INSERT INTO usage_carry(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING", [input.ownerId]);
    const { rows: carry } = await sql.query<{ carry_nano_usd: string | number }>(
      "SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1 FOR UPDATE",
      [input.ownerId],
    );
    const total = Number(carry[0].carry_nano_usd) + price;
    const due = Math.floor(total / NANO_USD_PER_CREDIT);
    // Locked, so no other charge or reservation can change the balance before this one is taken.
    const { rows: accounts } = await sql.query<{ balance: string | number; reserved: string | number }>(
      "SELECT balance, reserved FROM credits_accounts WHERE owner_id=$1 FOR UPDATE",
      [input.ownerId],
    );
    const available = accounts[0] ? Number(accounts[0].balance) - Number(accounts[0].reserved) : 0;
    const charged = Math.max(0, Math.min(due, available));
    if (charged > 0) {
      const ledger = withinTransaction(sql);
      const operationId = `usage:${id}`;
      await reserveCredits(ledger, { ownerId: input.ownerId, operationId, amount: charged });
      await settleReservation(ledger, { ownerId: input.ownerId, operationId, actualCost: charged });
    }
    const unpaid = (due - charged) * NANO_USD_PER_CREDIT;
    await sql.query("UPDATE usage_carry SET carry_nano_usd=$2, updated_at=now() WHERE owner_id=$1", [input.ownerId, total - due * NANO_USD_PER_CREDIT]);
    await sql.query(
      "INSERT INTO usage_charges(id, owner_id, feature, calls, cost_nano_usd, price_nano_usd, credits_charged, unpaid_nano_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, input.ownerId, input.feature, JSON.stringify(calls), cost, price, charged, unpaid],
    );
    return { id, credits: price / NANO_USD_PER_CREDIT, charged, cost, price, unpaid };
  });
}

/**
 * Charges a streamed answer's model calls and sends its cost as the stream's last event. A failed charge is
 * logged and the answer stands.
 */
export async function chargeAnswer(
  database: Database,
  input: { ownerId: string; feature: "ask" | "chat"; calls: CallUsage[]; send: (event: AssistantEvent) => void },
) {
  if (!input.calls.length) return;
  try {
    const charge = await chargeUsage(database, input);
    input.send({ type: "usage", credits: charge.credits });
  } catch {
    console.error("Couldn't charge an answer's usage.");
  }
}
