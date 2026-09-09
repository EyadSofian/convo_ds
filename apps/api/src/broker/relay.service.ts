import { Inject, Injectable } from '@nestjs/common';
import { asExecutor } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { requireRow } from '../require-row.js';
import { API_POOL, BROKER } from '../tokens.js';
import type { BrokerPort } from './broker.port.js';

/**
 * The outbox relay: PostgreSQL to the broker, with confirms and dead letters.
 *
 * The whole design follows from one ordering decision (ADR-0004): an envelope is
 * written in the same transaction as the effect that caused it, and published
 * afterwards. Nothing is lost when the broker is down; publishing falls behind
 * and the outbox grows, which is visible.
 *
 * The cost of that ordering is that a publish can happen twice — the broker may
 * confirm and this process may die before recording it. That is accepted rather
 * than papered over: consumers are idempotent (`broker_deliveries`), so a
 * duplicate is absorbed, and a *lost* event would not be.
 *
 * `published_at` is set only on a confirmation. A claim with no confirmation is
 * retried, and after a bounded number of attempts the envelope is quarantined as
 * a dead letter rather than retried forever or dropped — the first stops the
 * queue moving, the second loses the event with no record it existed.
 */

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/** Attempts before an envelope is quarantined. */
export const MAX_PUBLISH_ATTEMPTS = 8;
const LEASE_SECONDS = 60;
const BACKOFF_BASE_SECONDS = 5;

@Injectable()
export class BrokerRelayService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(BROKER) private readonly broker: BrokerPort,
  ) {}

  /**
   * Enqueues an envelope inside the caller's transaction.
   *
   * A separate connection here would let the effect commit and the envelope
   * roll back, which is the exact window the outbox pattern exists to close
   * (DEL-07).
   */
  async enqueue(
    sql: SqlExecutor,
    tenantId: string,
    topic: string,
    envelope: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const rows = await sql.query<{ id: string }>(
      `INSERT INTO broker_outbox (tenant_id, topic, envelope)
       VALUES ($1, $2, $3::jsonb) RETURNING id::text`,
      [tenantId, topic, JSON.stringify(envelope)],
    );
    return requireRow(rows.rows, 'broker outbox insert returned no id').id;
  }

  /**
   * Publishes what is ready.
   *
   * Runs without a tenant context on purpose: the outbox is installation-level
   * and contentless, and a relay that had to know which company to look at
   * before it could find work would need one query per company.
   */
  async drain(limit = 50, workerId = 'relay'): Promise<RelayResult> {
    const sql = asExecutor(this.pool);
    const claimed = await sql.query<{
      id: string;
      tenant_id: string;
      topic: string;
      envelope: Record<string, unknown>;
      attempts: number;
    }>(
      `WITH ready AS (
         SELECT id FROM broker_outbox
          WHERE published_at IS NULL
            AND available_at <= now()
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY available_at
          LIMIT $1
            FOR UPDATE SKIP LOCKED
       )
       UPDATE broker_outbox o
          SET leased_by = $2,
              lease_until = now() + make_interval(secs => $3),
              attempts = o.attempts + 1
         FROM ready
        WHERE o.id = ready.id
        RETURNING o.id::text, o.tenant_id::text, o.topic, o.envelope, o.attempts`,
      [limit, workerId, LEASE_SECONDS],
    );

    const result = { claimed: claimed.rows.length, published: 0, retried: 0, deadLettered: 0 };

    for (const row of claimed.rows) {
      const outcome = await this.broker.publish({
        id: row.id,
        tenantId: row.tenant_id,
        topic: row.topic,
        payload: row.envelope,
      });

      if (outcome.status === 'confirmed') {
        // Marked only after the broker confirmed. Marking on send would lose
        // an envelope the broker never actually accepted.
        await sql.query(
          `UPDATE broker_outbox
              SET published_at = now(), leased_by = NULL, lease_until = NULL, last_error = NULL
            WHERE id = $1`,
          [row.id],
        );
        result.published += 1;
        continue;
      }

      // A refusal is permanent for this envelope; an unknown is not, but both
      // are bounded by the same attempt budget so neither can spin forever.
      const exhausted = outcome.status === 'refused' || row.attempts >= MAX_PUBLISH_ATTEMPTS;
      if (exhausted) {
        await this.quarantine(sql, row, outcome.code);
        result.deadLettered += 1;
        continue;
      }

      await sql.query(
        `UPDATE broker_outbox
            SET leased_by = NULL, lease_until = NULL, last_error = $2,
                available_at = now() + make_interval(secs => $3)
          WHERE id = $1`,
        [row.id, outcome.code, BACKOFF_BASE_SECONDS * 2 ** (row.attempts - 1)],
      );
      result.retried += 1;
    }

    return result;
  }

  /**
   * Records that a consumer handled an envelope, or reports it already had.
   *
   * Called **inside** the consumer's own transaction, so the marker and the
   * effect commit together. `ON CONFLICT DO NOTHING` returning nothing is the
   * redelivery case, and the consumer skips its work rather than doing it twice.
   */
  async claimDelivery(
    sql: SqlExecutor,
    envelopeId: string,
    consumer: string,
    tenantId: string,
  ): Promise<boolean> {
    const inserted = await sql.query<{ envelope_id: string }>(
      `INSERT INTO broker_deliveries (envelope_id, consumer, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (envelope_id, consumer) DO NOTHING
       RETURNING envelope_id::text`,
      [envelopeId, consumer, tenantId],
    );
    if (inserted.rows.length > 0) {
      return true;
    }
    // A redelivery. The attempt is counted — a consumer seeing the same
    // envelope repeatedly is worth being able to see — and the caller is told
    // to skip the work rather than doing it twice.
    await sql.query(
      `UPDATE broker_deliveries SET attempts = attempts + 1
        WHERE envelope_id = $1 AND consumer = $2`,
      [envelopeId, consumer],
    );
    return false;
  }

  /** Open dead letters for one company, newest first. */
  async deadLetters(tenantId: string, limit = 50): Promise<readonly DeadLetterView[]> {
    const rows = await asExecutor(this.pool).query<{
      id: string;
      topic: string;
      reason: string;
      attempts: number;
      quarantined_at: Date;
    }>(
      `SELECT id::text, topic, reason, attempts, quarantined_at
         FROM broker_dead_letters
        WHERE tenant_id = $1 AND replayed_at IS NULL
        ORDER BY quarantined_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      reason: row.reason,
      attempts: row.attempts,
      quarantined_at: row.quarantined_at.toISOString(),
    }));
  }

  /**
   * Puts a dead letter back on the outbox.
   *
   * An operator act, so it is recorded on the dead letter rather than only
   * happening. The envelope is re-enqueued as a **new** outbox row: reusing the
   * old one would lose the evidence that it was ever quarantined.
   */
  async replay(tenantId: string, deadLetterId: string, membershipId: string): Promise<boolean> {
    const sql = asExecutor(this.pool);
    const rows = await sql.query<{ topic: string; envelope: Record<string, unknown> }>(
      `UPDATE broker_dead_letters
          SET replayed_at = now(), replayed_by = $3
        WHERE id = $1 AND tenant_id = $2 AND replayed_at IS NULL
        RETURNING topic, envelope`,
      [deadLetterId, tenantId, membershipId],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      return false;
    }
    await sql.query(
      `INSERT INTO broker_outbox (tenant_id, topic, envelope) VALUES ($1, $2, $3::jsonb)`,
      [tenantId, row.topic, JSON.stringify(row.envelope)],
    );
    return true;
  }

  private async quarantine(
    sql: SqlExecutor,
    row: { id: string; tenant_id: string; topic: string; envelope: Record<string, unknown>; attempts: number },
    reason: string,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO broker_dead_letters (tenant_id, topic, envelope, reason, attempts)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [row.tenant_id, row.topic, JSON.stringify(row.envelope), reason, row.attempts],
    );
    // Removed from the outbox, kept in the dead-letter table: it is out of the
    // way of the queue and still on the record.
    await sql.query('DELETE FROM broker_outbox WHERE id = $1', [row.id]);
  }
}

export interface DeadLetterView {
  readonly id: string;
  readonly topic: string;
  readonly reason: string;
  readonly attempts: number;
  readonly quarantined_at: string;
}
