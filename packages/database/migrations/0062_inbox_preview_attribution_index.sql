-- The Inbox list reads each row's latest message, and a campaign send counts
-- when its attribution names the conversation. That lookup is by conversation,
-- and no index led with it, so every row of a page scanned the attributions.
CREATE INDEX campaign_conversation_attributions_conversation_idx
  ON campaign_conversation_attributions (tenant_id, conversation_id, outbound_message_id)
  WHERE conversation_id IS NOT NULL;
