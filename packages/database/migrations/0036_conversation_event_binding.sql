-- 0036_conversation_event_binding
-- Bind newly normalized inbound and operator outbound messages to the exact
-- conversation that handled them. Existing rows remain NULL: their ownership
-- is resolved only by the conservative half-open temporal fallback in reports.

ALTER TABLE inbound_events
  ADD COLUMN conversation_id uuid,
  ADD CONSTRAINT inbound_events_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id);

ALTER TABLE outbound_messages
  ADD COLUMN conversation_id uuid,
  ADD CONSTRAINT outbound_messages_conversation_fk
    FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id);

GRANT UPDATE (conversation_id) ON inbound_events TO convo_app;

CREATE INDEX inbound_events_bound_conversation_idx
  ON inbound_events (tenant_id, conversation_id, occurred_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX outbound_messages_bound_conversation_idx
  ON outbound_messages (tenant_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

COMMENT ON COLUMN inbound_events.conversation_id IS
  'Conversation assigned by the inbound normalizer in the same transaction. NULL means historical/unbound; never backfilled from identity alone.';
COMMENT ON COLUMN outbound_messages.conversation_id IS
  'Conversation assigned when a human replies through that conversation. NULL means historical or channel-level send; never inferred into stored history.';
