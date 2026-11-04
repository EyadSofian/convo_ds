-- Template quick-reply buttons and interactive button/list selections were
-- journaled as unsupported. Keep the provider payload intact, correct only the
-- interpretation, and requeue it through the normal inbound transaction so
-- contacts, assignment, timeline, reply-window and realtime evidence agree.
-- Only identifiable WhatsApp customer replies with a nonempty string label
-- qualify. Already processed messages and unknown interactive variants stay put.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE tenant_row record; queued_count integer; total_queued integer := 0;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id', tenant_row.id::text, true);
    WITH candidates AS (
      SELECT event.id,
             CASE event.payload->>'type'
               WHEN 'button' THEN event.payload->'button'->'text'
               WHEN 'interactive' THEN event.payload->'interactive'->(event.payload->'interactive'->>'type')->'title'
             END AS label
        FROM channel_events event
        JOIN channel_connections connection ON connection.id=event.connection_id
       WHERE event.tenant_id=tenant_row.id AND connection.kind='whatsapp'
         AND event.status <> 'quarantined' AND event.normalized->>'kind'='unsupported'
         AND event.normalized->>'providerMessageId'=event.payload->>'id'
         AND event.normalized->>'peerIdentity'=event.payload->>'from'
         AND coalesce(event.payload->>'id','') <> '' AND coalesce(event.payload->>'from','') <> ''
         AND (event.payload->>'type'='button' OR (event.payload->>'type'='interactive'
              AND event.payload->'interactive'->>'type' IN ('button_reply','list_reply')))
         -- Never reopen an archived thread or attach an old reply to a newer
         -- episode. Replay current threads (including outbound-only quick
         -- starts), or first messages whose conversation was never created.
         AND (EXISTS (SELECT 1 FROM conversations thread WHERE thread.connection_id=event.connection_id
                      AND thread.peer_identity=event.payload->>'from' AND thread.status <> 'archived'
                      AND thread.created_at <= event.received_at)
              OR NOT EXISTS (SELECT 1 FROM conversations thread WHERE thread.connection_id=event.connection_id
                             AND thread.peer_identity=event.payload->>'from'))
         AND NOT EXISTS (SELECT 1 FROM inbound_events existing WHERE existing.event_id=event.id AND existing.kind='message')
    ), repaired AS (
      UPDATE channel_events event
         SET normalized=jsonb_set(jsonb_set(jsonb_set(event.normalized,'{kind}','"message"'::jsonb),'{text}',candidate.label),
                    '{detail}',coalesce(event.normalized->'detail','{}'::jsonb)-'unsupported_type'),
             status='received', processed_at=NULL
        FROM candidates candidate
       WHERE event.id=candidate.id AND jsonb_typeof(candidate.label)='string' AND candidate.label #>> '{}' <> ''
      RETURNING event.id
    ), removed AS (
      DELETE FROM inbound_events unsupported USING repaired
       WHERE unsupported.event_id=repaired.id AND unsupported.kind='unsupported'
      RETURNING unsupported.id
    )
    INSERT INTO channel_event_queue(event_id,tenant_id)
    SELECT id,tenant_row.id FROM repaired
    ON CONFLICT(event_id) DO UPDATE SET leased_by=NULL,lease_until=NULL,attempts=0,last_error=NULL;
    GET DIAGNOSTICS queued_count = ROW_COUNT;
    total_queued := total_queued + queued_count;
  END LOOP;
  PERFORM set_config('convo.tenant_id', '', true);
  RAISE NOTICE 'WhatsApp button replies queued for recovery: %', total_queued;
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
