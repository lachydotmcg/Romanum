import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database, Sql } from "../history/database.ts";
import { welcomeAccount } from "../credits/account.ts";
import type { RobloxProfile } from "./roblox-oauth.ts";

// Accounts and their signed-in sessions. A session token is 32 random bytes that only the browser holds; the
// database keeps its SHA-256 hash, so a copy of the database can't sign anyone in.

export type Account = {
  id: string;
  /** Keys the account's credits and chats. */
  ownerId: string;
  robloxUserId: number;
  username: string;
  displayName: string;
  pictureUrl: string | null;
};

export const SESSION_DAYS = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COLUMNS = "a.id, a.owner_id, a.roblox_user_id, a.username, a.display_name, a.picture_url";

type AccountRow = { id: string; owner_id: string; roblox_user_id: string | number; username: string; display_name: string; picture_url: string | null };

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  ownerId: row.owner_id,
  robloxUserId: Number(row.roblox_user_id),
  username: row.username,
  displayName: row.display_name,
  pictureUrl: row.picture_url,
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const withinTransaction = (sql: Sql): Database => ({ ...sql, transaction: (operation) => operation(sql), close: async () => {} });

/**
 * Signs a Roblox user in to their account, creating it at their first sign-in. A new account adopts the signing-in
 * guest's owner ID, so that guest's credits and chats become the account's. Later sign-ins refresh the names and
 * headshot, and leave any other guest's data with that guest.
 */
export async function signInAccount(
  database: Database,
  profile: RobloxProfile,
  guestOwnerId: string | null,
): Promise<{ account: Account; adoptedGuest: boolean }> {
  return database.transaction(async (sql) => {
    const names = [profile.username, profile.displayName, profile.pictureUrl];
    const { rows: existing } = await sql.query<AccountRow>(
      `UPDATE accounts a SET username=$2, display_name=$3, picture_url=$4, signed_in_at=now() WHERE roblox_user_id=$1 RETURNING ${COLUMNS}`,
      [profile.userId, ...names],
    );
    if (existing[0]) {
      await welcomeAccount(withinTransaction(sql), existing[0].id);
      return { account: toAccount(existing[0]), adoptedGuest: false };
    }

    // A guest belongs to at most one account.
    const adoptable =
      guestOwnerId !== null &&
      guestOwnerId.startsWith("guest:") &&
      (await sql.query("SELECT 1 FROM accounts WHERE owner_id=$1 UNION ALL SELECT 1 FROM account_closures WHERE owner_id=$1", [guestOwnerId])).rows.length === 0;
    const id = randomUUID();
    const ownerId = adoptable ? guestOwnerId : `account:${id}`;
    // A concurrent first sign-in by the same person may have created the account a moment ago; use theirs.
    const { rows } = await sql.query<AccountRow>(
      `INSERT INTO accounts AS a (id, roblox_user_id, owner_id, username, display_name, picture_url) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (roblox_user_id) DO UPDATE SET username=EXCLUDED.username, display_name=EXCLUDED.display_name, picture_url=EXCLUDED.picture_url, signed_in_at=now()
       RETURNING ${COLUMNS}`,
      [id, profile.userId, ownerId, ...names],
    );
    await welcomeAccount(withinTransaction(sql), rows[0].id);
    return { account: toAccount(rows[0]), adoptedGuest: adoptable && rows[0].id === id };
  });
}

/** Starts a session for the account and returns its token, which only the browser's cookie keeps. */
export async function startSession(database: Database, accountId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await database.query("INSERT INTO account_sessions(token_hash, account_id, expires_at) VALUES ($1,$2,$3)", [hashToken(token), accountId, expiresAt]);
  await database.query("DELETE FROM account_sessions WHERE account_id=$1 AND expires_at <= now()", [accountId]);
  return { token, expiresAt };
}

/** The account a session token signs in, or null for a missing, malformed, expired or ended session. */
export async function sessionAccount(database: Database, token: string | null | undefined): Promise<Account | null> {
  if (!token || !TOKEN.test(token)) return null;
  const { rows } = await database.query<AccountRow>(
    `SELECT ${COLUMNS} FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/** Ends a session, as signing out does. */
export async function endSession(database: Database, token: string | null | undefined): Promise<void> {
  if (!token || !TOKEN.test(token)) return;
  await database.query("DELETE FROM account_sessions WHERE token_hash=$1", [hashToken(token)]);
}
