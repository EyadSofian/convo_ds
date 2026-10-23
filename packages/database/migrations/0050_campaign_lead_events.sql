-- Preserve every lead outcome change rather than overwriting the only evidence.
ALTER TABLE campaign_leads ADD CONSTRAINT campaign_leads_tenant_id_uq UNIQUE (tenant_id,id);
CREATE TABLE campaign_lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_lead_id uuid NOT NULL,
  actor_membership_id uuid,
  old_status text NOT NULL,
  new_status text NOT NULL,
  lost_reason text,
  revenue_amount_minor numeric(20,6) NOT NULL,
  currency text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_lead_events_lead_fk FOREIGN KEY (tenant_id,campaign_lead_id)
    REFERENCES campaign_leads(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_lead_events_actor_fk FOREIGN KEY (tenant_id,actor_membership_id)
    REFERENCES memberships(tenant_id,id) ON DELETE SET NULL (actor_membership_id)
);
CREATE INDEX campaign_lead_events_lead_at_idx ON campaign_lead_events(tenant_id,campaign_lead_id,recorded_at DESC);
ALTER TABLE campaign_lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_lead_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_lead_events USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
GRANT SELECT,INSERT ON campaign_lead_events TO convo_app;
