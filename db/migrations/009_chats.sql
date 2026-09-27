-- Saved chats for the Chats section, owned by an opaque owner ID (a guest until sign-in exists).
-- Attachments are reference images a person added to a question; only their owner can read them.

CREATE TABLE chats (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- The conversation in the model's message format, sent back with each new question.
  history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chats_owner_recent ON chats (owner_id, updated_at DESC);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  -- Orders a chat's messages, including a question and answer written in one transaction.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  -- A question's text. An answer is stored as its streamed events instead, replayed to redraw it.
  content text NOT NULL DEFAULT '' CHECK (length(content) <= 4000),
  events jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_chat ON chat_messages (chat_id, seq);

CREATE TABLE chat_attachments (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 2),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position)
);
CREATE INDEX chat_attachments_owner ON chat_attachments (owner_id);
