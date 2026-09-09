import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { API_POOL } from '../tokens.js';
import { inboundRowFrom } from './inbound-projection.js';

/**
 * The inbound worker: journaled events become normalized inbound events.
 *
 * This is everything the webhook ACK deliberately does *not* do (DEL-04). It
 * runs after the response, in its own transaction, and it is safe to run twice:
 * the projection is keyed on the source event so a redelivery, a crash halfway,
 * or a deliberate replay all converge on the same rows rather than adding more.
 *
 * Out-of-order arrival needs no special handling here, and that is by design.
 * Each event carries its own `occurred_at` from the provider and its own
 * `observed_at` from us, and nothing folds a status into a message row — so a
 * `read` that arrives before its `delivered` simply lands earlier in the table
 * with an earlier observation time and a later provider time (ADR-0006).
 */

export interface NormalizationResult {
  readonly claimed: number;
  readonly projected: number;
  readonly alreadyProjected: number;
  readonly failed: number;
}

interface QueuedRow {
  readonly event_id: string;
  readonly connection_id: string | null;
  readonly normalized: Record<string, unknown> | null;
}

/** How long a claim is held before another worker may take the row. */
const LEASE_SECONDS = 60;

@Injectable()
export class ChannelNormalizationService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  /**
   * Tenants with queued work.
   *
   * Read from the queue, not from `channel_events`: the events table is behind
   * FORCE RLS and a worker has no tenant context yet, so asking it "is there
   * work anywhere" would correctly return nothing. The queue exists precisely
   * to answer that question without holding any customer content.
   */
  async pendingTenants(limit = 50): Promise<readonly string[]> {
    const rows = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text
         FROM channel_event_queue
        WHERE lease_until IS NULL OR lease_until < now()
        LIMIT $1`,
      [limit],
    );
    return rows.rows.map((row) => row.tenant_id);
  }

  /**
   * Drains up to `limit` queued events for one tenant.
   *
   * `FOR UPDATE SKIP LOCKED` is the claim: two workers running at once take
   * different rows rather than the same row twice, and a worker that dies mid
   * transaction releases its rows on rollback. The lease is the second line —
   * it covers a worker that commits its claim and then dies, which a row lock
   * alone would not.
   */
  async drain(tenantId: string, limit = 100, workerId = 'worker-inbound'): Promise<NormalizationResult> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const queued = await sql.query<QueuedRow>(
        `WITH claimed AS (
           SELECT q.event_id
             FROM channel_event_queue q
            WHERE q.tenant_id = $1
              AND (q.lease_until IS NULL OR q.lease_until < now())
            ORDER BY q.enqueued_at
            LIMIT $2
              FOR UPDATE SKIP LOCKED
         ), leased AS (
           UPDATE channel_event_queue q
              SET leased_by = $3,
                  lease_until = now() + make_interval(secs => $4),
                  attempts = q.attempts + 1
             FROM claimed
            WHERE q.event_id = claimed.event_id
            RETURNING q.event_id
         )
         SELECT leased.event_id::text,
                e.connection_id::text,
                e.normalized
           FROM leased
           -- The join is inside the tenant's RLS context, so an event id that
           -- somehow named another tenant's row simply finds nothing.
           LEFT JOIN channel_events e ON e.id = leased.event_id`,
        [tenantId, limit, workerId, LEASE_SECONDS],
      );

      let projected = 0;
      let alreadyProjected = 0;
      let failed = 0;
      for (const row of queued.rows) {
        if (row.normalized === null || row.connection_id === null) {
          // Queued but unreadable from here. Left in the queue with its attempt
          // counted and an error recorded, rather than deleted: silently
          // dropping work is how an inbox loses a message.
          failed += 1;
          await sql.query(
            `UPDATE channel_event_queue
                SET leased_by = NULL, lease_until = NULL, last_error = 'event_not_visible'
              WHERE event_id = $1`,
            [row.event_id],
          );
          continue;
        }
        const inserted = await projectEvent(sql, tenantId, row.event_id, row.connection_id, row.normalized);
        if (inserted) {
          projected += 1;
        } else {
          alreadyProjected += 1;
        }
        await sql.query(
          `UPDATE channel_events SET status = 'normalized', processed_at = now() WHERE id = $1`,
          [row.event_id],
        );
        // Done means gone. A completed row left in the queue is a row some
        // future worker will try again.
        await sql.query('DELETE FROM channel_event_queue WHERE event_id = $1', [row.event_id]);
      }
      return { claimed: queued.rows.length, projected, alreadyProjected, failed };
    });
  }
}

/**
 * Projects one journaled event into the normalized table.
 *
 * Returns whether a row was added. `ON CONFLICT DO NOTHING` against the
 * source-uniqueness index is what makes a replay idempotent: running this over
 * an event that was already projected changes nothing and reports so, rather
 * than either failing or silently doubling a customer's message.
 */
async function projectEvent(
  sql: SqlExecutor,
  tenantId: string,
  eventId: string,
  connectionId: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  const row = inboundRowFrom(event, new Date());
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO inbound_events
       (tenant_id, connection_id, event_id, kind, provider_message_id, peer_identity,
        asset_identity, content_type, text_body, attachments, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
     ON CONFLICT (tenant_id, event_id, kind, coalesce(provider_message_id, '')) DO NOTHING
     RETURNING id::text`,
    [
      tenantId,
      connectionId,
      eventId,
      row.kind,
      row.providerMessageId,
      row.peerIdentity,
      row.assetIdentity,
      row.contentType,
      row.text,
      row.attachments,
      row.detail,
      row.occurredAt,
    ],
  );
  return inserted.rows.length > 0;
}
