-- Tool fees share the exact fractional carry used by model usage. No prompts or
-- search inputs are retained in billing records.
ALTER TABLE usage_charges ADD COLUMN tools jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(tools) = 'array');

CREATE TABLE tool_usage (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  feature text NOT NULL CHECK (feature IN ('ask','chat')),
  tool_name text NOT NULL,
  price_nano_usd bigint NOT NULL CHECK (price_nano_usd BETWEEN 1 AND 10000000),
  status text NOT NULL CHECK (status IN ('reserved','settled','released')),
  credits_charged integer CHECK (credits_charged BETWEEN 0 AND 1),
  charge_id uuid REFERENCES usage_charges(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'settled') = (charge_id IS NOT NULL)),
  CHECK ((charge_id IS NULL) = (credits_charged IS NULL))
);
CREATE INDEX tool_usage_owner ON tool_usage(owner_id, created_at);
