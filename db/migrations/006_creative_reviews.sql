-- Bounded delegated visual review of generated concept art.
--
-- Private trusted-server records only. No public route, MCP resource or model
-- tool reads this table, and no model tool can grant itself review authority.
-- A review claim is durable, so a duplicate or crashed attempt is never silently
-- re-run, and the recorded outcome (including rejects) is evidence of one call.

-- Scope key used by the composite foreign key below. Additive: every existing
-- row already satisfies it because id is the primary key.
ALTER TABLE creative_jobs ADD CONSTRAINT creative_jobs_scope UNIQUE (id, project_id, owner_id);

CREATE TABLE creative_reviews (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  reviewer_id text NOT NULL,
  reviewer_model text NOT NULL,
  reviewer_mode text NOT NULL CHECK (reviewer_mode IN ('test', 'paid')),
  -- Hash of the exact bytes sent to the reviewer, so the evidence ties to the
  -- observed image rather than a prompt or a later asset.
  asset_sha256 text NOT NULL CHECK (asset_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('claimed', 'approved', 'rejected', 'failed')),
  claim_id uuid NOT NULL,
  approved boolean,
  -- Safe, bounded human text. Never a raw provider or model response body.
  reason text CHECK (length(reason) BETWEEN 1 AND 500),
  error_code text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, owner_id),
  CHECK ((status = 'claimed' AND approved IS NULL AND finished_at IS NULL)
    OR (status = 'approved' AND approved IS TRUE AND finished_at IS NOT NULL)
    OR (status IN ('rejected','failed') AND approved IS FALSE AND finished_at IS NOT NULL)),
  FOREIGN KEY (workflow_id, project_id, owner_id) REFERENCES creative_workflows(id, project_id, owner_id),
  FOREIGN KEY (job_id, project_id, owner_id) REFERENCES creative_jobs(id, project_id, owner_id),
  FOREIGN KEY (asset_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id)
);

CREATE INDEX creative_reviews_workflow ON creative_reviews(workflow_id, created_at);
CREATE INDEX creative_reviews_scope ON creative_reviews(owner_id, project_id, created_at);
