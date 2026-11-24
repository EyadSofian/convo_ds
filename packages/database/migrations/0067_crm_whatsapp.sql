CREATE TABLE crm_whatsapp_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  connection_ids uuid[] NOT NULL CHECK (cardinality(connection_ids) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at timestamptz,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES memberships(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE crm_whatsapp_sends (
  tenant_id uuid NOT NULL,
  key_id uuid NOT NULL,
  client_message_id text NOT NULL,
  request_hash text NOT NULL,
  message_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  opt_in_reference text NOT NULL,
  PRIMARY KEY (tenant_id,key_id,client_message_id),
  UNIQUE (tenant_id,message_id),
  FOREIGN KEY (tenant_id,key_id) REFERENCES crm_whatsapp_keys(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,message_id) REFERENCES outbound_messages(tenant_id,id) ON DELETE CASCADE
);

ALTER TABLE crm_whatsapp_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_whatsapp_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_whatsapp_keys
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

ALTER TABLE crm_whatsapp_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_whatsapp_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_whatsapp_sends
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT,UPDATE ON crm_whatsapp_keys TO convo_app;
GRANT SELECT,INSERT ON crm_whatsapp_sends TO convo_app;

ALTER TABLE admin_audit_events DROP CONSTRAINT admin_audit_events_subject_type_check;
ALTER TABLE admin_audit_events ADD CONSTRAINT admin_audit_events_subject_type_check
  CHECK (subject_type IN ('membership','role','team','invitation','ownership','whatsapp_template','crm_whatsapp_key'));
