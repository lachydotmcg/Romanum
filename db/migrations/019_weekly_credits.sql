-- Server-managed eligibility. A future verified billing integration must update
-- this field; there is no client endpoint for changing plans.
ALTER TABLE accounts ADD COLUMN credit_plan text NOT NULL DEFAULT 'free'
  CHECK (credit_plan IN ('free','subscribed'));

-- Retained financial metadata, independent of account deletion. A zero grant
-- records an evaluated week too, so spending cannot trigger a second refill.
CREATE TABLE weekly_credit_claims (
  roblox_user_id bigint NOT NULL CHECK (roblox_user_id > 0),
  week_start date NOT NULL,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  amount integer NOT NULL CHECK (amount BETWEEN 0 AND 25),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (roblox_user_id, week_start)
);
CREATE INDEX weekly_credit_claims_owner ON weekly_credit_claims(owner_id, week_start);
