-- Operator-only decisions about uncertain image jobs. No raw provider body,
-- credential, prompt or image is copied into the settlement audit.
CREATE TABLE creative_reconciliations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  operator_id text NOT NULL,
  evidence_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('not_charged','charged_without_output','recovered')),
  actual_credits integer NOT NULL CHECK (actual_credits BETWEEN 0 AND 1000),
  output_asset_id uuid,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'recovered') = (output_asset_id IS NOT NULL)),
  CHECK (outcome <> 'not_charged' OR actual_credits = 0),
  CHECK (outcome <> 'charged_without_output' OR actual_credits > 0),
  FOREIGN KEY (job_id, project_id, owner_id) REFERENCES creative_jobs(id, project_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (output_asset_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id)
);
CREATE INDEX creative_reconciliations_owner ON creative_reconciliations(owner_id, project_id, created_at);

-- Decisions cannot be rewritten. A future explicit project purge may remove
-- these private evidence references with the job; the separate minimal credit
-- ledger remains subject to its own retention policy.
CREATE FUNCTION creative_reconciliation_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'creative_reconciliations cannot be updated';
END;
$$;
CREATE TRIGGER creative_reconciliations_immutable
  BEFORE UPDATE ON creative_reconciliations
  FOR EACH ROW EXECUTE FUNCTION creative_reconciliation_no_update();
