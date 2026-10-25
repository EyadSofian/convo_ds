-- Meta ingress recorded the first inbound event but did not recompute the
-- persisted readiness used by campaign launch and the outbound dispatcher.
-- Backfill connections whose existing evidence already proves readiness.
UPDATE channel_connections
   SET status = 'healthy'
 WHERE status <> 'healthy'
   AND disconnected_at IS NULL
   AND asset_verified_at IS NOT NULL
   AND credential_verified_at IS NOT NULL
   AND webhook_subscribed_at IS NOT NULL
   AND first_inbound_at IS NOT NULL
   AND last_error_code IS NULL
   AND (kind <> 'instagram' OR settings->>'facebook_page_id' IS NOT NULL);
