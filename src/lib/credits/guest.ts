import type { Database } from "../history/database.ts";
import type { Balance } from "./ledger.ts";
import { grantWelcomeOnce } from "./grants.ts";

/** One-time starting balance for a new guest. */
export const GUEST_WELCOME_CREDITS = 10;

/**
 * Gives a guest its welcome credits once and returns its balance. The grant is keyed to the guest, so later
 * calls replay it instead of crediting again. Guests are anonymous, and a cleared cookie makes a new guest:
 * sign-in or abuse limits must come before credits can buy paid work in a public deployment.
 */
export async function welcomeGuest(database: Database, ownerId: string): Promise<Balance> {
  const { balance, reserved, available } = await grantWelcomeOnce(database, {
    ownerId,
    operationId: `welcome:${ownerId}`,
    amount: GUEST_WELCOME_CREDITS,
  });
  return { ownerId, balance, reserved, available };
}
