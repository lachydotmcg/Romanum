import type { Database } from "../history/database.ts";
import { CreditsError, getBalance, grantCredits, type Balance } from "./ledger.ts";

/** Fixed welcome grants retain their original amount when the allowance changes. */
export async function grantWelcomeOnce(database: Database, input: { ownerId: string; operationId: string; amount: number }): Promise<Balance> {
  async function existing(): Promise<Balance | null> {
    const { rows } = await database.query<{ owner_id: string; kind: string; status: string }>(
      "SELECT owner_id,kind,status FROM credits_operations WHERE operation_id=$1", [input.operationId],
    );
    if (!rows[0]) return null;
    if (rows[0].owner_id !== input.ownerId || rows[0].kind !== "grant" || rows[0].status !== "granted") {
      throw new CreditsError("conflict", "Welcome grant belongs to another operation.");
    }
    return getBalance(database, { ownerId: input.ownerId });
  }
  const previous = await existing();
  if (previous) return previous;
  try { return await grantCredits(database, input); }
  catch (error) {
    // An older deployment can win the same grant during a rolling release.
    if (error instanceof CreditsError && error.code === "conflict") {
      const raced = await existing();
      if (raced) return raced;
    }
    throw error;
  }
}
