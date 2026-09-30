-- Private, owner-supplied ad exports. Permission to analyse these is separate
-- from project context and linked-game permissions; platform sharing is absent.
CREATE TABLE ad_report_settings (
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  ai_analysis boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 0 CHECK (consent_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE TABLE ad_report_consents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  ai_analysis boolean NOT NULL,
  consent_version integer NOT NULL CHECK (consent_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, owner_id, consent_version),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE TABLE ad_reports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[a-f0-9]{64}$'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 26214400),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, owner_id),
  UNIQUE (project_id, owner_id, content_fingerprint),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX ad_reports_owner ON ad_reports(owner_id, project_id, created_at DESC);
CREATE TABLE ad_report_creative_links (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  report_id uuid NOT NULL,
  ad_id text NOT NULL CHECK (length(ad_id) BETWEEN 1 AND 200),
  creative_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, ad_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (report_id, project_id, owner_id) REFERENCES ad_reports(id, project_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (creative_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id) ON DELETE CASCADE
);
CREATE TABLE ad_report_observations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('observation','hypothesis','tested')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_id, project_id, owner_id) REFERENCES ad_report_observations(id, project_id, owner_id) ON DELETE CASCADE
);
CREATE TABLE ad_report_observation_reports (
  observation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  report_id uuid NOT NULL,
  PRIMARY KEY (observation_id, report_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id, project_id, owner_id) REFERENCES ad_report_observations(id, project_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (report_id, project_id, owner_id) REFERENCES ad_reports(id, project_id, owner_id) ON DELETE CASCADE
);
CREATE TABLE ad_report_observation_creatives (
  observation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  creative_id uuid NOT NULL,
  PRIMARY KEY (observation_id, creative_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id, project_id, owner_id) REFERENCES ad_report_observations(id, project_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (creative_id, project_id, owner_id) REFERENCES creative_assets(id, project_id, owner_id) ON DELETE CASCADE
);
-- Erasing source evidence erases the observations and supersessions citing it.
CREATE FUNCTION romanum_delete_ad_report_observations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ad_report_observations WHERE id IN (
    SELECT observation_id FROM ad_report_observation_reports WHERE report_id=OLD.id
  );
  RETURN OLD;
END;
$$;
CREATE TRIGGER ad_report_evidence_delete BEFORE DELETE ON ad_reports
  FOR EACH ROW EXECUTE FUNCTION romanum_delete_ad_report_observations();
CREATE FUNCTION romanum_immutable_ad_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ad evidence records are immutable; append a supersession' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER ad_report_immutable BEFORE UPDATE ON ad_reports FOR EACH ROW EXECUTE FUNCTION romanum_immutable_ad_record();
CREATE TRIGGER ad_observation_immutable BEFORE UPDATE ON ad_report_observations FOR EACH ROW EXECUTE FUNCTION romanum_immutable_ad_record();
CREATE TRIGGER ad_consent_immutable BEFORE UPDATE ON ad_report_consents FOR EACH ROW EXECUTE FUNCTION romanum_immutable_ad_record();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_settings FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_consents FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_reports FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_creative_links FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_observations FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_observation_reports FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON ad_report_observation_creatives FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
