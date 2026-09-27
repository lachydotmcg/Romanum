-- Romanum accounts, signed in with Roblox (OAuth 2.0 and OpenID Connect). The Roblox user ID identifies an
-- account; its names and headshot are refreshed at each sign-in. Romanum keeps no Roblox tokens.

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  roblox_user_id bigint NOT NULL UNIQUE CHECK (roblox_user_id > 0),
  -- Keys the account's credits and chats: the guest it adopted at its first sign-in, or its own owner ID.
  owner_id text NOT NULL UNIQUE CHECK (length(owner_id) BETWEEN 1 AND 200),
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 100),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  picture_url text CHECK (picture_url IS NULL OR length(picture_url) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  signed_in_at timestamptz NOT NULL DEFAULT now()
);

-- A signed-in browser. The session token is only in an HttpOnly cookie; this stores its SHA-256 hash.
CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX account_sessions_account ON account_sessions (account_id);
