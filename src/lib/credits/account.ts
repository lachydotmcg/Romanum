import type { Database, Sql } from "../history/database.ts";
import { welcomeGuest } from "./guest.ts";
import type { Balance } from "./ledger.ts";
import { grantWelcomeOnce } from "./grants.ts";
import { applyWeeklyCreditFloor, lockCreditOwner } from "./weekly.ts";

export const ACCOUNT_SIGNUP_CREDITS = 100;

// Compose the grants into the caller's transaction rather than committing them
// independently of account creation. The ledger still supplies the audit trail.
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: (operation) => operation(sql), close: async () => {} });

/**
 * Server-only: the account ID must come from a verified sign-in or session.
 * Existing accounts can claim their missing bonus on refresh. The permanent
 * grant key uses Roblox's user ID, never a cookie, session or mutable username.
 */
export async function welcomeAccount(database: Database, accountId: string, now = new Date()): Promise<Balance> {
  return database.transaction(async (sql) => {
    await lockCreditOwner(sql, accountId);
    const { rows } = await sql.query<{ owner_id: string; roblox_user_id: string | number }>(
      "SELECT owner_id, roblox_user_id FROM accounts WHERE id=$1 FOR UPDATE", [accountId],
    );
    const account = rows[0];
    if (!account) throw new Error("Account not found.");
    const tx = withinTransaction(sql);
    // Preserve any existing welcome grant, including accounts created
    // before a guest cookie existed. Replaying it never restores spent credits.
    await welcomeGuest(tx, account.owner_id);
    // A person can return after deleting their account, but deletion must not
    // transfer the old balance or award the one-time Roblox bonus again.
    const previous = await sql.query(
      `SELECT 1 FROM credits_operations o JOIN account_closures c ON c.owner_id=o.owner_id
       WHERE o.operation_id=$1 AND o.kind='grant' AND o.status='granted' AND o.owner_id<>$2`,
      [`signup:roblox:${account.roblox_user_id}`, account.owner_id],
    );
    if (!previous.rows.length) {
      await grantWelcomeOnce(tx, {
        ownerId: account.owner_id,
        operationId: `signup:roblox:${account.roblox_user_id}`,
        amount: ACCOUNT_SIGNUP_CREDITS,
      });
    }
    return applyWeeklyCreditFloor(tx, accountId, now);
  });
}
