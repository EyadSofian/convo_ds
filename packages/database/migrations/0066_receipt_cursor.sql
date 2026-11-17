-- Receipts were folded at most once per instant, not once each.
--
-- `inbound_events.observed_at` defaulted to `now()`, which in Postgres is the
-- *transaction's* clock. One normalisation pass claims up to forty queued
-- events and stamps every one of them with the same instant — and a broadcast
-- is precisely the case where a message's `sent`, `delivered` and `read` land
-- in one burst and are normalised together.
--
-- The fold then used that instant as a per-message cursor, compared with a
-- strict `>`. Once any one of those receipts was folded, its siblings at the
-- same instant were below the cursor for ever, so a delivered-and-read
-- broadcast reported as merely sent. Two corrections:
--
-- 1. `observed_at` becomes `clock_timestamp()`, so each row carries the instant
--    it was actually written rather than the instant its transaction began.
-- 2. The cursor becomes the pair (observed_at, inbound event id). Two receipts
--    may share a clock reading; they cannot share a primary key, so the pair
--    orders them totally and the sweep can resume exactly where it stopped.
ALTER TABLE inbound_events ALTER COLUMN observed_at SET DEFAULT clock_timestamp();

ALTER TABLE outbound_messages ADD COLUMN receipts_folded_through_event uuid;

COMMENT ON COLUMN outbound_messages.receipts_folded_through IS
  'With receipts_folded_through_event, the (observed_at, id) of the last inbound receipt folded into this message. Receipts at or below the pair are history, not news.';
COMMENT ON COLUMN outbound_messages.receipts_folded_through_event IS
  'The inbound event half of the fold cursor. Breaks ties between receipts observed at the same instant, which a timestamp alone cannot.';

-- The fold joins receipts to the message they are about on the provider's id,
-- and nothing indexed that in either direction. On a company with a broadcast
-- behind it this was a hash join over both tables on every tick.
CREATE INDEX outbound_messages_provider_message_idx
  ON outbound_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX inbound_events_receipt_idx
  ON inbound_events (tenant_id, provider_message_id, observed_at, id)
  WHERE kind IN ('delivery_status', 'read_status');

-- Re-fold everything that has receipts, through the corrected sweep.
--
-- The receipts themselves were never lost — they are in `inbound_events`, where
-- the ingress put them — so clearing the cursor is enough to have the worker
-- read them again and recompute each message's delivery state and each
-- broadcast recipient's state from them. The work is bounded per tick and
-- idempotent, so a large installation catches up over a few minutes rather than
-- holding this migration open.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE company record;
BEGIN
  FOR company IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', company.id::text, true);
    UPDATE outbound_messages SET receipts_folded_through = NULL
     WHERE tenant_id = company.id AND receipts_folded_through IS NOT NULL;
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
