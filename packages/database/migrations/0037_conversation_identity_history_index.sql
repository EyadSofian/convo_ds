-- 0037_conversation_identity_history_index
-- Historical unbound-event ownership is resolved by tenant, connection and
-- peer identity. Keep archived conversations in this index: they remain
-- reportable history and participate in half-open event-boundary resolution.

CREATE INDEX conversations_identity_history_idx
  ON conversations (tenant_id, connection_id, peer_identity)
  INCLUDE (created_at, archived_at);
