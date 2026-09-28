import type { Database, Sql } from "../history/database.ts";
import { getBalance, grantCredits, type Balance } from "./ledger.ts";

export const WEEKLY_FREE_CREDITS = 25;
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: operation => operation(sql), close: async () => {} });

/** Match account closure's order: owner advisory lock before the account row. */
export async function lockCreditOwner(sql: Sql, accountId: string): Promise<void> {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(owner_id,0)) FROM accounts WHERE id=$1", [accountId]);
}

/** Calendar weeks start Monday at 00:00 UTC, independent of browser timezone. */
export function creditWeek(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error("Invalid credit week.");
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return start.toISOString().slice(0, 10);
}

/** Only call with an account ID resolved from a verified session or sign-in. */
export async function applyWeeklyCreditFloor(database: Database, accountId: string, now = new Date()): Promise<Balance> {
  const week = creditWeek(now);
  return database.transaction(async sql => {
    await lockCreditOwner(sql, accountId);
    const { rows } = await sql.query<{ owner_id: string; roblox_user_id: string | number; credit_plan: string }>(
      "SELECT owner_id,roblox_user_id,credit_plan FROM accounts WHERE id=$1 FOR UPDATE", [accountId],
    );
    const account = rows[0];
    if (!account) throw new Error("Account not found.");
    if (account.credit_plan !== "free") return getBalance(withinTransaction(sql), { ownerId: account.owner_id });
    // Count held credits in the balance. Reserving work must not create a larger
    // refill that remains in the account after the reservation is released.
    const { rows: balances } = await sql.query<{ balance: string | number }>(
      "SELECT balance FROM credits_accounts WHERE owner_id=$1 FOR UPDATE", [account.owner_id],
    );
    const amount = Math.max(0, WEEKLY_FREE_CREDITS - Number(balances[0]?.balance ?? 0));
    const claim = await sql.query(
      `INSERT INTO weekly_credit_claims(roblox_user_id,week_start,owner_id,amount) VALUES($1,$2,$3,$4)
       ON CONFLICT(roblox_user_id,week_start) DO NOTHING RETURNING amount`,
      [account.roblox_user_id, week, account.owner_id, amount],
    );
    const tx = withinTransaction(sql);
    if (!claim.rows.length || amount === 0) return getBalance(tx, { ownerId: account.owner_id });
    return grantCredits(tx, {
      ownerId: account.owner_id,
      operationId: `weekly:roblox:${account.roblox_user_id}:${week}`,
      amount,
    });
  });
}
