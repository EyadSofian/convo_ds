-- Workspace-managed Meta apps coexist with the earlier installation-managed
-- rows. One app signs webhooks for every asset connected under that app;
-- WhatsApp phone numbers remain separate channel_connections.
ALTER TABLE channel_apps
  ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  ADD COLUMN secret_ciphertext bytea,
  ADD COLUMN secret_iv bytea,
  ADD COLUMN secret_auth_tag bytea,
  ADD COLUMN secret_key_version text;

ALTER TABLE channel_apps ALTER COLUMN secret_ref DROP NOT NULL;

ALTER TABLE channel_apps ADD CONSTRAINT channel_apps_secret_source_ck CHECK (
  (tenant_id IS NULL AND secret_ref IS NOT NULL
    AND secret_ciphertext IS NULL AND secret_iv IS NULL
    AND secret_auth_tag IS NULL AND secret_key_version IS NULL)
  OR
  (tenant_id IS NOT NULL AND provider = 'meta' AND secret_ref IS NULL
    AND secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL
    AND octet_length(secret_iv) = 12
    AND secret_auth_tag IS NOT NULL AND octet_length(secret_auth_tag) = 16
    AND secret_key_version IS NOT NULL)
);

-- Existing operator-provisioned apps were installation-wide and readable by
-- the runtime. Preserve that read behavior for webhook ingress; only app
-- creation is new, and RLS limits it to the authenticated tenant context.
ALTER TABLE channel_apps ENABLE ROW LEVEL SECURITY;
-- The migration/operator owner must still be able to provision legacy
-- installation-wide rows. The runtime role is not the table owner and remains
-- bound by the INSERT policy below.
CREATE POLICY channel_apps_runtime_read ON channel_apps FOR SELECT USING (true);
CREATE POLICY channel_apps_tenant_insert ON channel_apps FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() AND provider = 'meta' AND secret_ref IS NULL);
GRANT INSERT ON channel_apps TO convo_app;

CREATE INDEX channel_apps_tenant_idx ON channel_apps (tenant_id, provider, status)
  WHERE tenant_id IS NOT NULL;
