-- Isolated fixture milestone. NOT an application migration or runtime setup.
-- A release must integrate migration ordering and account export before enabling.
CREATE TABLE studio_workflow_selections (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  target jsonb NOT NULL CHECK (octet_length(target::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE TABLE studio_workflow_actions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  inspection_id uuid,
  project_revision integer NOT NULL,
  proposal jsonb NOT NULL CHECK (octet_length(proposal::text) <= 98304),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  effect text NOT NULL CHECK (effect IN ('read','write')),
  status text NOT NULL CHECK (status IN ('proposed','approved','rejected','running','succeeded','failed','cancelled','uncertain')),
  dispatch_phase text NOT NULL DEFAULT 'pending' CHECK (dispatch_phase IN ('pending','dispatching')),
  result jsonb CHECK (octet_length(result::text) <= 98304),
  error_code text,
  expires_at timestamptz NOT NULL,
  claim_id uuid,
  lease_until timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id, owner_id),
  FOREIGN KEY (selection_id, project_id, owner_id) REFERENCES studio_workflow_selections(id, project_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (inspection_id, project_id, owner_id) REFERENCES studio_workflow_actions(id, project_id, owner_id),
  CHECK ((status = 'running' AND claim_id IS NOT NULL AND lease_until IS NOT NULL) OR
         (status <> 'running' AND claim_id IS NULL AND lease_until IS NULL)),
  CHECK ((effect = 'write') = (inspection_id IS NOT NULL))
);
CREATE TABLE studio_workflow_requests (
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 100),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, project_id, request_key),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX studio_workflow_actions_owner_project ON studio_workflow_actions(owner_id, project_id, created_at);
