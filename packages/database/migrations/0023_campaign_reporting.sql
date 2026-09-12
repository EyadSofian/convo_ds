-- 0023_campaign_reporting
-- A tenant-isolated reporting projection over immutable campaign execution
-- evidence. Aggregates and exports read this narrow shape instead of joining
-- operational tables independently and silently disagreeing about states.

CREATE VIEW campaign_report_rows WITH (security_invoker = true) AS
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
  b.reconciled_amount_minor
FROM campaign_recipients r
JOIN campaign_executions e ON e.id = r.execution_id
JOIN campaigns c ON c.id = e.campaign_id
JOIN channel_connections connection ON connection.id = c.connection_id
LEFT JOIN budget_reservations b ON b.recipient_id = r.id;

GRANT SELECT ON campaign_report_rows TO convo_app;
