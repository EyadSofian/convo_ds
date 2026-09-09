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
  readonly direction: 'in' | 'out';
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
}

interface TimelineRow {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly at: Date;
  readonly content_type: string | null;
  readonly text_body: string | null;
  readonly attachments: unknown;
  readonly author_membership_id: string | null;
  readonly command_state: string | null;
  readonly delivery_state: string | null;
  readonly delivery_anomaly: string | null;
  readonly provider_message_id: string | null;
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
              NULL::text AS delivery_anomaly, e.provider_message_id
         FROM inbound_events e
        WHERE e.connection_id = $1 AND e.peer_identity = $2 AND e.kind = 'message'
       UNION ALL
       SELECT m.id::text, 'out', m.created_at,
              m.message_type, m.text_body, m.attachments,
              m.author_membership::text,
              m.command_state, m.delivery_state,
              m.delivery_anomaly, m.provider_message_id
         FROM outbound_messages m
        WHERE m.connection_id = $1 AND m.peer_identity = $2
     )
     SELECT * FROM merged
      WHERE $3::timestamptz IS NULL OR (at, id) < ($3::timestamptz, $4::text)
      ORDER BY at DESC, id DESC
      LIMIT $5`,
    [connectionId, peerIdentity, after?.at ?? null, after?.id ?? null, limit + 1],
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
  };
}
