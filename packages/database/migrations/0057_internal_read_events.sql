-- Internal team read activity, independent of customer delivery/read receipts.
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_type_check CHECK (type IN (
 'message.inbound','message.delivery','message.external','conversation.assigned',
 'conversation.state','conversation.note','conversation.handoff','conversation.routing',
 'conversation.contact','conversation.read','notification.changed'
));

-- Team seen markers are durable evidence, independent of a personal Unread
-- reminder. Marking unread cannot erase that someone already viewed a message.
CREATE TABLE conversation_read_receipts (
 tenant_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 read_through timestamptz NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,conversation_id,membership_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE conversation_read_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_read_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_read_receipts USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
GRANT SELECT,INSERT,UPDATE ON conversation_read_receipts TO convo_app;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE tenant_row record;
BEGIN
 FOR tenant_row IN SELECT id FROM tenants LOOP
  PERFORM set_config('convo.tenant_id',tenant_row.id::text,true);
  INSERT INTO conversation_read_receipts(tenant_id,conversation_id,membership_id,read_through,seen_at)
  SELECT tenant_id,conversation_id,membership_id,read_through,updated_at FROM conversation_reads WHERE tenant_id=tenant_row.id;
 END LOOP;
 PERFORM set_config('convo.tenant_id','',true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
