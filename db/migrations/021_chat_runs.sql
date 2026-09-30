-- Durable owner-only reviews, polled in short HTTP requests while a background worker runs.
CREATE TABLE chat_runs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  question_id uuid NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed','cancelled')),
  -- The captured text/context and attachment IDs; no copied image bytes, API keys or credentials.
  payload jsonb,
  events jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events) = 'array'),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 10000),
  event_bytes integer NOT NULL DEFAULT 0 CHECK (event_bytes BETWEEN 0 AND 2097152),
  cancel_requested boolean NOT NULL DEFAULT false,
  claim_token uuid,
  lease_until timestamptz,
  error text CHECK (error IS NULL OR length(error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX chat_runs_owner ON chat_runs(owner_id, created_at);
CREATE UNIQUE INDEX chat_runs_active_chat ON chat_runs(chat_id) WHERE status IN ('queued','running');
