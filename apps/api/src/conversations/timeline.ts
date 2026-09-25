import { createHmac } from 'node:crypto';
import type { SqlExecutor } from '@convo/domain';
import { OpaqueCursorCodec } from '../pagination.js';
import type { CursorBinding } from '../pagination.js';

/**
 * The conversation timeline: what the customer sent and what we sent back, in
 * one ordered list.
 *
 * The two halves live in different tables for good reasons — an inbound event is
 * evidence of something that arrived, an outbound message is a command with its
 * own state machine — and merging them for display does not merge them for
 * storage. The `UNION ALL` here is a *read*: nothing is copied, so there is no
 * second place for a message to exist and drift.
 *
 * Paged backwards from the newest, because that is how anybody reads a
 * conversation: the tail first, then further back on demand. The cursor is the
 * opaque, tenant-bound, expiring kind the API contract requires (API-03), so a
 * page position cannot be edited into another company's conversation or replayed
 * a week later against a different sort.
 */

export interface TimelineMessage {
  readonly id: string;
  readonly direction: 'in' | 'out' | 'reaction';
  readonly at: string;
  readonly content_type: string | null;
  readonly text: string | null;
  readonly attachments: unknown;
  readonly author_membership_id: string | null;
  /** Outbound only: what we asked the provider to do. */
  readonly command_state: string | null;
  /** Outbound only: what the provider later said happened. */
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
  readonly template_name: string | null;
  readonly template_language: string | null;
  readonly template_preview: string | null;
  /** Instagram message reaction, never treated as a new customer message. */
  readonly reaction_action: string | null;
}

interface TimelineRow {
  readonly id: string;
  readonly direction: 'in' | 'out' | 'reaction';
  readonly at: Date;
  readonly content_type: string | null;
  readonly text_body: string | null;
  readonly attachments: unknown;
  readonly author_membership_id: string | null;
  readonly command_state: string | null;
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
  readonly template_name: string | null;
  readonly template_language: string | null;
  readonly template_preview: string | null;
  readonly reaction_action: string | null;
}

export interface TimelinePage {
  readonly messages: readonly TimelineMessage[];
  readonly nextCursor: string | null;
}

export const TIMELINE_PAGE_SIZE = 50;

const SORT = 'at:desc';

/**
 * A signing key for cursors, derived from the installation's root secret.
 *
 * Derived rather than reused: signing page positions with the same key that
 * fingerprints idempotency requests would make one secret serve two purposes,
 * and a weakness found in either would then be a weakness in both. One label,
 * one key, one job.
 */
export function cursorKeyFrom(rootSecret: string): string {
  return createHmac('sha256', rootSecret).update('convo:cursor:v1', 'utf8').digest('base64');
}

export function timelineCodec(rootSecret: string, now: () => number = Date.now): OpaqueCursorCodec {
  return new OpaqueCursorCodec(cursorKeyFrom(rootSecret), now);
}

export function timelineBinding(tenantId: string, conversationId: string): CursorBinding {
  // The conversation is part of the binding, so a cursor from one conversation
  // is not a valid position in another — even for the same caller.
  return { tenantId, filterHash: conversationId, sort: SORT };
}

/**
 * Reads one page, newest first, and returns it oldest-first for rendering.
 *
 * `limit + 1` rows are asked for so "is there more" is answered by the query
 * rather than by a count that would race the next insert.
 */
export async function readTimeline(
  sql: SqlExecutor,
  conversationId: string,
  connectionId: string,
  peerIdentity: string,
  after: { readonly at: string; readonly id: string } | null,
  limit: number,
): Promise<{ readonly rows: readonly TimelineMessage[]; readonly hasMore: boolean }> {
  const result = await sql.query<TimelineRow>(
    `WITH merged AS (
       SELECT e.id::text AS id, 'in' AS direction, e.occurred_at AS at,
              e.content_type, e.text_body, e.attachments,
              NULL::text AS author_membership_id,
              NULL::text AS command_state, NULL::text AS delivery_state,
              NULL::text AS delivery_anomaly, e.provider_message_id,
              NULL::text AS template_name, NULL::text AS template_language, NULL::text AS template_preview,
              NULL::text AS reaction_action
        FROM inbound_events e
        WHERE e.connection_id = $2 AND e.peer_identity = $3 AND e.kind = 'message'
          AND (e.conversation_id=$1 OR (e.conversation_id IS NULL
            AND e.occurred_at >= (SELECT c.created_at FROM conversations c WHERE c.id=$1)
            AND e.occurred_at < COALESCE((SELECT c.archived_at FROM conversations c WHERE c.id=$1), 'infinity'::timestamptz)))
       UNION ALL
       SELECT m.id::text, 'out', m.created_at,
              m.message_type, m.text_body, m.attachments,
              m.author_membership::text,
              m.command_state, m.delivery_state,
              m.delivery_anomaly, m.provider_message_id,
              m.template_name,m.template_language,m.template_preview,
              NULL::text AS reaction_action
         FROM outbound_messages m
        WHERE m.connection_id = $2 AND m.peer_identity = $3
          AND (m.conversation_id=$1 OR (m.conversation_id IS NULL
            AND m.created_at >= (SELECT c.created_at FROM conversations c WHERE c.id=$1)
            AND m.created_at < COALESCE((SELECT c.archived_at FROM conversations c WHERE c.id=$1), 'infinity'::timestamptz)))
       UNION ALL
       SELECT r.id::text, 'reaction', r.occurred_at,
              r.content_type, r.text_body, r.attachments,
              NULL::text, NULL::text, NULL::text, NULL::text,
              r.provider_message_id,
              NULL::text, NULL::text, NULL::text,
              r.detail->>'action'
         FROM inbound_events r
        WHERE r.connection_id=$2 AND r.peer_identity=$3 AND r.kind='reaction'
          AND EXISTS (
            SELECT 1 FROM outbound_messages target
             WHERE target.tenant_id=r.tenant_id
               AND target.connection_id=r.connection_id
               AND target.peer_identity=r.peer_identity
               AND target.provider_message_id=r.provider_message_id
               AND (target.conversation_id=$1 OR (target.conversation_id IS NULL
                 AND target.created_at >= (SELECT c.created_at FROM conversations c WHERE c.id=$1)
                 AND target.created_at < COALESCE((SELECT c.archived_at FROM conversations c WHERE c.id=$1), 'infinity'::timestamptz)))
          )
     )
     SELECT * FROM merged
      WHERE $4::timestamptz IS NULL OR (at, id) < ($4::timestamptz, $5::text)
      ORDER BY at DESC, id DESC
      LIMIT $6`,
    [conversationId, connectionId, peerIdentity, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  return {
    // Oldest first: a timeline is read downwards, and reversing in the browser
    // would put the ordering rule in two places.
    rows: page.map(messageOf).reverse(),
    hasMore: result.rows.length > limit,
  };
}

function messageOf(row: TimelineRow): TimelineMessage {
  return {
    id: row.id,
    direction: row.direction,
    at: row.at.toISOString(),
    content_type: row.content_type,
    text: row.text_body,
    attachments: row.attachments,
    author_membership_id: row.author_membership_id,
    command_state: row.command_state,
    delivery_state: row.delivery_state,
    delivery_anomaly: row.delivery_anomaly,
    provider_message_id: row.provider_message_id,
    template_name: row.template_name,
    template_language: row.template_language,
    template_preview: row.template_preview,
    reaction_action: row.reaction_action,
  };
}
