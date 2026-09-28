-- Owner-private written asset plans. A plan is the written record a model
-- proposed for a project (a title, a brief and its concepts) saved against the
-- exact project revision it was written for. Plans reuse creative_workflows so
-- a plan and the work generated from it share one lineage, but a plan row
-- reserves no credits, queues no job and needs no approval. Rows without plan
-- metadata are the earlier internal workflows and stay invisible to the plan
-- readers. Nothing here fabricates a project context for those old rows.

-- A written plan spends nothing, so zero is now a legal budget. This replaces
-- the check 003 created under its generated name; existing workflows still pass
-- the unchanged 1..1000 validation in createCreativeWorkflow.
ALTER TABLE creative_workflows DROP CONSTRAINT creative_workflows_credit_budget_check;
ALTER TABLE creative_workflows ADD CONSTRAINT creative_workflows_credit_budget_check
  CHECK (credit_budget BETWEEN 0 AND 1000);

ALTER TABLE creative_workflows
  ADD COLUMN plan_title text CHECK (length(plan_title) BETWEEN 1 AND 100),
  -- The project revision the plan was written for, and the project context as
  -- it read then. Null for internal workflows, which store no such snapshot.
  ADD COLUMN project_revision integer CHECK (project_revision > 0),
  ADD COLUMN project_context jsonb,
  -- The live link to the chat a plan came from. Deleting that chat keeps the
  -- plan and clears this column instead of cascading. Owner and project are
  -- checked by the service, which is why this is a single-column reference.
  ADD COLUMN source_chat_id uuid REFERENCES chats(id) ON DELETE SET NULL,
  -- The chat identity a call came from, kept as immutable text so a replay is
  -- still recognisable after the chat itself has been deleted.
  ADD COLUMN source_chat_key text NOT NULL DEFAULT '',
  ADD COLUMN source_call_id text CHECK (length(source_call_id) BETWEEN 1 AND 200),
  -- SHA-256 of the canonical call payload (project, revision, title, kind,
  -- brief and concepts) so an identical retry returns the saved plan and a
  -- different one is rejected.
  ADD COLUMN source_input_hash text;

-- One saved call per owner, chat and call ID: the identity of a call. The same
-- identity with a different payload is refused.
CREATE UNIQUE INDEX creative_workflows_source_call
  ON creative_workflows (owner_id, source_chat_key, source_call_id)
  WHERE source_call_id IS NOT NULL;

CREATE INDEX creative_workflows_owner_project
  ON creative_workflows (owner_id, project_id, created_at DESC);
