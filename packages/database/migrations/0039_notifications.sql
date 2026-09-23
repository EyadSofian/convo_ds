-- 0039_notifications
-- Durable, recipient-owned notifications. The realtime row is only an
-- invalidation signal; this table remains the source of unread state.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new_message', 'assignment', 'handoff', 'campaign', 'automation_failure')),
  target_type text NOT NULL CHECK (target_type IN ('conversation', 'handoff', 'campaign', 'automation')),
  target_id uuid NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_recipient_fk FOREIGN KEY (tenant_id, recipient_membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notifications_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT notifications_dedupe_uq UNIQUE (tenant_id, recipient_membership_id, dedupe_key)
);
CREATE INDEX notifications_recipient_page_idx
  ON notifications (tenant_id, recipient_membership_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx
  ON notifications (tenant_id, recipient_membership_id) WHERE read_at IS NULL;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON notifications TO convo_app;

-- Subscription/token material is encrypted with the installation credential
-- key and never returned by an API. One member may register many devices.
CREATE TABLE notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  device_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web_push', 'android', 'ios')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version text NOT NULL,
  token_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  CONSTRAINT notification_devices_member_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_devices_identity_uq UNIQUE (tenant_id, membership_id, device_id),
  CONSTRAINT notification_devices_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT notification_devices_revoked_ck CHECK (enabled OR revoked_at IS NOT NULL)
);
CREATE INDEX notification_devices_active_idx
  ON notification_devices (tenant_id, membership_id, platform) WHERE enabled;
-- One physical browser subscription must not keep receiving another member's
-- notifications after an account switch in the same workspace.
CREATE UNIQUE INDEX notification_devices_active_endpoint_uq
  ON notification_devices (tenant_id, token_fingerprint) WHERE enabled;
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_devices
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON notification_devices TO convo_app;

-- Global lease discovery is intentionally content-free. The worker enters the
-- tenant's RLS context before reading a device subscription or notification.
CREATE TABLE notification_push_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  device_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed','skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT notification_push_queue_notification_fk FOREIGN KEY (tenant_id, notification_id)
    REFERENCES notifications(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_push_queue_device_fk FOREIGN KEY (tenant_id, device_id)
    REFERENCES notification_devices(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_push_queue_unique UNIQUE (notification_id, device_id)
);
CREATE INDEX notification_push_queue_claim_idx
  ON notification_push_queue (next_attempt_at, id) WHERE state='pending';
GRANT SELECT, INSERT, UPDATE ON notification_push_queue TO convo_app;

-- A recipient-only event has no conversation scope. The feed explicitly
-- authorizes these by membership before constructing a payload. Existing
-- conversation event authorization remains unchanged.
ALTER TABLE realtime_events ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE realtime_events ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE realtime_events ADD COLUMN recipient_membership_id uuid;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_recipient_fk
  FOREIGN KEY (tenant_id, recipient_membership_id)
  REFERENCES memberships(tenant_id, id);
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_type_check CHECK (type IN (
  'message.inbound', 'message.delivery', 'conversation.assigned',
  'conversation.state', 'conversation.note', 'conversation.handoff',
  'conversation.routing', 'notification.changed'
));
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_entity_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_entity_type_check
  CHECK (entity_type IN ('conversation', 'message', 'note', 'notification'));
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_scope_shape_ck CHECK (
  (type = 'notification.changed' AND recipient_membership_id IS NOT NULL
    AND conversation_id IS NULL AND connection_id IS NULL)
  OR (type <> 'notification.changed' AND recipient_membership_id IS NULL
    AND conversation_id IS NOT NULL AND connection_id IS NOT NULL)
);
