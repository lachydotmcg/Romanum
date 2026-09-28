-- Closing an account removes the owner's private rows in one transaction and
-- leaves a minimal owner marker behind. The marker carries internal identifiers
-- and a timestamp, not profile fields. It is still linkable to retained credit
-- records (including the Roblox user ID in a sign-up grant), not anonymous data.
--
-- The trigger guards below stop a write that was already in flight from
-- resurrecting a closed owner: they take the owner's advisory lock, so they
-- serialize with closeAccount (which takes the same lock), and reject a write
-- that lands after the marker is committed. Deleting rows is never guarded --
-- closure itself is a transaction of deletes -- and the financial tables are
-- only guarded on INSERT so existing holds, usage charges and ledger settlement
-- keep working for an owner whose private data is gone. The minimal credit
-- ledger stays immutable and is the retained accounting record.

CREATE TABLE account_closures (
  owner_id text PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 200),
  account_id uuid NOT NULL UNIQUE,
  closed_at timestamptz NOT NULL DEFAULT now()
);

-- Reject inserts and owner transfers for a closed owner. hashtextextended is
-- stable, so every guard and closeAccount hash the same owner ID to one lock.
CREATE FUNCTION romanum_reject_closed_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_id, 0));
  IF EXISTS (SELECT 1 FROM account_closures WHERE owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'owner is closed' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- No service transfers an existing row to another owner; a change is a stale
    -- write or a bug, so it is refused rather than silently re-keyed.
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'owner_id cannot be changed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_projects
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_assets
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_workflows
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_jobs
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_reviews
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON creative_reconciliations
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ui_asset_rights
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ui_library_entries
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ui_library_events
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON chat_attachments
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();

-- New grants, reservations and holds are refused; settlement of what already
-- exists (updates, and the ledger and usage charges it appends) is not guarded.
CREATE TRIGGER account_closure_guard_grant BEFORE INSERT ON credits_accounts
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard_operation BEFORE INSERT ON credits_operations
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard_hold BEFORE INSERT ON usage_holds
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
