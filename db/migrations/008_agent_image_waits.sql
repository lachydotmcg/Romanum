ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('ready','running','waiting','awaiting_approval','completed','failed','cancelled','uncertain'));
ALTER TABLE agent_runs ADD COLUMN waiting_job_id uuid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_wait_scope
  FOREIGN KEY (waiting_job_id, project_id, owner_id) REFERENCES creative_jobs(id, project_id, owner_id);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_wait_state
  CHECK ((status = 'waiting') = (waiting_job_id IS NOT NULL));
CREATE INDEX agent_runs_waiting_job ON agent_runs(waiting_job_id) WHERE status='waiting';
