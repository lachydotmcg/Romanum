import type { Database } from "../history/database.ts";
import { grantCredits, type Balance } from "./ledger.ts";

/** Free credits each new guest starts with (owner decision, 2026-09-27): 50 credits, worth $0.50. */
export const GUEST_WELCOME_CREDITS = 50;

/**
 * Gives a guest its welcome credits once and returns its balance. The grant is keyed to the guest, so later
 * calls replay it instead of crediting again. Guests are anonymous, and a cleared cookie makes a new guest:
 * sign-in or abuse limits must come before credits can buy paid work in a public deployment.
 */
export async function welcomeGuest(database: Database, ownerId: string): Promise<Balance> {
  const { balance, reserved, available } = await grantCredits(database, {
    ownerId,
    operationId: `welcome:${ownerId}`,
    amount: GUEST_WELCOME_CREDITS,
  });
  return { ownerId, balance, reserved, available };
}
