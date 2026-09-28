import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../history/database.ts";
import { CreditsError, reserveCredits, releaseReservation, settleReservation } from "./ledger.ts";
import { NANO_USD_PER_CREDIT } from "./pricing.ts";
import { isBilledTool, TOOL_FEE_NANO_USD } from "./tool-pricing.ts";

const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: operation => operation(sql), close: async () => {} });
type ToolUsage = {
  id: string; owner_id: string; feature: "ask" | "chat"; tool_name: string;
  price_nano_usd: string | number; status: "reserved" | "settled" | "released";
  credits_charged: number | null;
};

/** Hold one whole credit: the fixed fee plus any fractional carry can debit at most one. */
export async function reserveToolUsage(database: Database, input: { ownerId: string; feature: "ask" | "chat"; tool: string }): Promise<string> {
  if (!isBilledTool(input.tool) || !["ask", "chat"].includes(input.feature)) {
    throw new CreditsError("invalid_input", "Unknown hosted tool tariff.");
  }
  const id = randomUUID();
  return database.transaction(async sql => {
    await reserveCredits(withinTransaction(sql), { ownerId: input.ownerId, operationId: `tool-call:${id}`, amount: 1 });
    await sql.query(
      "INSERT INTO tool_usage(id,owner_id,feature,tool_name,price_nano_usd,status) VALUES($1,$2,$3,$4,$5,'reserved')",
      [id, input.ownerId, input.feature, input.tool, TOOL_FEE_NANO_USD],
    );
    return id;
  });
}

/** Success captures the fixed fee once; a failed or cancelled lookup releases its hold. */
export async function finishToolUsage(database: Database, input: { ownerId: string; id: string; success: boolean }): Promise<number> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) || typeof input.success !== "boolean") {
    throw new CreditsError("invalid_input", "Invalid tool settlement.");
  }
  return database.transaction(async sql => {
    const { rows } = await sql.query<ToolUsage>("SELECT * FROM tool_usage WHERE id=$1 AND owner_id=$2 FOR UPDATE", [input.id, input.ownerId]);
    const hold = rows[0];
    if (!hold) throw new CreditsError("not_found", "Unknown tool usage for this account.");
    if (hold.status !== "reserved") {
      if ((hold.status === "settled") !== input.success) throw new CreditsError("conflict", "Tool usage already finished with another outcome.");
      return input.success ? Number(hold.price_nano_usd) / NANO_USD_PER_CREDIT : 0;
    }
    const ledger = withinTransaction(sql);
    const operationId = `tool-call:${hold.id}`;
    if (!input.success) {
      await releaseReservation(ledger, { ownerId: hold.owner_id, operationId });
      await sql.query("UPDATE tool_usage SET status='released',updated_at=now() WHERE id=$1", [hold.id]);
      return 0;
    }

    // Match model settlement lock ordering: usage row -> carry -> credit ledger.
    await sql.query("INSERT INTO usage_carry(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING", [hold.owner_id]);
    const { rows: carry } = await sql.query<{ carry_nano_usd: string | number }>(
      "SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1 FOR UPDATE", [hold.owner_id],
    );
    const price = Number(hold.price_nano_usd);
    const total = Number(carry[0].carry_nano_usd) + price;
    const due = Math.floor(total / NANO_USD_PER_CREDIT);
    await settleReservation(ledger, { ownerId: hold.owner_id, operationId, actualCost: due });
    const chargeId = randomUUID();
    await sql.query(
      "INSERT INTO usage_charges(id,owner_id,feature,calls,tools,cost_nano_usd,price_nano_usd,credits_charged) VALUES($1,$2,$3,'[]',$4,0,$5,$6)",
      [chargeId, hold.owner_id, hold.feature, JSON.stringify([{ name: hold.tool_name, priceNanoUsd: price }]), price, due],
    );
    await sql.query("UPDATE usage_carry SET carry_nano_usd=$2,updated_at=now() WHERE owner_id=$1", [hold.owner_id, total - due * NANO_USD_PER_CREDIT]);
    await sql.query("UPDATE tool_usage SET status='settled',credits_charged=$2,charge_id=$3,updated_at=now() WHERE id=$1", [hold.id, due, chargeId]);
    return price / NANO_USD_PER_CREDIT;
  });
}
