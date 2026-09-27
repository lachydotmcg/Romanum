-- Games an account linked with its own Open Cloud API key, and the private analytics synced with it.
-- Private records stay with their account: they never reach public tools, shared caches, MCP or the assistant.

CREATE TABLE linked_games (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  universe_id bigint NOT NULL CHECK (universe_id > 0),
  -- Collect analytics: sync the game's metrics from Roblox. Off stops syncing and keeps what's stored.
  collect boolean NOT NULL DEFAULT true,
  -- Help improve Romanum: optional use of the game's metrics to improve Romanum's analysis. Off by default.
  share boolean NOT NULL DEFAULT false,
  -- When sharing was last turned on. Only days from then on can be used, never earlier history.
  shared_since timestamptz,
  -- Bumped by every change to collect, share, the key or the status. A sync writes only if it's unchanged.
  consent_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','key_rejected','disconnected')),
  -- Set while a sync runs, so visits and the collector don't start a second one.
  sync_started_at timestamptz,
  synced_at timestamptz,
  sync_error text CHECK (sync_error IS NULL OR length(sync_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, universe_id),
  CHECK (share = (shared_since IS NOT NULL))
);

-- The game's API key, encrypted with AES-256-GCM and kept apart from its analytics. Deleted on disconnect.
CREATE TABLE linked_game_keys (
  game_id uuid PRIMARY KEY REFERENCES linked_games(id) ON DELETE CASCADE,
  key_version smallint NOT NULL CHECK (key_version > 0),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 8192),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  -- The key's last four characters, so its owner can tell keys apart. Never the key itself.
  hint text NOT NULL CHECK (length(hint) = 4),
  -- The key's expiry, when Roblox's key introspection reported one.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Daily game-level metrics from Roblox's Analytics Query API: no breakdowns and no player identifiers.
CREATE TABLE linked_game_metrics (
  game_id uuid NOT NULL REFERENCES linked_games(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 80),
  day date NOT NULL,
  value double precision NOT NULL,
  -- Roblox's data point status: Projected values may still change; NotStatisticallySignificant ones are noisy.
  status text CHECK (status IS NULL OR length(status) <= 40),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, metric, day)
);

-- Every collection and sharing choice: whose, which game, what, when and under which notice. Kept when a game's
-- data is deleted, as the record of its consent.
CREATE TABLE linked_game_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  universe_id bigint NOT NULL CHECK (universe_id > 0),
  setting text NOT NULL CHECK (setting IN ('collect','share')),
  enabled boolean NOT NULL,
  notice text NOT NULL CHECK (length(notice) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX linked_game_consents_account ON linked_game_consents (account_id, created_at);
