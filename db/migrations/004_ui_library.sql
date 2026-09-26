-- Private drafts and explicit, revocable publication in Romanum's catalogue.
-- Asset licences already received by others are not revoked by delisting.
CREATE TABLE ui_library_lock (id boolean PRIMARY KEY DEFAULT true CHECK (id));
INSERT INTO ui_library_lock VALUES (true);

CREATE TABLE ui_asset_rights (
  asset_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('granted','revoked')),
  license text NOT NULL CHECK (license = 'CC-BY-4.0'),
  attribution text NOT NULL,
  evidence_private text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id)
);

CREATE TABLE ui_library_entries (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','shared','withdrawn','deleted')),
  revision integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  description text NOT NULL,
  tags text[] NOT NULL,
  layout jsonb,
  assets jsonb NOT NULL,
  source_entry_ids jsonb NOT NULL DEFAULT '[]',
  license text CHECK (license = 'CC-BY-4.0'),
  attribution text,
  credits jsonb NOT NULL DEFAULT '[]',
  consent_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  shared_at timestamptz,
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id),
  CHECK (state <> 'shared' OR (layout IS NOT NULL AND license IS NOT NULL AND consent_version IS NOT NULL AND attribution IS NOT NULL))
);
CREATE INDEX ui_library_search ON ui_library_entries(state, shared_at);
CREATE INDEX ui_library_owner ON ui_library_entries(owner_id, project_id);

-- Flattened input lineage allows withdrawal to remove derived listings too.
CREATE TABLE ui_library_sources (
  entry_id uuid NOT NULL REFERENCES ui_library_entries(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES creative_assets(id),
  PRIMARY KEY(entry_id, asset_id)
);
CREATE TABLE ui_library_dependencies (
  entry_id uuid NOT NULL REFERENCES ui_library_entries(id) ON DELETE CASCADE,
  source_entry_id uuid NOT NULL REFERENCES ui_library_entries(id),
  PRIMARY KEY(entry_id, source_entry_id),
  CHECK (entry_id <> source_entry_id)
);
-- Minimal audit trail: no private prompt, performance report or uploaded bytes.
CREATE TABLE ui_library_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES ui_library_entries(id),
  owner_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('shared','withdrawn','deleted')),
  revision integer NOT NULL,
  notice_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);
