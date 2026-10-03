-- Reviewed rollback artifact only. Never called by a route or startup.
-- Run transactionally after owner review/backup. Refuse unresolved work.
-- These locks also make a non-transactional invocation fail before any DDL.
LOCK TABLE creative_projects IN ACCESS EXCLUSIVE MODE;
LOCK TABLE studio_workflow_selections, studio_workflow_actions, studio_workflow_requests IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM studio_workflow_actions WHERE status IN ('proposed','approved','running','uncertain')) THEN
    RAISE EXCEPTION 'resolve Studio actions before rollback' USING ERRCODE='55000';
  END IF;
END $$;
DROP TRIGGER studio_workflow_delete_guard ON creative_projects;
DROP FUNCTION romanum_guard_studio_project_delete();
DROP TABLE studio_workflow_requests;
DROP TABLE studio_workflow_actions;
DROP TABLE studio_workflow_selections;
-- Existing account closures, guard function, projects and app migrations stay intact.
