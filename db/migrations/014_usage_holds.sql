-- Bounded per-call credit holds for metered AI usage. Before any provider work
-- starts, a hold quotes the most a single model call may cost the user and
-- reserves that many whole credits plus one (so an owner's fractional carry can
-- never outrun the hold). Settlement charges the reported usage exactly once and
-- releases the unused remainder; a call whose provider outcome is unknown keeps
-- its reservation rather than guessing. Holds persist only IDs, status, the
-- quote, the settlement result and a call fingerprint -- never prompts, provider
-- bodies or secrets.

CREATE TABLE usage_holds (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  feature text NOT NULL CHECK (feature IN ('ask','chat')),
  -- The ledger reservation backing this hold. Server-generated from the hold ID;
  -- callers never supply it, so the feature and operation ID cannot be spoofed.
  operation_id text NOT NULL UNIQUE CHECK (operation_id = 'model-call:' || id::text),
  status text NOT NULL CHECK (status IN ('reserved','uncertain','settled','released')),
  -- The quote ceiling: the most this call may cost the user, in nano-dollars.
  max_price_nano_usd bigint NOT NULL CHECK (max_price_nano_usd >= 1),
  -- Whole credits held in the ledger: ceil(quote / credit) + 1, ample for carry.
  reserved_credits bigint NOT NULL CHECK (reserved_credits >= 1),
  -- Settlement result. Present together, exactly once a hold is settled.
  settled_charge_id uuid,
  settled_cost_nano_usd bigint CHECK (settled_cost_nano_usd IS NULL OR settled_cost_nano_usd >= 0),
  settled_price_nano_usd bigint CHECK (settled_price_nano_usd IS NULL OR (settled_price_nano_usd >= 0 AND settled_price_nano_usd <= max_price_nano_usd)),
  settled_credits_charged bigint CHECK (settled_credits_charged IS NULL OR (settled_credits_charged >= 0 AND settled_credits_charged <= reserved_credits)),
  -- SHA-256 of the settled call's identity: an identical replay returns the saved
  -- result, and a different call is rejected as a conflict.
  call_fingerprint text CHECK (call_fingerprint IS NULL OR call_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A settled hold always carries its whole result; every other status carries none.
  CONSTRAINT usage_holds_settled_is_complete CHECK (
    (status = 'settled') = (settled_charge_id IS NOT NULL)
    AND (settled_charge_id IS NULL) = (settled_cost_nano_usd IS NULL)
    AND (settled_charge_id IS NULL) = (settled_price_nano_usd IS NULL)
    AND (settled_charge_id IS NULL) = (settled_credits_charged IS NULL)
    AND (settled_charge_id IS NULL) = (call_fingerprint IS NULL)
  )
);
CREATE INDEX usage_holds_owner ON usage_holds (owner_id, created_at);
-- Open (unsettled) holds per owner, the rows an operator reconciles by hand.
CREATE INDEX usage_holds_open ON usage_holds (owner_id) WHERE status IN ('reserved','uncertain');
