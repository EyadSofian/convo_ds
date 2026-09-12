-- 0020_campaign_core
-- Immutable campaign definitions, revision-bound approvals, frozen audiences,
-- single executions, recipient evidence and exact budget quantities.

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}([-_][A-Za-z]{2,8})?$'),
  category text NOT NULL CHECK (category IN ('marketing','utility','authentication','service')),
  provider_status text NOT NULL DEFAULT 'local' CHECK (provider_status IN ('local','pending','approved','rejected','paused','disabled')),
  local_revision integer NOT NULL DEFAULT 1 CHECK (local_revision > 0),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT templates_connection_fk FOREIGN KEY (tenant_id,connection_id)
    REFERENCES channel_connections(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT templates_identity_uq UNIQUE (tenant_id,connection_id,name,language)
);

CREATE TABLE template_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_revisions_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT template_revisions_template_fk FOREIGN KEY (tenant_id,template_id)
    REFERENCES templates(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT template_revisions_number_uq UNIQUE (tenant_id,template_id,revision),
  CONSTRAINT template_revisions_hash_uq UNIQUE (tenant_id,id,content_hash)
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  objective text CHECK (objective IS NULL OR length(objective) <= 500),
  connection_id uuid NOT NULL,
  control_state text NOT NULL DEFAULT 'draft' CHECK (control_state IN (
    'draft','validating','ready','scheduled','running','pausing','paused',
    'dispatch_completed','cancelling','cancelled','failed'
  )),
  current_revision_id uuid,
  created_by_membership_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaigns_connection_fk FOREIGN KEY (tenant_id,connection_id)
    REFERENCES channel_connections(tenant_id,id),
  CONSTRAINT campaigns_creator_fk FOREIGN KEY (tenant_id,created_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (created_by_membership_id)
);

CREATE TABLE campaign_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  template_revision_id uuid,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_filter) = 'object'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schedule) = 'object'),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 80),
  expires_at timestamptz,
  budget_amount_minor numeric(20,6) NOT NULL DEFAULT 0 CHECK (budget_amount_minor >= 0),
  budget_currency text NOT NULL DEFAULT 'USD' CHECK (budget_currency ~ '^[A-Z]{3}$'),
  revision_hash text NOT NULL CHECK (revision_hash ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_revisions_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaign_revisions_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_revisions_template_fk FOREIGN KEY (tenant_id,template_revision_id)
    REFERENCES template_revisions(tenant_id,id),
  CONSTRAINT campaign_revisions_creator_fk FOREIGN KEY (tenant_id,created_by_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (created_by_membership_id),
  CONSTRAINT campaign_revisions_number_uq UNIQUE (tenant_id,campaign_id,revision),
  CONSTRAINT campaign_revisions_hash_uq UNIQUE (tenant_id,id,revision_hash)
);

ALTER TABLE campaigns ADD CONSTRAINT campaigns_current_revision_fk
  FOREIGN KEY (tenant_id,current_revision_id)
  REFERENCES campaign_revisions(tenant_id,id);

CREATE TABLE campaign_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  revision_hash text NOT NULL,
  approver_membership_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  CONSTRAINT campaign_approvals_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_approvals_revision_fk FOREIGN KEY (tenant_id,revision_id,revision_hash)
    REFERENCES campaign_revisions(tenant_id,id,revision_hash),
  CONSTRAINT campaign_approvals_approver_fk FOREIGN KEY (tenant_id,approver_membership_id)
    REFERENCES memberships(tenant_id,id),
  CONSTRAINT campaign_approvals_interval_ck CHECK (revoked_at IS NULL OR revoked_at >= approved_at)
);
CREATE UNIQUE INDEX campaign_approvals_live_uq
  ON campaign_approvals(tenant_id,campaign_id,revision_id) WHERE revoked_at IS NULL;

CREATE TABLE audience_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT audience_snapshots_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT audience_snapshots_revision_fk FOREIGN KEY (tenant_id,revision_id)
    REFERENCES campaign_revisions(tenant_id,id),
  CONSTRAINT audience_snapshots_revision_uq UNIQUE (tenant_id,revision_id),
  CONSTRAINT audience_snapshots_tenant_id_uq UNIQUE (tenant_id,id)
);

-- The member rows are the snapshot. Re-evaluating the filter at launch would
-- silently add or remove people after the operator reviewed the preview.
CREATE TABLE audience_snapshot_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  eligibility text NOT NULL CHECK (eligibility IN ('eligible','suppressed','no_consent','identity_inactive','contact_deleted')),
  reason jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reason) = 'object'),
  rendered_variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rendered_variables) = 'object'),
  CONSTRAINT audience_snapshot_members_snapshot_fk FOREIGN KEY (tenant_id,snapshot_id)
    REFERENCES audience_snapshots(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT audience_snapshot_members_contact_fk FOREIGN KEY (tenant_id,contact_id)
    REFERENCES contacts(tenant_id,id),
  CONSTRAINT audience_snapshot_members_identity_fk FOREIGN KEY (tenant_id,identity_id)
    REFERENCES contact_identities(tenant_id,id),
  CONSTRAINT audience_snapshot_members_identity_uq UNIQUE (tenant_id,snapshot_id,identity_id)
);

CREATE TABLE campaign_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  audience_snapshot_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled','running','pausing','paused','dispatch_completed','cancelling','cancelled','failed')),
  launched_at timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  stop_version bigint NOT NULL DEFAULT 0 CHECK (stop_version >= 0),
  CONSTRAINT campaign_executions_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id),
  CONSTRAINT campaign_executions_revision_fk FOREIGN KEY (tenant_id,revision_id)
    REFERENCES campaign_revisions(tenant_id,id),
  CONSTRAINT campaign_executions_snapshot_fk FOREIGN KEY (tenant_id,audience_snapshot_id)
    REFERENCES audience_snapshots(tenant_id,id),
  CONSTRAINT campaign_executions_once_uq UNIQUE (tenant_id,campaign_id),
  CONSTRAINT campaign_executions_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaign_executions_schedule_ck CHECK (state <> 'scheduled' OR scheduled_for IS NOT NULL)
);

CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  rendered_variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rendered_variables) = 'object'),
  snapshot_eligibility jsonb NOT NULL CHECK (jsonb_typeof(snapshot_eligibility) = 'object'),
  dispatch_eligibility jsonb,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN (
    'planned','queued','in_flight','accepted','delivered','read','failed','skipped','cancelled','outcome_unknown'
  )),
  command_id uuid,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_recipients_execution_fk FOREIGN KEY (tenant_id,execution_id)
    REFERENCES campaign_executions(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_recipients_contact_fk FOREIGN KEY (tenant_id,contact_id)
    REFERENCES contacts(tenant_id,id),
  CONSTRAINT campaign_recipients_identity_fk FOREIGN KEY (tenant_id,identity_id)
    REFERENCES contact_identities(tenant_id,id),
  CONSTRAINT campaign_recipients_command_fk FOREIGN KEY (tenant_id,command_id)
    REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT campaign_recipients_identity_uq UNIQUE (tenant_id,execution_id,identity_id),
  CONSTRAINT campaign_recipients_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaign_recipients_dispatch_shape_ck CHECK (dispatch_eligibility IS NULL OR jsonb_typeof(dispatch_eligibility) = 'object'),
  CONSTRAINT campaign_recipients_error_shape_ck CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object')
);
CREATE INDEX campaign_recipients_state_idx ON campaign_recipients(tenant_id,execution_id,state,id);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  estimated_amount_minor numeric(20,6) NOT NULL CHECK (estimated_amount_minor >= 0),
  reserved_amount_minor numeric(20,6) NOT NULL CHECK (reserved_amount_minor >= 0),
  committed_amount_minor numeric(20,6) CHECK (committed_amount_minor IS NULL OR committed_amount_minor >= 0),
  reconciled_amount_minor numeric(20,6) CHECK (reconciled_amount_minor IS NULL OR reconciled_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','committed','released','held_unknown','reconciled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  reconciled_at timestamptz,
  CONSTRAINT budget_reservations_execution_fk FOREIGN KEY (tenant_id,execution_id)
    REFERENCES campaign_executions(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT budget_reservations_recipient_fk FOREIGN KEY (tenant_id,recipient_id)
    REFERENCES campaign_recipients(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT budget_reservations_recipient_uq UNIQUE (tenant_id,execution_id,recipient_id)
);

CREATE TABLE campaign_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  revision_id uuid,
  actor_membership_id uuid,
  act text NOT NULL CHECK (act IN ('created','revised','validated','approved','approval_revoked','launched','state_changed','cloned')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_audit_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_audit_revision_fk FOREIGN KEY (tenant_id,revision_id)
    REFERENCES campaign_revisions(tenant_id,id),
  CONSTRAINT campaign_audit_actor_fk FOREIGN KEY (tenant_id,actor_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (actor_membership_id)
);

CREATE FUNCTION prevent_campaign_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER template_revisions_immutable BEFORE UPDATE OR DELETE ON template_revisions FOR EACH ROW EXECUTE FUNCTION prevent_campaign_evidence_mutation();
CREATE TRIGGER campaign_revisions_immutable BEFORE UPDATE OR DELETE ON campaign_revisions FOR EACH ROW EXECUTE FUNCTION prevent_campaign_evidence_mutation();
CREATE TRIGGER audience_snapshots_immutable BEFORE UPDATE OR DELETE ON audience_snapshots FOR EACH ROW EXECUTE FUNCTION prevent_campaign_evidence_mutation();
CREATE TRIGGER audience_snapshot_members_immutable BEFORE UPDATE OR DELETE ON audience_snapshot_members FOR EACH ROW EXECUTE FUNCTION prevent_campaign_evidence_mutation();
CREATE TRIGGER campaign_audit_immutable BEFORE UPDATE OR DELETE ON campaign_audit FOR EACH ROW EXECUTE FUNCTION prevent_campaign_evidence_mutation();

CREATE FUNCTION enforce_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id,NEW.campaign_id,NEW.revision_id,NEW.audience_snapshot_id)
      IS DISTINCT FROM (OLD.tenant_id,OLD.campaign_id,OLD.revision_id,OLD.audience_snapshot_id) THEN
    RAISE EXCEPTION 'execution definition is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM campaign_revisions r JOIN audience_snapshots s
      ON s.tenant_id=r.tenant_id AND s.revision_id=r.id
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.revision_id
      AND r.campaign_id=NEW.campaign_id AND s.id=NEW.audience_snapshot_id
  ) THEN
    RAISE EXCEPTION 'execution revision and audience must belong to campaign';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_execution_identity BEFORE INSERT OR UPDATE ON campaign_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_execution_identity();

ALTER TABLE templates ENABLE ROW LEVEL SECURITY; ALTER TABLE templates FORCE ROW LEVEL SECURITY;
ALTER TABLE template_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE template_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY; ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_approvals ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE audience_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE audience_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE audience_snapshot_members ENABLE ROW LEVEL SECURITY; ALTER TABLE audience_snapshot_members FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_executions ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON templates USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON template_revisions USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaigns USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_revisions USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_approvals USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON audience_snapshots USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON audience_snapshot_members USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_executions USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_recipients USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON budget_reservations USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_audit USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT,UPDATE ON templates,campaigns,campaign_approvals,campaign_executions,campaign_recipients,budget_reservations TO convo_app;
GRANT SELECT,INSERT ON template_revisions,campaign_revisions,audience_snapshots,audience_snapshot_members,campaign_audit TO convo_app;
