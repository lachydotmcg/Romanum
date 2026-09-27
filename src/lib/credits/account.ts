import type { Database, Sql } from "../history/database.ts";
import { welcomeGuest } from "./guest.ts";
import { grantCredits, type Balance } from "./ledger.ts";

export const ACCOUNT_SIGNUP_CREDITS = 150;

// Compose the grants into the caller's transaction rather than committing them
// independently of account creation. The ledger still supplies the audit trail.
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: (operation) => operation(sql), close: async () => {} });

/**
 * Server-only: the account ID must come from a verified sign-in or session.
 * Existing accounts can claim their missing bonus on refresh. The permanent
 * grant key uses Roblox's user ID, never a cookie, session or mutable username.
 */
export async function welcomeAccount(database: Database, accountId: string): Promise<Balance> {
  return database.transaction(async (sql) => {
    const { rows } = await sql.query<{ owner_id: string; roblox_user_id: string | number }>(
      "SELECT owner_id, roblox_user_id FROM accounts WHERE id=$1 FOR UPDATE", [accountId],
    );
    const account = rows[0];
    if (!account) throw new Error("Account not found.");
    const tx = withinTransaction(sql);
    // Preserve the existing 50-credit welcome grant, including accounts created
    // before a guest cookie existed. Replaying it never restores spent credits.
    await welcomeGuest(tx, account.owner_id);
    const { balance, reserved, available } = await grantCredits(tx, {
      ownerId: account.owner_id,
      operationId: `signup:roblox:${account.roblox_user_id}`,
      amount: ACCOUNT_SIGNUP_CREDITS,
    });
    return { ownerId: account.owner_id, balance, reserved, available };
  });
}
