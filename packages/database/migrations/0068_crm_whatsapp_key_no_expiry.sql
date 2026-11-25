-- New keys have no expiry. Keep the same token and sender scope for keys that
-- are still valid. Previously expired or manually revoked keys stay invalid.
ALTER TABLE crm_whatsapp_keys
  ALTER COLUMN expires_at DROP NOT NULL,
  ALTER COLUMN expires_at DROP DEFAULT;

-- The migrator owns the table. Its transaction holds the DDL lock until
-- FORCE RLS is restored; the application's tenant policy stays in effect.
ALTER TABLE crm_whatsapp_keys NO FORCE ROW LEVEL SECURITY;
UPDATE crm_whatsapp_keys
SET expires_at = NULL
WHERE revoked_at IS NULL AND expires_at > now();
ALTER TABLE crm_whatsapp_keys FORCE ROW LEVEL SECURITY;
