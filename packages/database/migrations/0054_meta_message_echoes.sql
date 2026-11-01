-- Messages a business sends from outside CONVO — Meta Business Suite replies
-- and Meta's own automated answers on Messenger and Instagram — arrive as
-- echoes. They were stored as `unsupported` and keyed on the Page, so the
-- thread never showed the reply even though the customer had received it.
-- Echoes become their own inbound kind, keyed on the customer they were sent to.
ALTER TABLE inbound_events DROP CONSTRAINT inbound_events_kind_check;
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_kind_check CHECK (kind IN (
  'message', 'echo', 'delivery_status', 'read_status', 'reaction',
  'identity_change', 'unsupported'
));

-- An outbound message recorded from the provider invalidates the open thread
-- and the list preview. No message content is put on the realtime wire.
ALTER TABLE realtime_events DROP CONSTRAINT realtime_events_type_check;
ALTER TABLE realtime_events ADD CONSTRAINT realtime_events_type_check CHECK (type IN (
  'message.inbound', 'message.delivery', 'message.external', 'conversation.assigned',
  'conversation.state', 'conversation.note', 'conversation.handoff',
  'conversation.routing', 'conversation.contact', 'notification.changed'
));

-- Repair the echoes already received. The journaled provider element is the
-- evidence for who the message was sent to; rows whose evidence does not say
-- so are left as they were. Bindings stay NULL, so the existing half-open
-- interval rules attach each echo to the thread it happened in.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE tenant_row record;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', tenant_row.id::text, true);
    UPDATE inbound_events echo
       SET kind = 'echo',
           peer_identity = source.payload->'recipient'->>'id'
      FROM channel_events source
     WHERE echo.tenant_id = tenant_row.id
       AND source.tenant_id = echo.tenant_id
       AND source.id = echo.event_id
       AND echo.kind = 'unsupported'
       AND echo.provider_message_id IS NOT NULL
       AND echo.detail->>'echo' = 'true'
       AND source.payload->'message'->>'is_echo' = 'true'
       AND coalesce(source.payload->'recipient'->>'id', '') <> '';
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
