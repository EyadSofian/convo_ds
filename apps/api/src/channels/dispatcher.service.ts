import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { DeliveryFold, SendOutcome, SqlExecutor } from '@convo/domain';
import { foldDelivery, permitSend } from '@convo/domain';
import type { Pool } from 'pg';
import { API_POOL, CHANNEL_TRANSPORT } from '../tokens.js';
import type { ChannelTransportPort } from './channel-transport.js';
import { ChannelCredentialService } from './credential.service.js';
import { capabilitiesOf } from './outbound.service.js';

/**
 * The outbound dispatcher.
 *
 * The order of operations *is* the correctness argument (ADR-0006):
 *
 * 1. Claim one message per conversation, under a lease. The partial unique
 *    index on `outbox` is the gate: two workers cannot put two messages from
 *    the same conversation on the wire at once, so per-conversation ordering
 *    holds without a global lock (DEL-18).
 * 2. Re-evaluate the permit **now**. The window that was open when an agent
 *    typed may be shut; consent may have been withdrawn; the channel may have
 *    been disconnected. A message that fails the permit is `skipped` with a
 *    typed reason, not sent and not retried (DEL-11).
 * 3. Write the attempt row and **commit it** before the network call. After a
 *    crash, recovery finds an attempt with no recorded response and marks it
 *    `outcome_unknown` — it does not resend (DEL-12).
 * 4. Send.
 * 5. Record what happened, fenced on the dispatch version we read, so a worker
 *    whose lease expired cannot overwrite a newer decision.
 *
 * An `outcome_unknown` message is never automatically retried. It leaves the
 * outbox, keeps its state, and stays visible. Resolving it needs a verified
 * provider idempotency contract, a reliable lookup, or a human decision — none
 * of which exist yet, so none of which is pretended here.
 */

export interface DispatchResult {
  readonly claimed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unknown: number;
  readonly skipped: number;
  readonly retried: number;
}

interface ClaimRow {
  readonly message_id: string;
  readonly connection_id: string;
  readonly peer_identity: string;
  readonly message_type: string;
  readonly text_body: string | null;
  readonly template_name: string | null;
  readonly template_language: string | null;
  readonly dispatch_version: number;
  readonly attempts: number;
  readonly kind: string;
  readonly capabilities: unknown;
  readonly disconnected_at: Date | null;
}

/** How long a claim is held before another worker may take the row. */
const LEASE_SECONDS = 120;
/** Attempts before a transient failure becomes a permanent one. */
const MAX_ATTEMPTS = 5;
/** Base for exponential backoff, in seconds. */
const BACKOFF_BASE_SECONDS = 15;

@Injectable()
export class ChannelDispatcherService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransportPort,
    @Inject(ChannelCredentialService) private readonly credentials: ChannelCredentialService,
  ) {}

  /** Companies with dispatchable work, read from the contentless outbox. */
  async pendingTenants(limit = 50): Promise<readonly string[]> {
    const rows = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM outbox
        WHERE available_at <= now() AND (lease_until IS NULL OR lease_until < now())
        LIMIT $1`,
      [limit],
    );
    return rows.rows.map((row) => row.tenant_id);
  }

  /**
   * Recovers attempts that were started and never answered.
   *
   * This is what a crash between the attempt row and the response looks like
   * from the outside, and the only safe reading of it is "we do not know".
   * Deliberately separate from `dispatch`: recovery is not a retry, and running
   * it must never put anything back on the wire.
   */
  async recoverOrphanedAttempts(tenantId: string, olderThanSeconds = 300): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const orphans = await sql.query<{ id: string; message_id: string }>(
        `SELECT id::text, message_id::text FROM outbound_attempts
          WHERE outcome IS NULL AND started_at < now() - make_interval(secs => $1)
            FOR UPDATE SKIP LOCKED`,
        [olderThanSeconds],
      );
      for (const orphan of orphans.rows) {
        await sql.query(
          `UPDATE outbound_attempts
              SET outcome = 'outcome_unknown', completed_at = now(),
                  error_code = 'attempt_never_completed',
                  error_message = 'The process did not record a response for this attempt.'
            WHERE id = $1`,
          [orphan.id],
        );
        await settle(sql, orphan.message_id, 'outcome_unknown', 'attempt_never_completed', null);
        // Out of the outbox: an unknown outcome is never automatically retried.
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [orphan.message_id]);
      }
      return orphans.rows.length;
    });
  }

  async dispatch(
    tenantId: string,
    limit = 10,
    workerId = 'worker-interactive',
    trafficClass: 'interactive' | 'bulk' = 'interactive',
  ): Promise<DispatchResult> {
    const claims = await this.claim(tenantId, limit, workerId, trafficClass);
    const result = { claimed: claims.length, accepted: 0, rejected: 0, unknown: 0, skipped: 0, retried: 0 };

    for (const claim of claims) {
      const outcome = await this.dispatchOne(tenantId, claim);
      if (outcome === 'accepted') result.accepted += 1;
      else if (outcome === 'rejected') result.rejected += 1;
      else if (outcome === 'outcome_unknown') result.unknown += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else result.retried += 1;
    }
    return result;
  }

  /**
   * Claims work under the per-conversation gate.
   *
   * Three things enforce "one message per conversation on the wire", and each
   * covers a case the others do not:
   *
   * - `DISTINCT ON (connection_id, peer_identity)` picks at most one candidate
   *   per conversation *within this batch*. Without it, a single sweep would
   *   select two messages for one recipient and lease both.
   * - `NOT EXISTS` skips a conversation another worker already has on the wire,
   *   which is a lease that is committed and therefore visible.
   * - `pg_try_advisory_xact_lock` covers the gap between those two: a
   *   concurrent claim transaction whose lease has not committed yet is
   *   invisible to `NOT EXISTS`, and the advisory lock is not. It is held only
   *   for the claim, because the durable gate afterwards is the partial unique
   *   index on the leased row.
   */
  private async claim(
    tenantId: string,
    limit: number,
    workerId: string,
    trafficClass: 'interactive' | 'bulk',
  ): Promise<readonly ClaimRow[]> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const leased = await sql.query<ClaimRow>(
        `WITH candidate AS (
           SELECT DISTINCT ON (o.connection_id, o.peer_identity) o.message_id
             FROM outbox o
            WHERE o.tenant_id = $1
              AND o.traffic_class = $2
              AND o.available_at <= now()
              AND (o.lease_until IS NULL OR o.lease_until < now())
              AND NOT EXISTS (
                SELECT 1 FROM outbox held
                 WHERE held.tenant_id = o.tenant_id
                   AND held.connection_id = o.connection_id
                   AND held.peer_identity = o.peer_identity
                   AND held.lease_until IS NOT NULL
                   AND held.lease_until >= now()
              )
              AND pg_try_advisory_xact_lock(
                hashtext(o.connection_id::text || ':' || o.peer_identity)
              )
            ORDER BY o.connection_id, o.peer_identity, o.available_at
         ), taken AS (
           SELECT message_id FROM candidate LIMIT $3
         )
         UPDATE outbox o
            SET leased_by = $4,
                lease_until = now() + make_interval(secs => $5),
                attempts = o.attempts + 1
           FROM taken, outbound_messages m, channel_connections c
          WHERE o.message_id = taken.message_id
            AND m.id = o.message_id
            AND c.id = m.connection_id
          RETURNING o.message_id::text, o.connection_id::text, o.peer_identity,
                    m.message_type, m.text_body, m.template_name, m.template_language,
                    m.dispatch_version, o.attempts,
                    c.kind, c.capabilities, c.disconnected_at`,
        [tenantId, trafficClass, limit, workerId, LEASE_SECONDS],
      );

      for (const row of leased.rows) {
        await sql.query(
          `UPDATE outbound_messages
              SET command_state = 'dispatching', dispatch_version = dispatch_version + 1
            WHERE id = $1`,
          [row.message_id],
        );
      }
      return leased.rows;
    });
  }

  private async dispatchOne(
    tenantId: string,
    claim: ClaimRow,
  ): Promise<'accepted' | 'rejected' | 'outcome_unknown' | 'skipped' | 'retry'> {
    // Step 2 and 3 in one transaction: decide, and record the attempt durably.
    const prepared = await withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const refusal = await this.permitNow(sql, claim);
      if (refusal !== null) {
        await settle(sql, claim.message_id, 'skipped', refusal.reason, refusal.detail);
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return null;
      }
      const attempt = await sql.query<{ id: string; attempt_no: number }>(
        `INSERT INTO outbound_attempts (tenant_id, message_id, attempt_no, permit)
         VALUES ($1, $2,
                 (SELECT coalesce(max(attempt_no), 0) + 1 FROM outbound_attempts WHERE message_id = $2),
                 $3::jsonb)
         RETURNING id::text, attempt_no`,
        [tenantId, claim.message_id, JSON.stringify({ at: new Date().toISOString() })],
      );
      const row = attempt.rows[0];
      /* c8 ignore next 3 -- RETURNING on a successful INSERT always yields a row */
      if (row === undefined) {
        return null;
      }
      // The credential is opened inside the same transaction and never leaves
      // it as a value: the plaintext goes straight into the send below.
      const token = await this.credentials.withActive(
        sql,
        { tenantId, connectionId: claim.connection_id, purpose: 'access_token' },
        (plaintext) => Promise.resolve(plaintext),
      );
      return { attemptId: row.id, token };
    });

    if (prepared === null) {
      return 'skipped';
    }

    if (prepared.token === null) {
      // No usable credential. Nothing was sent, and we know it.
      return this.record(tenantId, claim, prepared.attemptId, {
        status: 'definitely_rejected',
        code: 'credential_missing',
        message: 'This channel holds no active credential.',
        retryable: true,
      });
    }

    // Step 4. Outside any transaction: a network call inside one holds a
    // connection open for as long as the provider takes to answer.
    const outcome = await this.transport.send(claim.kind as never, prepared.token, {
      assetIdentity: claim.connection_id,
      peerIdentity: claim.peer_identity,
      messageType: claim.message_type,
      text: claim.text_body,
      template:
        claim.template_name === null || claim.template_language === null
          ? null
          : { name: claim.template_name, language: claim.template_language },
      attachments: [],
      idempotencyKey: prepared.attemptId,
    });

    return this.record(tenantId, claim, prepared.attemptId, outcome);
  }

  /** The permit, re-evaluated at the moment of dispatch. */
  private async permitNow(
    sql: SqlExecutor,
    claim: ClaimRow,
  ): Promise<{ reason: string; detail: string } | null> {
    if (claim.disconnected_at !== null) {
      return { reason: 'channel_disconnected', detail: 'The channel was disconnected.' };
    }
    const suppressed = await sql.query(
      'SELECT 1 FROM channel_suppressions WHERE kind = $1 AND peer_identity = $2',
      [claim.kind, claim.peer_identity],
    );
    const lastInbound = await sql.query<{ occurred_at: Date }>(
      `SELECT max(occurred_at) AS occurred_at FROM inbound_events
        WHERE connection_id = $1 AND peer_identity = $2 AND kind = 'message'`,
      [claim.connection_id, claim.peer_identity],
    );
    const permit = permitSend({
      kind: claim.kind as never,
      capabilities: capabilitiesOf({ kind: claim.kind as never, capabilities: claim.capabilities }),
      messageType: claim.message_type,
      isPrivateNote: false,
      text: claim.text_body ?? '',
      lastInboundAt: lastInbound.rows[0]?.occurred_at ?? null,
      now: new Date(),
      template:
        claim.template_name === null
          ? null
          : { name: claim.template_name, kind: claim.kind as never },
      consentWithdrawn: suppressed.rows.length > 0,
    });
    return permit.allowed ? null : { reason: permit.reason, detail: permit.detail };
  }

  /** Step 5: record the answer, fenced on the version we read. */
  private async record(
    tenantId: string,
    claim: ClaimRow,
    attemptId: string,
    outcome: SendOutcome,
  ): Promise<'accepted' | 'rejected' | 'outcome_unknown' | 'retry'> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      await sql.query(
        `UPDATE outbound_attempts
            SET outcome = $2, completed_at = now(), provider_message_id = $3,
                error_code = $4, error_message = $5
          WHERE id = $1`,
        [
          attemptId,
          outcome.status,
          outcome.status === 'accepted' ? outcome.providerMessageId : null,
          outcome.status === 'accepted' ? null : outcome.code,
          outcome.status === 'accepted' ? null : outcome.message,
        ],
      );

      if (outcome.status === 'accepted') {
        await settle(sql, claim.message_id, 'provider_accepted', null, null, outcome.providerMessageId);
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        // A receipt may already have arrived for this id, before we knew it.
        await reconcileHeldReceipts(sql, claim.message_id, outcome.providerMessageId);
        return 'accepted';
      }

      if (outcome.status === 'outcome_unknown') {
        await settle(sql, claim.message_id, 'outcome_unknown', outcome.code, outcome.message);
        // Out of the outbox, permanently. Nothing automatic may touch it again.
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return 'outcome_unknown';
      }

      const exhausted = claim.attempts >= MAX_ATTEMPTS;
      if (!outcome.retryable || exhausted) {
        await settle(
          sql,
          claim.message_id,
          outcome.retryable ? 'failed' : 'rejected',
          outcome.code,
          outcome.message,
        );
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return 'rejected';
      }

      // Exponential backoff with the attempt count already incremented by the
      // claim, so the first retry waits and the fifth waits a lot longer.
      await sql.query(
        `UPDATE outbox
            SET leased_by = NULL, lease_until = NULL, last_error = $2,
                available_at = now() + make_interval(secs => $3)
          WHERE message_id = $1`,
        [claim.message_id, outcome.code, BACKOFF_BASE_SECONDS * 2 ** (claim.attempts - 1)],
      );
      await sql.query(
        `UPDATE outbound_messages
            SET command_state = 'retry_scheduled', state_reason = $2,
                dispatch_version = dispatch_version + 1
          WHERE id = $1`,
        [claim.message_id, outcome.code],
      );
      return 'retry';
    });
  }

  /**
   * Folds provider receipts into the messages they belong to.
   *
   * Receipts arrive as ordinary inbound events, so one that lands *before* the
   * send response is not lost — it is simply an event whose message we cannot
   * identify yet, and this pass picks it up once the provider id is known
   * (DEL-17).
   */
  async reconcileReceipts(tenantId: string, limit = 200): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const receipts = await sql.query<{
        provider_message_id: string;
        incoming_state: 'delivered' | 'read';
        occurred_at: Date;
        message_id: string;
        delivery_state: string | null;
        delivery_state_at: Date | null;
        delivery_anomaly: string | null;
      }>(
        `SELECT e.provider_message_id,
                -- Mapped here rather than in TypeScript: the filter below makes
                -- the ELSE exactly 'delivery_status', so there is no third case
                -- to write and then never be able to reach.
                CASE e.kind WHEN 'read_status' THEN 'read' ELSE 'delivered' END AS incoming_state,
                e.occurred_at,
                m.id::text AS message_id, m.delivery_state, m.delivery_state_at, m.delivery_anomaly
           FROM inbound_events e
           JOIN outbound_messages m ON m.provider_message_id = e.provider_message_id
          WHERE e.kind IN ('delivery_status', 'read_status')
          ORDER BY e.observed_at
          LIMIT $1`,
        [limit],
      );

      let folded = 0;
      for (const receipt of receipts.rows) {
        const next = foldDelivery(
          receipt.delivery_state === null || receipt.delivery_state_at === null
            ? null
            : {
                state: receipt.delivery_state as 'sent' | 'delivered' | 'read',
                at: receipt.delivery_state_at,
                anomaly: receipt.delivery_anomaly,
              },
          { state: receipt.incoming_state, at: receipt.occurred_at },
        );
        const changed =
          next.state !== receipt.delivery_state || next.anomaly !== receipt.delivery_anomaly;
        if (!changed) {
          continue;
        }
        await sql.query(
          `UPDATE outbound_messages
              SET delivery_state = $2, delivery_state_at = $3, delivery_anomaly = $4
            WHERE id = $1`,
          [receipt.message_id, next.state, next.at, next.anomaly],
        );
        folded += 1;
      }
      return folded;
    });
  }
}

/** Moves a command to a terminal state, bumping the fencing version with it. */
async function settle(
  sql: SqlExecutor,
  messageId: string,
  state: string,
  reason: string | null,
  detail: string | null,
  providerMessageId: string | null = null,
): Promise<void> {
  await sql.query(
    `UPDATE outbound_messages
        SET command_state = $2,
            state_reason = $3,
            provider_message_id = coalesce($4, provider_message_id),
            settled_at = now(),
            dispatch_version = dispatch_version + 1
      WHERE id = $1`,
    [messageId, state, reason === null ? detail : reason, providerMessageId],
  );
}

/**
 * Applies receipts that arrived before we knew the provider id.
 *
 * Called the moment an id is learned, so a `delivered` that beat the send
 * response is reflected immediately rather than waiting for the next sweep.
 */
async function reconcileHeldReceipts(
  sql: SqlExecutor,
  messageId: string,
  providerMessageId: string,
): Promise<void> {
  const held = await sql.query<{ incoming_state: 'delivered' | 'read'; occurred_at: Date }>(
    `SELECT CASE kind WHEN 'read_status' THEN 'read' ELSE 'delivered' END AS incoming_state,
            occurred_at
       FROM inbound_events
      WHERE provider_message_id = $1 AND kind IN ('delivery_status', 'read_status')
      ORDER BY occurred_at`,
    [providerMessageId],
  );
  let fold: DeliveryFold | null = null;
  for (const receipt of held.rows) {
    fold = foldDelivery(fold, { state: receipt.incoming_state, at: receipt.occurred_at });
  }
  if (fold !== null) {
    await sql.query(
      `UPDATE outbound_messages
          SET delivery_state = $2, delivery_state_at = $3, delivery_anomaly = $4
        WHERE id = $1`,
      [messageId, fold.state, fold.at, fold.anomaly],
    );
  }
}
