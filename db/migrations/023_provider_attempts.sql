-- Durable, server-owned attempts. Only bounded accounting snapshots live here:
-- no prompts, provider bodies, tool arguments, reasoning, credentials or output.
-- Final evidence/candidate and the global response claim commit before wallet
-- capture, so a ledger failure cannot discard paid usage. Reservation and final
-- ledger receipt each commit with their corresponding wallet mutation. Applying this schema enables no
-- provider and supplies no reviewed execution policy.
CREATE TABLE provider_attempts (
  attempt_id text PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 128),
  owner_id text NOT NULL REFERENCES credits_accounts(owner_id),
  hold_id uuid NOT NULL UNIQUE REFERENCES usage_holds(id),
  binding_fingerprint text NOT NULL CHECK (binding_fingerprint ~ '^[a-f0-9]{64}$'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  last_outcome_hash text CHECK (last_outcome_hash IS NULL OR last_outcome_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('open','candidate','settled','released')),
  candidate_fingerprint text CHECK (candidate_fingerprint IS NULL OR candidate_fingerprint ~ '^[a-f0-9]{64}$'),
  usage_charge_id uuid UNIQUE REFERENCES usage_charges(id),
  ledger_receipt jsonb CHECK (ledger_receipt IS NULL OR jsonb_typeof(ledger_receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'settled') = (usage_charge_id IS NOT NULL)
    AND (status IN ('candidate','settled')) = (candidate_fingerprint IS NOT NULL)
    AND (usage_charge_id IS NULL) = (ledger_receipt IS NULL))
);
CREATE INDEX provider_attempts_owner ON provider_attempts(owner_id, created_at);
CREATE INDEX provider_attempts_open ON provider_attempts(owner_id) WHERE status IN ('open','candidate');

-- Global across owners/attempts: one attributable provider response may enter
-- fractional carry and the wallet only once. A collision retains the later hold
-- for reconciliation; it never becomes another charge or an automatic release.
CREATE TABLE provider_final_claims (
  provider text NOT NULL CHECK (provider IN ('deepseek','openai','anthropic')),
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 192),
  attempt_id text NOT NULL UNIQUE REFERENCES provider_attempts(attempt_id),
  candidate_fingerprint text NOT NULL CHECK (candidate_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_message_id)
);
