import type { Database, Sql } from "../history/database.ts";

// Romanum credit accounting foundation.
//
// Credits are integer units of Romanum compute. One credit is worth one US cent
// (owner decision, 2026-09-27; see value.ts), but no pricing, payment processor
// or provider is involved here. Every mutation runs in one transaction, claims a
// unique operation ID (idempotency key) and appends an immutable audit row.
// Concurrent reservations lock the account row, so two of them can never
// overspend, and the database constraints back that up.
//
// Accounts are keyed by an opaque owner ID. Grants are only ever callable from
// trusted server code: the one client-facing route, /api/credits, grants a
// guest's fixed welcome credits once (guest.ts). Reads never create an account
// or hand out free credits.

export type CreditsErrorCode = "invalid_input" | "conflict" | "insufficient_balance" | "not_found" | "invalid_operation";

export class CreditsError extends Error {
  readonly code: CreditsErrorCode;
  constructor(code: CreditsErrorCode, message: string) {
    super(message);
    this.name = "CreditsError";
    this.code = code;
  }
}

export type Balance = { ownerId: string; balance: number; reserved: number; available: number };
export type ReservationStatus = "reserved" | "captured" | "released";
export type GrantResult = Balance & { operationId: string; amount: number; status: "granted" };
export type ReservationResult = Balance & { operationId: string; amount: number; status: ReservationStatus; capturedAmount: number | null };

type AccountRow = { balance: string | number; reserved: string | number };
type OperationRow = {
  operation_id: string; owner_id: string; kind: string; status: string;
  amount: string | number; captured_amount: string | number | null;
};

const asNumber = (value: string | number): number => (typeof value === "number" ? value : Number(value));

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.includes("\0")) {
    throw new CreditsError("invalid_input", `${field} must be a non-empty string of at most 200 characters.`);
  }
  return value;
}

// Credits are safe positive integers. Settled cost may be zero but never negative.
function credits(value: unknown, field: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CreditsError("invalid_input", `${field} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`);
  }
  return value;
}

async function readAccount(sql: Sql, ownerId: string): Promise<AccountRow | undefined> {
  const { rows } = await sql.query<AccountRow>("SELECT balance, reserved FROM credits_accounts WHERE owner_id=$1", [ownerId]);
  return rows[0];
}

// Row lock: concurrent reservations for one account serialize here before reading
// the available balance, so they cannot both pass the overspend check.
async function lockAccount(sql: Sql, ownerId: string): Promise<AccountRow | undefined> {
  const { rows } = await sql.query<AccountRow>("SELECT balance, reserved FROM credits_accounts WHERE owner_id=$1 FOR UPDATE", [ownerId]);
  return rows[0];
}

async function readOperation(sql: Sql, operationId: string): Promise<OperationRow | undefined> {
  const { rows } = await sql.query<OperationRow>("SELECT operation_id, owner_id, kind, status, amount, captured_amount FROM credits_operations WHERE operation_id=$1", [operationId]);
  return rows[0];
}

async function lockOperation(sql: Sql, operationId: string): Promise<OperationRow | undefined> {
  const { rows } = await sql.query<OperationRow>("SELECT operation_id, owner_id, kind, status, amount, captured_amount FROM credits_operations WHERE operation_id=$1 FOR UPDATE", [operationId]);
  return rows[0];
}

const stateOf = (ownerId: string, row: AccountRow | undefined): Balance => {
  const balance = row ? asNumber(row.balance) : 0;
  const reserved = row ? asNumber(row.reserved) : 0;
  return { ownerId, balance, reserved, available: balance - reserved };
};

// Reusing an idempotency key with different parameters is an error, never a
// silent second debit or grant.
function assertReuseMatches(row: OperationRow, ownerId: string, amount: number, kind: "grant" | "reserve") {
  if (row.kind !== kind || row.owner_id !== ownerId || asNumber(row.amount) !== amount) {
    throw new CreditsError("conflict", `Operation ${row.operation_id} was already used with different parameters.`);
  }
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === "23505";

async function updateAccount(sql: Sql, ownerId: string, balance: number, reserved: number) {
  await sql.query("UPDATE credits_accounts SET balance=$2, reserved=$3, updated_at=now() WHERE owner_id=$1", [ownerId, balance, reserved]);
}

async function insertOperation(sql: Sql, row: { operationId: string; ownerId: string; kind: "grant" | "reserve"; status: string; amount: number }) {
  await sql.query("INSERT INTO credits_operations(operation_id, owner_id, kind, status, amount) VALUES ($1,$2,$3,$4,$5)", [row.operationId, row.ownerId, row.kind, row.status, row.amount]);
}

async function appendEntry(sql: Sql, entry: { ownerId: string; entryType: string; status: string; operationId: string; amount: number; balanceChange: number; reservedChange: number; balance: number; reserved: number }) {
  await sql.query(
    "INSERT INTO credits_ledger(owner_id, entry_type, status, operation_id, amount, balance_change, reserved_change, balance_after, reserved_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [entry.ownerId, entry.entryType, entry.status, entry.operationId, entry.amount, entry.balanceChange, entry.reservedChange, entry.balance, entry.reserved],
  );
}

// Runs a keyed mutation idempotently: an existing operation replays its recorded
// result, and a race that violates the unique key replays instead of double-applying.
async function runKeyed<T>(database: Database, operationId: string, run: (sql: Sql) => Promise<T>, replay: (sql: Sql, row: OperationRow) => Promise<T>): Promise<T> {
  const prior = await readOperation(database, operationId);
  if (prior) return replay(database, prior);
  try {
    return await database.transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await readOperation(database, operationId);
      if (raced) return replay(database, raced);
    }
    throw error;
  }
}

/**
 * Trusted server call: credit an account. Never exposed to clients. Retrying the
 * same operation ID returns the original grant without crediting again.
 */
export async function grantCredits(database: Database, input: { ownerId: unknown; amount: unknown; operationId: unknown }): Promise<GrantResult> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const operationId = identifier(input?.operationId, "operationId");
  const amount = credits(input?.amount, "amount");
  const replay = async (sql: Sql, row: OperationRow): Promise<GrantResult> => {
    assertReuseMatches(row, ownerId, amount, "grant");
    return { ...stateOf(ownerId, await readAccount(sql, ownerId)), operationId, amount, status: "granted" };
  };
  return runKeyed(database, operationId, async (sql) => {
    const existing = await readOperation(sql, operationId);
    if (existing) return replay(sql, existing);
    await sql.query("INSERT INTO credits_accounts(owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING", [ownerId]);
    const account = (await lockAccount(sql, ownerId))!;
    // Another transaction may have committed the same grant while this one
    // waited for the account lock. Replay before balance arithmetic or writes.
    const raced = await readOperation(sql, operationId);
    if (raced) return replay(sql, raced);
    const balance = asNumber(account.balance) + amount;
    if (!Number.isSafeInteger(balance)) throw new CreditsError("invalid_input", "The resulting balance exceeds the safe credit limit.");
    const reserved = asNumber(account.reserved);
    await updateAccount(sql, ownerId, balance, reserved);
    await insertOperation(sql, { operationId, ownerId, kind: "grant", status: "granted", amount });
    await appendEntry(sql, { ownerId, entryType: "grant", status: "granted", operationId, amount, balanceChange: amount, reservedChange: 0, balance, reserved });
    return { ownerId, operationId, amount, status: "granted", balance, reserved, available: balance - reserved };
  }, replay);
}

/**
 * Hold credits for an operation before paid work starts. Idempotent per
 * operation ID, and refuses to hold more than the account has available.
 */
export async function reserveCredits(database: Database, input: { ownerId: unknown; amount: unknown; operationId: unknown }): Promise<ReservationResult> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const operationId = identifier(input?.operationId, "operationId");
  const amount = credits(input?.amount, "amount");
  const replay = async (sql: Sql, row: OperationRow): Promise<ReservationResult> => {
    assertReuseMatches(row, ownerId, amount, "reserve");
    return { ...stateOf(ownerId, await readAccount(sql, ownerId)), operationId, amount, status: row.status as ReservationStatus, capturedAmount: row.captured_amount === null ? null : asNumber(row.captured_amount) };
  };
  return runKeyed(database, operationId, async (sql) => {
    // Lock the account first, then re-check the key under that lock. A retry that
    // lost the race still replays here instead of seeing a depleted balance.
    const account = await lockAccount(sql, ownerId);
    const existing = await readOperation(sql, operationId);
    if (existing) return replay(sql, existing);
    if (!account || asNumber(account.balance) - asNumber(account.reserved) < amount) {
      throw new CreditsError("insufficient_balance", "Reservation exceeds the account's available credits.");
    }
    const balance = asNumber(account.balance);
    const reserved = asNumber(account.reserved) + amount;
    await insertOperation(sql, { operationId, ownerId, kind: "reserve", status: "reserved", amount });
    await updateAccount(sql, ownerId, balance, reserved);
    await appendEntry(sql, { ownerId, entryType: "reserve", status: "reserved", operationId, amount, balanceChange: 0, reservedChange: amount, balance, reserved });
    return { ownerId, operationId, amount, status: "reserved", capturedAmount: null, balance, reserved, available: balance - reserved };
  }, replay);
}

/**
 * Settle a reservation at its actual cost, which may be zero but never more than
 * was reserved. The held remainder becomes available again.
 */
export async function settleReservation(database: Database, input: { ownerId: unknown; operationId: unknown; actualCost: unknown }): Promise<ReservationResult> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const operationId = identifier(input?.operationId, "operationId");
  const actualCost = credits(input?.actualCost, "actualCost", true);
  return database.transaction(async (sql) => {
    const operation = await lockOperation(sql, operationId);
    if (!operation || operation.owner_id !== ownerId) throw new CreditsError("not_found", "Unknown operation for this account.");
    if (operation.kind !== "reserve") throw new CreditsError("invalid_operation", "Only reservations can be settled.");
    const account = await lockAccount(sql, operation.owner_id);
    if (!account) throw new CreditsError("not_found", "The account for this operation no longer exists.");
    const amount = asNumber(operation.amount);
    const balance = asNumber(account.balance);
    const reserved = asNumber(account.reserved);
    if (operation.status === "released") throw new CreditsError("invalid_operation", "Reservation was already released.");
    if (operation.status === "captured") {
      if (asNumber(operation.captured_amount!) !== actualCost) throw new CreditsError("conflict", "Reservation was already settled for a different amount.");
      return { ownerId: operation.owner_id, operationId, amount, status: "captured", capturedAmount: actualCost, balance, reserved, available: balance - reserved };
    }
    if (actualCost > amount) throw new CreditsError("conflict", "Settlement cost exceeds the reserved amount.");
    const nextBalance = balance - actualCost;
    const nextReserved = reserved - amount;
    await updateAccount(sql, operation.owner_id, nextBalance, nextReserved);
    await sql.query("UPDATE credits_operations SET status='captured', captured_amount=$2, updated_at=now() WHERE operation_id=$1", [operationId, actualCost]);
    await appendEntry(sql, { ownerId: operation.owner_id, entryType: "capture", status: "captured", operationId, amount: actualCost, balanceChange: -actualCost, reservedChange: -amount, balance: nextBalance, reserved: nextReserved });
    return { ownerId: operation.owner_id, operationId, amount, status: "captured", capturedAmount: actualCost, balance: nextBalance, reserved: nextReserved, available: nextBalance - nextReserved };
  });
}

/** Release a reservation after a failure, returning the full hold to the account. */
export async function releaseReservation(database: Database, input: { ownerId: unknown; operationId: unknown }): Promise<ReservationResult> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  const operationId = identifier(input?.operationId, "operationId");
  return database.transaction(async (sql) => {
    const operation = await lockOperation(sql, operationId);
    if (!operation || operation.owner_id !== ownerId) throw new CreditsError("not_found", "Unknown operation for this account.");
    if (operation.kind !== "reserve") throw new CreditsError("invalid_operation", "Only reservations can be released.");
    const account = await lockAccount(sql, operation.owner_id);
    if (!account) throw new CreditsError("not_found", "The account for this operation no longer exists.");
    const amount = asNumber(operation.amount);
    const balance = asNumber(account.balance);
    const reserved = asNumber(account.reserved);
    if (operation.status === "captured") throw new CreditsError("invalid_operation", "Reservation was already settled.");
    if (operation.status === "released") {
      return { ownerId: operation.owner_id, operationId, amount, status: "released", capturedAmount: null, balance, reserved, available: balance - reserved };
    }
    const nextReserved = reserved - amount;
    await updateAccount(sql, operation.owner_id, balance, nextReserved);
    await sql.query("UPDATE credits_operations SET status='released', updated_at=now() WHERE operation_id=$1", [operationId]);
    await appendEntry(sql, { ownerId: operation.owner_id, entryType: "release", status: "released", operationId, amount, balanceChange: 0, reservedChange: -amount, balance, reserved: nextReserved });
    return { ownerId: operation.owner_id, operationId, amount, status: "released", capturedAmount: null, balance, reserved: nextReserved, available: balance - nextReserved };
  });
}

/** Read an account's balance. Never creates an account or grants free credits. */
export async function getBalance(database: Database, input: { ownerId: unknown }): Promise<Balance> {
  const ownerId = identifier(input?.ownerId, "ownerId");
  return stateOf(ownerId, await readAccount(database, ownerId));
}
