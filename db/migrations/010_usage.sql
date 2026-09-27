-- Metered AI usage: each answer's model calls, what they cost Romanum and what they charged in credits.
-- Credits are whole units, so an owner's charges below one credit carry over to their next answer.

CREATE TABLE usage_charges (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  feature text NOT NULL CHECK (feature IN ('ask','chat')),
  -- One entry per model call: model, time, whether DeepSeek was at peak, token counts and cost.
  calls jsonb NOT NULL CHECK (jsonb_typeof(calls) = 'array'),
  -- The provider cost and the marked-up price, in nano-dollars (billionths of a dollar).
  cost_nano_usd bigint NOT NULL CHECK (cost_nano_usd >= 0),
  price_nano_usd bigint NOT NULL CHECK (price_nano_usd >= 0),
  -- Whole credits taken from the ledger for this answer, once the owner's carried remainder was added.
  credits_charged bigint NOT NULL CHECK (credits_charged >= 0),
  -- Price that couldn't be charged because the balance had run out. It is written off, not owed.
  unpaid_nano_usd bigint NOT NULL DEFAULT 0 CHECK (unpaid_nano_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_charges_owner ON usage_charges (owner_id, created_at);

CREATE TABLE usage_carry (
  owner_id text PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 200),
  -- Price not yet taken as a whole credit: always less than one credit (10,000,000 nano-dollars).
  carry_nano_usd bigint NOT NULL DEFAULT 0 CHECK (carry_nano_usd BETWEEN 0 AND 9999999),
  updated_at timestamptz NOT NULL DEFAULT now()
);
