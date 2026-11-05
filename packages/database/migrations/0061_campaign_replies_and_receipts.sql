-- Two corrections to what broadcast reports could say.
--
-- 1. Replies were not measured at all. A recipient replied when the customer wrote
--    on the same line after the broadcast went out and before the next broadcast
--    that reached them. The rule lives in one function so that the report, the
--    export and the recipient list cannot disagree about who replied.
--
-- 2. Every WhatsApp `sent` and `failed` status was folded as `delivered`. A
--    message Meta refused counted as delivered, and a late `sent` after a `read`
--    showed up as conflicting receipts. `failed` becomes a state of its own, and
--    what was already recorded is recomputed from the receipts themselves.
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_delivery_state_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_delivery_state_check
  CHECK (delivery_state IN ('sent', 'failed', 'delivered', 'read'));

CREATE INDEX campaign_conversation_attributions_recipient_idx
  ON campaign_conversation_attributions (tenant_id, recipient_id);
CREATE INDEX campaign_conversation_attributions_identity_idx
  ON campaign_conversation_attributions (tenant_id, connection_id, peer_identity, sent_at);

CREATE FUNCTION campaign_recipient_replied(recipient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM campaign_conversation_attributions sent
      JOIN inbound_events reply
        ON reply.tenant_id = sent.tenant_id
       AND reply.connection_id = sent.connection_id
       AND reply.peer_identity = sent.peer_identity
     WHERE sent.recipient_id = recipient
       AND reply.kind = 'message'
       AND reply.occurred_at >= sent.sent_at
       -- A later broadcast that really went out takes the replies after it.
       AND NOT EXISTS (
         SELECT 1
           FROM campaign_conversation_attributions later
           JOIN campaign_recipients later_recipient ON later_recipient.id = later.recipient_id
          WHERE later.tenant_id = sent.tenant_id
            AND later.connection_id = sent.connection_id
            AND later.peer_identity = sent.peer_identity
            AND later.sent_at > sent.sent_at
            AND later.sent_at <= reply.occurred_at
            AND later_recipient.state IN ('accepted', 'delivered', 'read')
       )
  );
$$;

CREATE OR REPLACE VIEW campaign_report_rows WITH (security_invoker = true) AS
SELECT
  r.tenant_id,
  e.campaign_id,
  e.id AS execution_id,
  r.id AS recipient_id,
  c.connection_id,
  connection.kind AS channel_kind,
  r.state AS current_state,
  r.last_error->>'code' AS error_code,
  r.updated_at AS fresh_through,
  (r.state IN ('accepted','delivered','read')) AS accepted_milestone,
  (r.state IN ('delivered','read')) AS delivered_milestone,
  (r.state = 'read') AS read_milestone,
  coalesce((connection.capabilities->>'deliveryReceipts')::boolean, false) AS delivery_receipts,
  coalesce((connection.capabilities->>'readReceipts')::boolean, false) AS read_receipts,
  b.currency,
  b.estimated_amount_minor,
  b.committed_amount_minor,
  b.reconciled_amount_minor,
  -- A message that never left cannot have been replied to, whoever wrote in.
  (r.state IN ('accepted','delivered','read') AND campaign_recipient_replied(r.id)) AS replied_milestone
FROM campaign_recipients r
JOIN campaign_executions e ON e.id = r.execution_id
JOIN campaigns c ON c.id = e.campaign_id
JOIN channel_connections connection ON connection.id = c.connection_id
LEFT JOIN budget_reservations b ON b.recipient_id = r.id;

-- Recompute from the evidence. Only messages whose recorded state or anomaly
-- disagrees change, so running this again changes nothing.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE company record;
BEGIN
  FOR company IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', company.id::text, true);
    WITH evidence AS (
      SELECT message.id,
             bool_or(receipt.kind = 'read_status') AS was_read,
             bool_or(receipt.kind = 'delivery_status' AND coalesce(receipt.detail->>'state', 'delivered') NOT IN ('sent', 'failed')) AS was_delivered,
             bool_or(receipt.detail->>'state' = 'failed') AS was_failed,
             min(receipt.detail->'errors'->0->>'code') FILTER (WHERE receipt.detail->>'state' = 'failed') AS failure_code
        FROM outbound_messages message
        JOIN inbound_events receipt
          ON receipt.tenant_id = message.tenant_id
         AND receipt.provider_message_id = message.provider_message_id
         AND receipt.kind IN ('delivery_status', 'read_status')
       WHERE message.tenant_id = company.id AND message.delivery_state IS NOT NULL
       GROUP BY message.id
    ), corrected AS (
      SELECT id, was_delivered, failure_code,
             CASE WHEN was_read THEN 'read' WHEN was_delivered THEN 'delivered'
                  WHEN was_failed THEN 'failed' ELSE 'sent' END AS state
        FROM evidence
    ), messages AS (
      UPDATE outbound_messages message
         SET delivery_state = corrected.state,
             -- Only a real `delivered` can have disagreed with a `read`.
             delivery_anomaly = CASE WHEN corrected.was_delivered THEN message.delivery_anomaly END
        FROM corrected
       WHERE message.id = corrected.id
         AND (message.delivery_state <> corrected.state
              OR (message.delivery_anomaly IS NOT NULL AND NOT corrected.was_delivered))
    )
    UPDATE campaign_recipients recipient
       SET state = CASE corrected.state WHEN 'sent' THEN 'accepted' ELSE corrected.state END,
           last_error = CASE WHEN corrected.state = 'failed'
                             THEN jsonb_build_object('code', 'provider_error_' || coalesce(corrected.failure_code, 'unknown'))
                             ELSE recipient.last_error END,
           updated_at = now()
      FROM corrected
     WHERE recipient.command_id = corrected.id
       AND recipient.state IN ('accepted', 'delivered', 'read')
       AND recipient.state <> CASE corrected.state WHEN 'sent' THEN 'accepted' ELSE corrected.state END;
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
