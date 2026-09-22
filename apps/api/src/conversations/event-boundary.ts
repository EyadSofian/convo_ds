/**
 * SQL ownership for an event that may be attached to one conversation.
 *
 * New rows use `conversation_id` as authoritative evidence. Historical rows
 * with NULL bindings use half-open temporal intervals. For inbound opening
 * events only, the first episode inbound timestamp may precede the conversation
 * insert because journaling happens before normalization; use that earlier
 * timestamp as the legacy interval start. Outbound ownership starts at the
 * conversation insert. If old intervals overlap, the latest eligible start
 * wins (UUID breaks an exact timestamp tie), so one event cannot multiply
 * across historical threads. No stored historical row is rewritten.
 */
export function conversationEventBoundary(
  conversationAlias: string,
  eventAlias: string,
  eventTimestamp: string,
  options: { readonly inboundOpeningEvent?: boolean } = {},
): string {
  const start = (alias: string): string => options.inboundOpeningEvent === true
    ? `LEAST(${alias}.created_at, COALESCE((SELECT min(episode.first_inbound_at) FROM conversation_episodes episode WHERE episode.conversation_id=${alias}.id), ${alias}.created_at))`
    : `${alias}.created_at`;
  const timestamp = eventTimestamp;
  const interval = (alias: string): string =>
    `${timestamp} >= ${start(alias)} AND (${alias}.archived_at IS NULL OR ${timestamp} < ${alias}.archived_at)`;
  const wins = `((${start('other')} > ${start(conversationAlias)}) OR (${start('other')} = ${start(conversationAlias)} AND other.id > ${conversationAlias}.id))`;
  return `${eventAlias}.tenant_id=${conversationAlias}.tenant_id
    AND ${eventAlias}.connection_id=${conversationAlias}.connection_id
    AND ${eventAlias}.peer_identity=${conversationAlias}.peer_identity
    AND (${eventAlias}.conversation_id=${conversationAlias}.id OR (
      ${eventAlias}.conversation_id IS NULL
      AND ${interval(conversationAlias)}
      AND NOT EXISTS (
        SELECT 1 FROM conversations other
         WHERE other.id<>${conversationAlias}.id
           AND other.tenant_id=${conversationAlias}.tenant_id
           AND other.connection_id=${conversationAlias}.connection_id
           AND other.peer_identity=${conversationAlias}.peer_identity
           AND ${interval('other')}
           AND ${wins}
      )
    ))`;
}

/** Human-authored messages, excluding explicit campaign test sends. */
export function qualifyingHumanOutbound(alias: string): string {
  return `${alias}.author_membership IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM campaign_test_sends test_send WHERE test_send.message_id=${alias}.id)`;
}

/** Latest customer inbound is newer than the latest human answer in this thread. */
export function conversationUnrepliedPredicate(conversationAlias: string): string {
  const inboundBoundary = conversationEventBoundary(conversationAlias, 'inbound', 'inbound.occurred_at', { inboundOpeningEvent: true });
  const outboundBoundary = conversationEventBoundary(conversationAlias, 'outbound', 'outbound.created_at');
  return `((SELECT max(inbound.occurred_at) FROM inbound_events inbound
             WHERE inbound.kind='message' AND ${inboundBoundary})
          > COALESCE((SELECT max(outbound.created_at) FROM outbound_messages outbound
                        WHERE ${qualifyingHumanOutbound('outbound')} AND ${outboundBoundary}), '-infinity'::timestamptz))`;
}
