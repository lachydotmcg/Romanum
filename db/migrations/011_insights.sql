-- Romanum insight: one AI-written briefing a day, shared by everyone and generated on the day's first visit.
-- Romanum pays for it; its cost is recorded here rather than charged to anyone.

CREATE TABLE insights (
  day date PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('generating','ready','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Recommended titles and indie radar items, present once ready.
  content jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
  -- What generating it cost, in nano-dollars (billionths of a dollar), with each model call's usage.
  cost_nano_usd bigint NOT NULL DEFAULT 0 CHECK (cost_nano_usd >= 0),
  calls jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(calls) = 'array'),
  CONSTRAINT insights_content_when_ready CHECK ((status = 'ready') = (content IS NOT NULL))
);
