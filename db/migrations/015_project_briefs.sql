-- Private project drafts gain revisioned, archiveable storage. A project keeps
-- its brief and context for as long as the owner wants it; archiving sets it
-- aside instead of deleting it, so nothing here cascades on delete.

ALTER TABLE creative_projects
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN archived boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX creative_projects_owner_archived_updated ON creative_projects (owner_id, archived, updated_at DESC);

-- A chat may be linked to one of its owner's projects. The owner is part of the
-- reference, so a chat can never link another owner's project. No ON DELETE:
-- projects are archived and restored, never deleted while a chat points at one.
ALTER TABLE chats ADD COLUMN project_id uuid;
ALTER TABLE chats ADD CONSTRAINT chats_project_owner_fk
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects (id, owner_id);
CREATE INDEX chats_owner_project_updated ON chats (owner_id, project_id, updated_at DESC);
