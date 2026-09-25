-- Meta webhook sender IDs are opaque. Resolve display names asynchronously
-- after the inbound message commits; a provider outage must not lose messages.
-- This queue holds identifiers only, not credentials or message content.
CREATE TABLE contact_profile_queue (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text,
  PRIMARY KEY (tenant_id, contact_id, connection_id),
  CONSTRAINT contact_profile_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES contacts(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_profile_connection_fk FOREIGN KEY (tenant_id, connection_id)
    REFERENCES channel_connections(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_profile_queue_due_idx
  ON contact_profile_queue (next_attempt_at) WHERE attempts < 5;
-- Like channel_event_queue, the worker discovers tenants before it can set
-- tenant RLS context. No profile, token, name or message body is stored here.
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_profile_queue TO convo_app;

-- Existing contacts whose visible name is still their opaque provider ID are
-- queued too. This is evidence-based; a human-edited display name is untouched.
INSERT INTO contact_profile_queue (tenant_id, contact_id, connection_id)
SELECT i.tenant_id, i.contact_id, i.scope_id
  FROM contact_identities i
  JOIN contacts c ON c.tenant_id=i.tenant_id AND c.id=i.contact_id
  JOIN channel_connections n ON n.tenant_id=i.tenant_id AND n.id=i.scope_id
 WHERE i.kind IN ('messenger', 'instagram') AND i.valid_to IS NULL
   AND n.kind=i.kind AND c.display_name=i.external_id AND c.deleted_at IS NULL
ON CONFLICT DO NOTHING;
