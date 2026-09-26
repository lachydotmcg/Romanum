-- Romanum credit accounting foundation. No payment or provider is enabled.
-- Credits are opaque integer units of Romanum compute, never currency or cash.
-- Public analytics, search and the read-only MCP slice stay free: nothing here
-- gates a read. Accounts are keyed by an opaque owner ID; no client API exists,
-- so grants are only ever callable by trusted server code.

CREATE TABLE credits_accounts (
  owner_id text PRIMARY KEY,
  -- balance is everything credited minus everything settled; reserved is the
  -- outstanding total held by in-flight operations. available = balance - reserved.
  balance bigint NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 9007199254740991),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Backstop for the row-locked checks in the ledger: a reservation can never
  -- push an account past its balance, even if application logic regresses.
  CONSTRAINT credits_accounts_available_non_negative CHECK (balance >= reserved)
);

-- One row per idempotency key. operation_id is globally unique, so retrying a
-- grant or reservation with the same key never double-debits or double-credits.
CREATE TABLE credits_operations (
  operation_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES credits_accounts(owner_id),
  kind text NOT NULL CHECK (kind IN ('grant','reserve')),
  status text NOT NULL CHECK (status IN ('granted','reserved','captured','released')),
  -- Reserve amount, or granted amount. Always a positive integer of credits.
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
  -- Actual settled cost. Present only once a reservation is captured.
  captured_amount bigint CHECK (captured_amount IS NULL OR (captured_amount >= 0 AND captured_amount <= amount)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credits_operations_captured_matches_status CHECK ((status = 'captured') = (captured_amount IS NOT NULL)),
  CONSTRAINT credits_operations_grant_status CHECK ((kind = 'grant') = (status = 'granted'))
);
CREATE INDEX credits_operations_owner ON credits_operations (owner_id);

-- Append-only audit trail: every grant, reserve, capture and release in order,
-- with its timestamp and the resulting account state. The trigger below makes
-- rows impossible to update or delete.
CREATE TABLE credits_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL REFERENCES credits_accounts(owner_id),
  entry_type text NOT NULL CHECK (entry_type IN ('grant','reserve','capture','release','adjust')),
  status text NOT NULL,
  operation_id text,
  amount bigint NOT NULL CHECK (amount >= 0),
  balance_change bigint NOT NULL,
  reserved_change bigint NOT NULL,
  balance_after bigint NOT NULL,
  reserved_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credits_ledger_owner ON credits_ledger (owner_id, id);

CREATE FUNCTION credits_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credits_ledger is append-only';
END;
$$;

CREATE TRIGGER credits_ledger_immutable
  BEFORE UPDATE OR DELETE ON credits_ledger
  FOR EACH ROW EXECUTE FUNCTION credits_ledger_append_only();
