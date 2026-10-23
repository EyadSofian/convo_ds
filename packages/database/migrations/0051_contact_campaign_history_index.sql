-- A contact profile reads its recent campaign participation without scanning
-- every lead in the tenant as campaign volume grows.
CREATE INDEX campaign_leads_contact_history_idx
  ON campaign_leads(tenant_id,contact_id,imported_at DESC,id DESC);
