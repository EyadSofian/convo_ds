-- Earlier dispatches recorded provider acceptance without recording the
-- connection's first outbound evidence. Backfill only accepted commands;
-- queued, rejected and unknown outcomes do not prove send capability.
UPDATE channel_connections AS connection
   SET first_outbound_at = accepted.first_accepted_at
  FROM (
    SELECT tenant_id, connection_id, min(settled_at) AS first_accepted_at
      FROM outbound_messages
     WHERE command_state = 'provider_accepted'
       AND provider_message_id IS NOT NULL
       AND settled_at IS NOT NULL
     GROUP BY tenant_id, connection_id
  ) AS accepted
 WHERE connection.tenant_id = accepted.tenant_id
   AND connection.id = accepted.connection_id
   AND connection.first_outbound_at IS NULL;
