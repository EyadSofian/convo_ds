import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type {
  Principal,
  RealtimeEnvelope,
  RealtimeEventType,
  SqlExecutor,
} from '@convo/domain';
import {
  canonicalAuthority,
  checkCursor,
  encodeCursor,
  projectQueueCard,
  REALTIME_SCHEMA_VERSION,
  visibilityOf,
} from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_POOL } from '../tokens.js';

/**
 * The realtime feed: one append-only log per company, read through an
 * authorization decision made again for every event.
 *
 * Three properties this service exists to hold:
 *
 * 1. **An event is written in the transaction that caused it.** `emit` takes
 *    the caller's executor rather than opening its own connection, so a
 *    conversation change and the event announcing it commit together or not at
 *    all (DEL-07). There is no window where the inbox moved and nobody was told.
 *
 * 2. **Order is commit order, and it is gapless.** The sequence comes from a
 *    counter row taken under a lock held to commit, not from a `bigserial` —
 *    see 0014's comment. A client can therefore tell "nothing happened" from
 *    "I missed something", which is what makes catch-up meaningful.
 *
 * 3. **Authorization is not done at subscribe time.** It is redone for every
 *    event against a principal re-read from the database, so revoking a role,
 *    suspending a membership or removing an inbox takes effect on the next
 *    event rather than at the next login.
 */

export interface EmittedEvent {
  readonly type: RealtimeEventType;
  readonly entityType: 'conversation' | 'message';
  readonly entityId: string;
  readonly entityVersion: number;
  readonly conversationId: string;
  readonly connectionId: string;
  readonly teamId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type FeedReset =
  | 'malformed'
  | 'other_tenant'
  | 'permissions_changed'
  | 'expired'
  | 'too_far_behind';

export type FeedPage =
  | {
      readonly status: 'ok';
      readonly events: readonly RealtimeEnvelope[];
      readonly cursor: string;
      /** Events waiting beyond this page. */
      readonly backlog: number;
      readonly authority: string;
    }
  | { readonly status: 'reset_required'; readonly reason: FeedReset; readonly cursor: string };

interface FeedRow {
  readonly id: string;
  readonly seq: string;
  readonly schema_version: number;
  readonly type: RealtimeEventType;
  readonly entity_type: 'conversation' | 'message';
  readonly entity_id: string;
  readonly entity_version: number;
  readonly conversation_id: string;
  readonly connection_id: string;
  readonly team_id: string | null;
  readonly assignee_membership_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date;
}

@Injectable()
export class RealtimeService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Appends one event inside the caller's transaction.
   *
   * The sequence is allocated from the company's counter, which serializes
   * concurrent writers for that company and hands out numbers in commit order.
   */
  async emit(sql: SqlExecutor, tenantId: string, event: EmittedEvent): Promise<number> {
    const allocated = await sql.query<{ next_seq: string }>(
      `INSERT INTO tenant_event_sequences (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO UPDATE SET next_seq = tenant_event_sequences.next_seq + 1
       RETURNING next_seq::text`,
      [tenantId],
    );
    const seq = Number(requireRow(allocated.rows, 'the event sequence returned no row').next_seq);
    await sql.query(
      `INSERT INTO realtime_events
         (tenant_id, seq, schema_version, type, entity_type, entity_id, entity_version,
          conversation_id, connection_id, team_id, assignee_membership_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
      [
        tenantId,
        seq,
        REALTIME_SCHEMA_VERSION,
        event.type,
        event.entityType,
        event.entityId,
        event.entityVersion,
        event.conversationId,
        event.connectionId,
        event.teamId,
        event.assigneeMembershipId,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    return seq;
  }

  /** The digest a cursor is stamped with, so a permission change invalidates it. */
  authorityOf(principal: Principal): string {
    return createHash('sha256').update(canonicalAuthority(principal), 'utf8').digest('hex').slice(0, 32);
  }

  /**
   * One page of the feed for one caller.
   *
   * Everything happens in a single tenant transaction: the principal is read,
   * the cursor is checked against it, the events are read, and each one is
   * decided. Reading the principal in the same snapshot as the events is what
   * makes "revoked between two events" impossible to slip through.
   */
  async page(
    session: AuthenticatedSession,
    tenantId: string,
    cursor: string | null,
    limit: number,
    backlogLimit: number,
  ): Promise<FeedPage> {
    this.authorization.assertTenantId(tenantId);
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const principal = await this.authorization.requirePrincipal(sql, session);
      if (principal.membershipStatus !== 'active' || principal.tenantStatus !== 'active') {
        // The same 404 a non-member gets, for the same reason: from outside,
        // "your access was revoked" and "no such company" must look identical.
        // On an open stream this ends it, which is what revocation means for a
        // subscription that is already running.
        throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
      }
      const authority = this.authorityOf(principal);
      const oldest = await oldestRetainedSeq(sql);
      const check = checkCursor(cursor, { tenantId, authority, oldestRetainedSeq: oldest });
      if (check.status === 'reset_required') {
        return {
          status: 'reset_required' as const,
          reason: check.reason,
          // A cursor to start again from: the caller reloads and resumes here.
          cursor: encodeCursor({ tenantId, seq: oldest - 1, authority }),
        };
      }

      const backlog = await backlogAfter(sql, check.seq);
      if (backlog > backlogLimit) {
        // A consumer this far behind is not going to be caught up by a bigger
        // page; sending one would just move the problem into memory. It is told
        // to reload instead (DEL-21).
        return {
          status: 'reset_required' as const,
          reason: 'too_far_behind' as const,
          cursor: encodeCursor({ tenantId, seq: oldest - 1, authority }),
        };
      }

      const rows = await sql.query<FeedRow>(
        `SELECT id::text, seq::text, schema_version, type, entity_type, entity_id::text,
                entity_version, conversation_id::text, connection_id::text, team_id::text,
                assignee_membership_id::text, payload, occurred_at
           FROM realtime_events
          WHERE seq > $1
          -- Qualified on purpose: the select list renames seq::text to seq,
          -- and an unqualified ORDER BY binds to that text column and sorts
          -- 10 before 2 — which walks the cursor backwards forever.
          ORDER BY realtime_events.seq
          LIMIT $2`,
        [check.seq, limit],
      );

      const participants = await participantsFor(
        sql,
        rows.rows.map((row) => row.conversation_id),
      );

      const events: RealtimeEnvelope[] = [];
      let last = check.seq;
      for (const row of rows.rows) {
        last = Number(row.seq);
        const envelope = envelopeOf(row);
        const visibility = visibilityOf(
          principal,
          envelope,
          participants.get(row.conversation_id) ?? [],
        );
        if (visibility === 'hidden') {
          // Not an empty event and not a redacted one: nothing at all. A
          // subscriber must not be able to count another team's conversations
          // by watching sequence numbers go by.
          continue;
        }
        events.push(
          visibility === 'full'
            ? envelope
            : { ...envelope, payload: { ...projectQueueCard(envelope), projected: true } },
        );
      }

      return {
        status: 'ok' as const,
        events,
        cursor: encodeCursor({ tenantId, seq: last, authority }),
        backlog: Math.max(0, backlog - rows.rows.length),
        authority,
      };
    });
  }
}

/**
 * The lowest sequence the feed can still produce for this company.
 *
 * With nothing retained, the next event's number is the floor — so a first
 * connection starts from "nothing has happened yet" rather than from zero,
 * which would look like an expired cursor once pruning has run.
 */
async function oldestRetainedSeq(sql: SqlExecutor): Promise<number> {
  const rows = await sql.query<{ oldest: string | null; next: string | null }>(
    `SELECT (SELECT min(seq)::text FROM realtime_events) AS oldest,
            (SELECT next_seq::text FROM tenant_event_sequences) AS next`,
  );
  const row = rows.rows[0];
  /* c8 ignore next 3 -- a scalar subquery pair always returns exactly one row */
  if (row === undefined) {
    return 1;
  }
  if (row.oldest !== null) {
    return Number(row.oldest);
  }
  // Nothing retained: the floor is one past whatever was last handed out.
  return row.next === null ? 1 : Number(row.next) + 1;
}

async function backlogAfter(sql: SqlExecutor, seq: number): Promise<number> {
  const rows = await sql.query<{ waiting: string }>(
    'SELECT count(*)::text AS waiting FROM realtime_events WHERE seq > $1',
    [seq],
  );
  return Number(requireRow(rows.rows, 'counting the backlog returned no row').waiting);
}

async function participantsFor(
  sql: SqlExecutor,
  conversationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (conversationIds.length === 0) {
    return map;
  }
  const rows = await sql.query<{ conversation_id: string; membership_id: string }>(
    `SELECT conversation_id::text, membership_id::text
       FROM conversation_participants
      WHERE conversation_id = ANY($1::uuid[])`,
    [[...new Set(conversationIds)]],
  );
  for (const row of rows.rows) {
    const existing = map.get(row.conversation_id) ?? [];
    existing.push(row.membership_id);
    map.set(row.conversation_id, existing);
  }
  return map;
}

function envelopeOf(row: FeedRow): RealtimeEnvelope {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    entity: { type: row.entity_type, id: row.entity_id, version: row.entity_version },
    scope: {
      conversationId: row.conversation_id,
      inboxId: row.connection_id,
      teamId: row.team_id,
      assigneeMembershipId: row.assignee_membership_id,
    },
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}
