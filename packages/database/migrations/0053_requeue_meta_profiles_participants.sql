-- Refresh unresolved Meta sender names after the conversation-participants
-- fallback. Graph withholds the Page-scoped profile (an empty answer, not an
-- error) from apps without Business Asset User Profile Access, so these senders
-- exhausted their attempts while still shown as "Messenger customer".
-- Keep operator-edited names intact; only identities still displayed as raw
-- provider IDs are candidates. The queue stores IDs, never names or tokens.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE tenant_row record;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', tenant_row.id::text, true);
    INSERT INTO contact_profile_queue (tenant_id, contact_id, connection_id)
    SELECT identity.tenant_id, identity.contact_id, identity.scope_id
      FROM contact_identities identity
      JOIN contacts contact ON contact.tenant_id=identity.tenant_id AND contact.id=identity.contact_id AND contact.deleted_at IS NULL
      JOIN channel_connections connection ON connection.tenant_id=identity.tenant_id AND connection.id=identity.scope_id
     WHERE identity.tenant_id=tenant_row.id AND identity.valid_to IS NULL
       AND identity.kind IN ('messenger', 'instagram')
       AND connection.kind=identity.kind AND connection.disconnected_at IS NULL
       AND contact.display_name=identity.external_id
    ON CONFLICT (tenant_id, contact_id, connection_id) DO UPDATE SET
      attempts=0, next_attempt_at=now(), lease_until=NULL, last_error_code=NULL;
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
