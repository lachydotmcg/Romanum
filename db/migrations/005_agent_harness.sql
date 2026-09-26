-- Private project runs. No anonymous route or public MCP resource reads these.
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  objective text NOT NULL,
  context jsonb NOT NULL,
  allowed_tools jsonb NOT NULL,
  auto_project_writes boolean NOT NULL DEFAULT false,
  max_steps integer NOT NULL CHECK (max_steps BETWEEN 1 AND 20),
  steps integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ready','running','awaiting_approval','completed','failed','cancelled','uncertain')),
  claim_id uuid,
  claimed_at timestamptz,
  final_text text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id),
  UNIQUE (id, project_id, owner_id)
);
CREATE INDEX agent_runs_owner ON agent_runs(owner_id, project_id, created_at);
CREATE TABLE agent_actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  tool_scope text NOT NULL,
  target jsonb,
  effect text NOT NULL CHECK (effect IN ('read','write','execute')),
  input jsonb NOT NULL,
  reason text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','approved','running','succeeded','failed','rejected','uncertain')),
  result jsonb,
  error_code text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);
