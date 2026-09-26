-- Private creation foundations. These tables are not part of public MCP/search.
CREATE TABLE creative_projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);

-- Small local prototypes store bounded images transactionally. Replace bytea
-- with private object storage before accepting production uploads at scale.
CREATE TABLE creative_assets (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reference', 'generated')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 45 AND 10485760),
  mime_type text NOT NULL CHECK (mime_type = 'image/png'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  sha256 text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id)
);

CREATE TABLE creative_workflows (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('thumbnail', 'ui')),
  brief jsonb NOT NULL,
  reference_ids jsonb NOT NULL DEFAULT '[]',
  concepts jsonb NOT NULL DEFAULT '[]',
  credit_budget integer NOT NULL CHECK (credit_budget BETWEEN 1 AND 1000),
  allow_agent_review boolean NOT NULL DEFAULT false,
  approval jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id)
);

CREATE TABLE creative_jobs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  concept_key text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('concept', 'final', 'asset')),
  asset_key text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','uncertain')),
  provider_id text NOT NULL,
  provider_model text NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode IN ('test','paid')),
  quoted_credits integer NOT NULL CHECK (quoted_credits BETWEEN 1 AND 1000),
  request jsonb NOT NULL,
  output_asset_id uuid,
  error_code text,
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (workflow_id, project_id, owner_id) REFERENCES creative_workflows(id, project_id, owner_id),
  FOREIGN KEY (output_asset_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id),
  CHECK ((status = 'succeeded') = (output_asset_id IS NOT NULL))
);
CREATE UNIQUE INDEX creative_active_output ON creative_jobs (workflow_id, concept_key, stage, asset_key)
  WHERE status IN ('queued','running','succeeded','uncertain');
CREATE INDEX creative_jobs_owner ON creative_jobs(owner_id, workflow_id, created_at);
CREATE INDEX creative_jobs_pending ON creative_jobs(status, started_at);
