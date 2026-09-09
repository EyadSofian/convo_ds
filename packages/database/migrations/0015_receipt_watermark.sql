-- 0015_receipt_watermark
-- Fold each provider receipt once.
--
-- The reconciler scans the receipts it can see and folds them into the message
-- they name. Without a watermark it re-scans receipts it has already folded,
-- and the second pass is not harmless: a `delivered` receipt that was folded
-- correctly, before its `read`, is re-applied afterwards against a message that
-- has since moved to `read` — and `foldDelivery` correctly reports that as
-- `delivered_after_read`. The disagreement is manufactured by re-reading
-- history, not by anything the provider did.
--
-- The watermark is on **observation** time, not the provider's timestamp. A
-- genuinely late `delivered` — one we saw after the `read` — still has a newer
-- `observed_at`, so it is folded and its anomaly recorded exactly once (DEL-16).
-- Filtering on the provider's `occurred_at` instead would silently discard that
-- case, which is the one worth knowing about.
ALTER TABLE outbound_messages
  ADD COLUMN receipts_folded_through timestamptz;

COMMENT ON COLUMN outbound_messages.receipts_folded_through IS
  'Highest inbound_events.observed_at already folded into this message''s delivery state. Receipts at or below it are history, not news.';
