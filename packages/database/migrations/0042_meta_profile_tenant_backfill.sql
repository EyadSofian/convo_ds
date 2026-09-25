-- 0041's initial SELECT ran as the migration owner without a tenant context.
-- Contacts and identities have FORCE RLS, so it could not see existing rows.
-- Requeue only unresolved Meta identities, one tenant context at a time.
-- The queue stores no profile content or credentials; the inbound worker still
-- fetches names asynchronously and never blocks customer message ingestion.
-- The migration role cannot enumerate tenants while FORCE RLS is enabled.
-- Migrations run in one transaction (see migrate.ts); as in 0007, briefly lift
-- FORCE on tenants only, then restore it before commit. No runtime transaction
-- can observe the intermediate table state because ALTER TABLE holds a lock.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE tenant_row record;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', tenant_row.id::text, true);
    INSERT INTO contact_profile_queue (tenant_id, contact_id, connection_id)
    SELECT i.tenant_id, i.contact_id, i.scope_id
      FROM contact_identities i
      JOIN contacts c ON c.tenant_id=i.tenant_id AND c.id=i.contact_id
      JOIN channel_connections n ON n.tenant_id=i.tenant_id AND n.id=i.scope_id
     WHERE i.tenant_id=tenant_row.id
       AND i.kind IN ('messenger', 'instagram') AND i.valid_to IS NULL
       AND n.kind=i.kind AND c.display_name=i.external_id AND c.deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
