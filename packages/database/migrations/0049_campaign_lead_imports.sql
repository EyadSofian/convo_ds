-- Canonical, tenant-scoped phone matching and durable per-campaign lead history.
-- An import is not consent. Neither table inserts a consent row.
CREATE TABLE contact_phone_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mobile text NOT NULL CHECK (mobile ~ '^[1-9][0-9]{7,14}$'),
  contact_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,mobile),
  CONSTRAINT contact_phone_keys_contact_fk FOREIGN KEY (tenant_id,contact_id)
    REFERENCES contacts(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX contact_phone_keys_contact_idx ON contact_phone_keys(tenant_id,contact_id);

CREATE TABLE campaign_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  mobile text NOT NULL CHECK (mobile ~ '^[1-9][0-9]{7,14}$'),
  course_name text NOT NULL CHECK (length(trim(course_name)) BETWEEN 1 AND 160),
  label_id uuid NOT NULL,
  assigned_membership_id uuid,
  source text NOT NULL DEFAULT 'excel_import',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','won','lost','unqualified')),
  lost_reason text,
  revenue_amount_minor numeric(20,6) NOT NULL DEFAULT 0 CHECK (revenue_amount_minor >= 0),
  currency text NOT NULL DEFAULT 'EGP' CHECK (currency ~ '^[A-Z]{3}$'),
  existing_contact boolean NOT NULL DEFAULT false,
  repeat_lead boolean NOT NULL DEFAULT false,
  imported_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  follow_up_attempts integer NOT NULL DEFAULT 0 CHECK (follow_up_attempts >= 0),
  CONSTRAINT campaign_leads_campaign_fk FOREIGN KEY (tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_leads_contact_fk FOREIGN KEY (tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
  CONSTRAINT campaign_leads_label_fk FOREIGN KEY (tenant_id,label_id) REFERENCES labels(tenant_id,id),
  CONSTRAINT campaign_leads_assignee_fk FOREIGN KEY (tenant_id,assigned_membership_id) REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (assigned_membership_id),
  CONSTRAINT campaign_leads_contact_uq UNIQUE (tenant_id,campaign_id,contact_id),
  CONSTRAINT campaign_leads_mobile_uq UNIQUE (tenant_id,campaign_id,mobile)
);
CREATE INDEX campaign_leads_course_idx ON campaign_leads(tenant_id,course_name,campaign_id);
CREATE INDEX campaign_leads_assignee_idx ON campaign_leads(tenant_id,assigned_membership_id,campaign_id);

-- A label is earned when Meta accepts this campaign's send, not merely when a
-- lead is uploaded, queued, skipped or rejected. The live-label index makes
-- retries and delivered/read status transitions idempotent.
CREATE FUNCTION label_accepted_campaign_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('accepted','delivered','read') AND OLD.state NOT IN ('accepted','delivered','read') THEN
    INSERT INTO contact_labels (tenant_id,contact_id,label_id)
    SELECT lead.tenant_id,lead.contact_id,lead.label_id
      FROM campaign_leads lead JOIN campaign_executions run ON run.campaign_id=lead.campaign_id
     WHERE run.id=NEW.execution_id AND lead.contact_id=NEW.contact_id
    ON CONFLICT (tenant_id,contact_id,label_id) WHERE removed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_lead_label_after_accept
  AFTER UPDATE OF state ON campaign_recipients FOR EACH ROW
  EXECUTE FUNCTION label_accepted_campaign_lead();

ALTER TABLE contact_phone_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_phone_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_phone_keys USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
ALTER TABLE campaign_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_leads USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
GRANT SELECT,INSERT,UPDATE ON contact_phone_keys,campaign_leads TO convo_app;
