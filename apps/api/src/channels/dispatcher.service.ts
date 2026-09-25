import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { DeliveryFold, Offer, SendOutcome, SqlExecutor, WhatsAppTemplateSendComponent } from '@convo/domain';
import { foldDelivery, permitSend } from '@convo/domain';
import type { Pool } from 'pg';
import { API_POOL, CHANNEL_TRANSPORT } from '../tokens.js';
import {
  campaignDispatchRefusal,
  campaignOutcomeProjection,
  type CampaignPermitState,
} from '../campaigns/campaign-dispatch.js';
import { ConversationService } from '../conversations/conversation.service.js';
import type { ChannelTransportPort } from './channel-transport.js';
import { ChannelCredentialService } from './credential.service.js';
import { capabilitiesOf } from './outbound.service.js';
import { latestConversationInbound } from '../conversations/event-boundary.js';

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
  /** Results that lost the fence: recorded as evidence, applied to nothing. */
  readonly stale: number;
}

interface ClaimRow {
  readonly message_id: string;
  readonly connection_id: string;
  /** Provider-side asset ID (Page ID, Instagram account ID, or phone-number ID). */
  readonly external_asset_id: string;
  readonly peer_identity: string;
  readonly conversation_id: string | null;
  readonly message_type: string;
  readonly text_body: string | null;
  readonly template_name: string | null;
  readonly template_language: string | null;
  readonly template_components: readonly WhatsAppTemplateSendComponent[];
  readonly dispatch_version: number;
  readonly attempts: number;
  readonly kind: string;
  readonly capabilities: unknown;
  readonly connection_status: string;
  readonly disconnected_at: Date | null;
  readonly campaign_recipient_id: string | null;
  readonly campaign_test_send_id: string | null;
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
    @Inject(ConversationService) private readonly conversations: ConversationService,
  ) {}

  /**
   * What each company is offering in one traffic class, right now.
   *
   * Read from the contentless outbox, so it needs no tenant context and holds
   * no customer content. This is the input the fair scheduler plans a round
   * from: without the *counts* it could only round-robin over companies, and a
   * company with one message would be given the same slice as one with ten
   * thousand — which is a different unfairness, not fairness.
   */
  async offers(
    trafficClass: 'interactive' | 'bulk',
    limit = 200,
  ): Promise<readonly Offer[]> {
    const rows = await asExecutor(this.pool).query<{ tenant_id: string; ready: string }>(
      `SELECT tenant_id::text, count(*)::text AS ready
         FROM outbox
        WHERE traffic_class = $1
          AND available_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        GROUP BY tenant_id
        ORDER BY tenant_id
        LIMIT $2`,
      [trafficClass, limit],
    );
    return rows.rows.map((row) => ({
      tenantId: row.tenant_id,
      trafficClass,
      ready: Number(row.ready),
    }));
  }

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
  async recoverOrphanedAttempts(
    tenantId: string,
    olderThanSeconds = 300,
    limit = 100,
  ): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const orphans = await sql.query<{ id: string; message_id: string; campaign_recipient_id: string | null }>(
        `SELECT a.id::text,a.message_id::text,cr.id::text AS campaign_recipient_id
          FROM outbound_attempts a LEFT JOIN campaign_recipients cr ON cr.command_id=a.message_id
          WHERE a.outcome IS NULL AND a.started_at < now() - make_interval(secs => $1)
          ORDER BY a.started_at, a.id
          LIMIT $2
            FOR UPDATE OF a SKIP LOCKED`,
        [olderThanSeconds, limit],
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
        await projectCampaignOutcome(sql, orphan.campaign_recipient_id, 'outcome_unknown');
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
    const result = {
      claimed: claims.length,
      accepted: 0,
      rejected: 0,
      unknown: 0,
      skipped: 0,
      retried: 0,
      stale: 0,
    };

    for (const claim of claims) {
      const outcome = await this.dispatchOne(tenantId, claim);
      if (outcome === 'accepted') result.accepted += 1;
      else if (outcome === 'rejected') result.rejected += 1;
      else if (outcome === 'outcome_unknown') result.unknown += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else if (outcome === 'stale') result.stale += 1;
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
             FROM outbox o JOIN outbound_messages candidate_message ON candidate_message.id=o.message_id
             LEFT JOIN campaign_recipients candidate_recipient ON candidate_recipient.command_id=candidate_message.id
             LEFT JOIN campaign_executions candidate_execution ON candidate_execution.id=candidate_recipient.execution_id
            WHERE o.tenant_id = $1
              AND o.traffic_class = $2
              AND o.available_at <= now()
              AND (o.lease_until IS NULL OR o.lease_until < now())
              AND (candidate_recipient.id IS NULL OR (
                candidate_recipient.state='queued' AND candidate_execution.state='running'
                AND candidate_message.campaign_stop_version=candidate_execution.stop_version
              ))
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
           FROM taken, outbound_messages m
             LEFT JOIN campaign_recipients cr ON cr.command_id=m.id
             LEFT JOIN campaign_test_sends cts ON cts.message_id=m.id,
                channel_connections c
          WHERE o.message_id = taken.message_id
            AND m.id = o.message_id
            AND c.id = m.connection_id
          RETURNING o.message_id::text, o.connection_id::text, c.external_asset_id, o.peer_identity,
                    m.conversation_id::text AS conversation_id,
                    m.message_type, m.text_body, m.template_name, m.template_language, m.template_components,
                    m.dispatch_version, o.attempts,
                    c.kind, c.capabilities, c.status AS connection_status,c.disconnected_at,
                    cr.id::text AS campaign_recipient_id,cts.id::text AS campaign_test_send_id`,
        [tenantId, trafficClass, limit, workerId, LEASE_SECONDS],
      );

      for (const row of leased.rows) {
        await sql.query(
          `UPDATE outbound_messages
              SET command_state = 'dispatching', dispatch_version = dispatch_version + 1
            WHERE id = $1`,
          [row.message_id],
        );
        if (row.campaign_recipient_id !== null) {
          await sql.query(`UPDATE campaign_recipients SET state='in_flight',updated_at=now() WHERE id=$1 AND state='queued'`, [row.campaign_recipient_id]);
        }
      }
      // The version each row carries is the one *before* that increment, so the
      // version this worker owns — and must present when it writes a result —
      // is one higher.
      return leased.rows.map((row) => ({ ...row, dispatch_version: row.dispatch_version + 1 }));
    });
  }

  private async dispatchOne(
    tenantId: string,
    claim: ClaimRow,
  ): Promise<'accepted' | 'rejected' | 'outcome_unknown' | 'skipped' | 'retry' | 'stale'> {
    // Step 2 and 3 in one transaction: decide, and record the attempt durably.
    const prepared = await withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      const refusal = await this.permitNow(sql, claim);
      if (refusal !== null) {
        await settle(sql, claim.message_id, 'skipped', refusal.reason, refusal.detail);
        await settleCampaignRecipient(sql, claim.campaign_recipient_id, 'skipped', refusal.reason);
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return null;
      }
      await recordCampaignPermit(sql, claim.campaign_recipient_id);
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
      return this.recordAndProject(tenantId, claim, prepared.attemptId, {
        status: 'definitely_rejected',
        code: 'credential_missing',
        message: 'This channel holds no active credential.',
        retryable: true,
      });
    }

    // Step 4. Outside any transaction: a network call inside one holds a
    // connection open for as long as the provider takes to answer.
    const outcome = await this.transport.send(claim.kind as never, prepared.token, {
      // The transport needs Meta's asset identifier, not our tenant-scoped
      // connection UUID. The latter is only used to open the stored credential.
      assetIdentity: claim.external_asset_id,
      peerIdentity: claim.peer_identity,
      messageType: claim.message_type,
      text: claim.text_body,
      template:
        claim.template_name === null || claim.template_language === null
          ? null
          : { name: claim.template_name, language: claim.template_language, components: claim.template_components },
      attachments: [],
      idempotencyKey: prepared.attemptId,
    });

    return this.recordAndProject(tenantId, claim, prepared.attemptId, outcome);
  }

  /** The permit, re-evaluated at the moment of dispatch. */
  private async permitNow(
    sql: SqlExecutor,
    claim: ClaimRow,
  ): Promise<{ reason: string; detail: string } | null> {
    const campaignRefusal = await campaignPermitNow(sql, claim);
    if (campaignRefusal !== null) return campaignRefusal;
    const testRefusal = await campaignTestRefusal(sql, claim);
    if (testRefusal !== null) return testRefusal;
    if (claim.disconnected_at !== null) {
      return { reason: 'channel_disconnected', detail: 'The channel was disconnected.' };
    }
    if ((claim.campaign_recipient_id !== null || claim.campaign_test_send_id !== null) && claim.connection_status !== 'healthy') {
      return { reason: 'channel_not_ready', detail: 'The campaign channel is not healthy.' };
    }
    const suppressed = await sql.query(
      'SELECT 1 FROM channel_suppressions WHERE kind = $1 AND peer_identity = $2',
      [claim.kind, claim.peer_identity],
    );
    const lastInboundAt = claim.conversation_id === null
      ? (await sql.query<{ occurred_at: Date | null }>(
          `SELECT max(occurred_at) AS occurred_at FROM inbound_events
            WHERE connection_id = $1 AND peer_identity = $2 AND kind = 'message'`,
          [claim.connection_id, claim.peer_identity],
        )).rows[0]?.occurred_at ?? null
      : (await latestConversationInbound(sql, claim.conversation_id)).lastInboundAt;
    const permit = permitSend({
      kind: claim.kind as never,
      capabilities: capabilitiesOf({ kind: claim.kind as never, capabilities: claim.capabilities }),
      messageType: claim.message_type,
      isPrivateNote: false,
      text: claim.text_body ?? '',
      lastInboundAt,
      now: new Date(),
      template:
        claim.template_name === null
          ? null
          : { name: claim.template_name, kind: claim.kind as never },
      consentWithdrawn: suppressed.rows.length > 0,
    });
    return permit.allowed ? null : { reason: permit.reason, detail: permit.detail };
  }

  private async recordAndProject(
    tenantId: string,
    claim: ClaimRow,
    attemptId: string,
    outcome: SendOutcome,
  ): Promise<'accepted' | 'rejected' | 'outcome_unknown' | 'retry' | 'stale'> {
    const result = await this.record(tenantId, claim, attemptId, outcome);
    if (result !== 'stale') {
      await withTenant(this.pool, tenantId, async (client) => {
        await projectCampaignOutcome(asExecutor(client), claim.campaign_recipient_id, result);
      });
    }
    return result;
  }

  /**
   * Step 5: record the answer, fenced on the version this worker owns.
   *
   * The attempt row is written **first and unconditionally**. A stale worker's
   * provider response is still evidence about what a customer may have
   * received, and discarding it because the message moved on would throw away
   * the only record that a request went out. What the fence protects is the
   * *command state*: a stale write must not roll it back to something a newer
   * worker has already moved past.
   */
  private async record(
    tenantId: string,
    claim: ClaimRow,
    attemptId: string,
    outcome: SendOutcome,
  ): Promise<'accepted' | 'rejected' | 'outcome_unknown' | 'retry' | 'stale'> {
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

      const fence = claim.dispatch_version;

      if (outcome.status === 'accepted') {
        const applied = await settle(
          sql,
          claim.message_id,
          'provider_accepted',
          null,
          null,
          outcome.providerMessageId,
          fence,
        );
        if (!applied) {
          return this.rejectStale(sql, attemptId);
        }
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        // A receipt may already have arrived for this id, before we knew it.
        await reconcileHeldReceipts(sql, claim.message_id, outcome.providerMessageId);
        return 'accepted';
      }

      if (outcome.status === 'outcome_unknown') {
        const applied = await settle(
          sql,
          claim.message_id,
          'outcome_unknown',
          outcome.code,
          outcome.message,
          null,
          fence,
        );
        if (!applied) {
          return this.rejectStale(sql, attemptId);
        }
        // Out of the outbox, permanently. Nothing automatic may touch it again.
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return 'outcome_unknown';
      }

      const exhausted = claim.attempts >= MAX_ATTEMPTS;
      if (!outcome.retryable || exhausted) {
        const applied = await settle(
          sql,
          claim.message_id,
          outcome.retryable ? 'failed' : 'rejected',
          outcome.code,
          outcome.message,
          null,
          fence,
        );
        if (!applied) {
          return this.rejectStale(sql, attemptId);
        }
        await sql.query('DELETE FROM outbox WHERE message_id = $1', [claim.message_id]);
        return 'rejected';
      }

      const rescheduled = await sql.query(
        `UPDATE outbound_messages
            SET command_state = 'retry_scheduled', state_reason = $2,
                dispatch_version = dispatch_version + 1
          WHERE id = $1 AND dispatch_version = $3`,
        [claim.message_id, outcome.code, fence],
      );
      if (rescheduled.rowCount !== 1) {
        return this.rejectStale(sql, attemptId);
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
      return 'retry';
    });
  }

  /**
   * A result that lost the fence.
   *
   * The attempt keeps its outcome — that is the provider evidence, and it is
   * exactly what somebody investigating a duplicate message needs. What it
   * gains is a typed marker saying the command had already moved on, so the
   * evidence is never mistaken for the current state.
   */
  private async rejectStale(sql: SqlExecutor, attemptId: string): Promise<'stale'> {
    await sql.query(
      `UPDATE outbound_attempts
          SET error_code = coalesce(error_code, 'stale_dispatch'),
              error_message = coalesce(error_message, '') ||
                ' [recorded after a newer worker took this message over]'
        WHERE id = $1`,
      [attemptId],
    );
    // The outbox is deliberately untouched: whatever owns the message now owns
    // its scheduling too.
    return 'stale';
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
        connection_id: string;
        peer_identity: string;
        observed_at: Date;
      }>(
        `SELECT e.provider_message_id,
                -- Mapped here rather than in TypeScript: the filter below makes
                -- the ELSE exactly 'delivery_status', so there is no third case
                -- to write and then never be able to reach.
                CASE e.kind WHEN 'read_status' THEN 'read' ELSE 'delivered' END AS incoming_state,
                e.occurred_at, e.observed_at,
                m.id::text AS message_id, m.delivery_state, m.delivery_state_at, m.delivery_anomaly,
                m.connection_id::text, m.peer_identity
           FROM inbound_events e
           JOIN outbound_messages m ON m.provider_message_id = e.provider_message_id
          WHERE e.kind IN ('delivery_status', 'read_status')
            -- Each receipt is folded once. Re-folding one that has already
            -- been applied is how a correctly-ordered pair turns into a
            -- fabricated delivered_after_read on the second sweep (0015).
            AND e.observed_at > coalesce(m.receipts_folded_through, '-infinity'::timestamptz)
          ORDER BY e.observed_at
          LIMIT $1`,
        [limit],
      );

      let folded = 0;
      // Highest observation folded per message, so a message with two new
      // receipts in one sweep advances past both rather than only the first.
      const watermark = new Map<string, Date>();
      for (const receipt of receipts.rows) {
        const seen = watermark.get(receipt.message_id);
        if (seen === undefined || receipt.observed_at > seen) {
          watermark.set(receipt.message_id, receipt.observed_at);
        }
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
        await sql.query(
          `UPDATE campaign_recipients SET state=$2,updated_at=now()
            WHERE command_id=$1 AND state IN ('accepted','delivered')`,
          [receipt.message_id, next.state],
        );
        // The screen showing this conversation learns the tick moved, in the
        // same transaction that moved it.
        const conversation = await this.conversations.ensure(
          sql,
          tenantId,
          receipt.connection_id,
          receipt.peer_identity,
        );
        await this.conversations.noteDelivery(sql, tenantId, conversation, {
          messageId: receipt.message_id,
          state: next.state,
          at: next.at,
          anomaly: next.anomaly,
        });
        folded += 1;
      }
      for (const [messageId, observedAt] of watermark) {
        // Advanced even for a receipt that changed nothing: it has still been
        // considered, and considering it again can only produce the false
        // anomaly this watermark exists to prevent.
        await sql.query(
          `UPDATE outbound_messages
              SET receipts_folded_through = greatest(coalesce(receipts_folded_through, $2), $2)
            WHERE id = $1`,
          [messageId, observedAt],
        );
      }
      return folded;
    });
  }
}

async function campaignTestRefusal(
  sql: SqlExecutor,
  claim: Pick<ClaimRow, 'campaign_test_send_id'>,
): Promise<{ reason: string; detail: string } | null> {
  if (claim.campaign_test_send_id === null) return null;
  const row = await sql.query<{
    revision_current: boolean;
    revoked_at: Date | null;
    identity_valid_to: Date | null;
    contact_deleted_at: Date | null;
  }>(
    `SELECT c.current_revision_id=s.revision_id AS revision_current,tr.revoked_at,
            i.valid_to AS identity_valid_to,contact.deleted_at AS contact_deleted_at
       FROM campaign_test_sends s JOIN campaigns c ON c.id=s.campaign_id
       JOIN channel_test_recipients tr ON tr.id=s.authorization_id
       JOIN contact_identities i ON i.id=tr.identity_id
       JOIN contacts contact ON contact.id=i.contact_id
      WHERE s.id=$1`,
    [claim.campaign_test_send_id],
  );
  const current = row.rows[0];
  if (current === undefined || current.revoked_at !== null || current.identity_valid_to !== null || current.contact_deleted_at !== null) {
    return { reason: 'test_recipient_authorization_revoked', detail: 'The authorized test recipient is no longer active.' };
  }
  if (!current.revision_current) {
    return { reason: 'campaign_test_revision_stale', detail: 'The campaign changed before the test reached dispatch.' };
  }
  return null;
}

async function campaignPermitNow(
  sql: SqlExecutor,
  claim: ClaimRow,
): Promise<{ reason: string; detail: string } | null> {
  if (claim.campaign_recipient_id === null) return null;
  const result = await sql.query<CampaignPermitState>(
    `SELECT cr.state AS recipient_state,e.state AS execution_state,e.stop_version::text AS execution_stop_version,
            m.campaign_stop_version::text,c.control_state AS campaign_state,r.expires_at,
            EXISTS(SELECT 1 FROM campaign_approvals a WHERE a.revision_id=e.revision_id
              AND a.revision_hash=r.revision_hash AND a.revoked_at IS NULL) AS approved,
            (SELECT x.state FROM consents x WHERE x.contact_id=cr.contact_id
              AND x.channel=$2 AND x.purpose='marketing'
              ORDER BY x.recorded_at DESC,x.id DESC LIMIT 1) AS consent_state
       FROM campaign_recipients cr JOIN campaign_executions e ON e.id=cr.execution_id
       JOIN campaigns c ON c.id=e.campaign_id JOIN campaign_revisions r ON r.id=e.revision_id
       JOIN outbound_messages m ON m.id=cr.command_id WHERE cr.id=$1`,
    [claim.campaign_recipient_id, claim.kind],
  );
  return campaignDispatchRefusal(result.rows[0], Date.now());
}

async function recordCampaignPermit(sql: SqlExecutor, recipientId: string | null): Promise<void> {
  if (recipientId === null) return;
  await sql.query(
    `UPDATE campaign_recipients SET dispatch_eligibility=$2::jsonb,updated_at=now() WHERE id=$1`,
    [recipientId, JSON.stringify({ allowed: true, checked_at: new Date().toISOString() })],
  );
}

async function settleCampaignRecipient(
  sql: SqlExecutor,
  recipientId: string | null,
  state: 'skipped',
  reason: string,
): Promise<void> {
  if (recipientId === null) return;
  await sql.query(
    `UPDATE campaign_recipients SET state=$2,dispatch_eligibility=$3::jsonb,last_error=$4::jsonb,updated_at=now() WHERE id=$1`,
    [recipientId, state, JSON.stringify({ allowed: false, reason, checked_at: new Date().toISOString() }), JSON.stringify({ code: reason })],
  );
  await sql.query(
    `UPDATE budget_reservations SET state='released',reserved_amount_minor=0,released_at=now()
      WHERE recipient_id=$1 AND state='reserved'`,
    [recipientId],
  );
  await finishCampaignIfDrained(sql, recipientId);
}

async function projectCampaignOutcome(
  sql: SqlExecutor,
  recipientId: string | null,
  outcome: 'accepted' | 'rejected' | 'outcome_unknown' | 'retry',
): Promise<void> {
  if (recipientId === null) return;
  const projection = campaignOutcomeProjection(outcome);
  await sql.query(`UPDATE campaign_recipients SET state=$2,updated_at=now() WHERE id=$1`, [recipientId, projection.recipientState]);
  if (projection.budgetState === 'committed') {
    await sql.query(
      `UPDATE budget_reservations SET state='committed',committed_amount_minor=reserved_amount_minor
        WHERE recipient_id=$1 AND state='reserved'`, [recipientId],
    );
  } else if (projection.budgetState === 'released') {
    await sql.query(
      `UPDATE budget_reservations SET state='released',reserved_amount_minor=0,released_at=now()
        WHERE recipient_id=$1 AND state='reserved'`, [recipientId],
    );
  } else if (projection.budgetState === 'held_unknown') {
    await sql.query(
      `UPDATE budget_reservations SET state='held_unknown' WHERE recipient_id=$1 AND state='reserved'`,
      [recipientId],
    );
  }
  if (projection.finishesAttempt) await finishCampaignIfDrained(sql, recipientId);
}

async function finishCampaignIfDrained(sql: SqlExecutor, recipientId: string): Promise<void> {
  const execution = await sql.query<{ execution_id: string }>(
    `SELECT execution_id::text FROM campaign_recipients WHERE id=$1`, [recipientId],
  );
  const executionId = execution.rows[0]!.execution_id;
  const open = await sql.query(
    `SELECT 1 FROM campaign_recipients WHERE execution_id=$1 AND state IN ('planned','queued','in_flight') LIMIT 1`,
    [executionId],
  );
  if (open.rowCount !== 0) return;
  await sql.query(
    `UPDATE campaign_executions SET state='dispatch_completed',completed_at=now()
      WHERE id=$1 AND state='running'`, [executionId],
  );
  await sql.query(
    `UPDATE campaigns SET control_state='dispatch_completed',version=version+1,updated_at=now()
      WHERE id=(SELECT campaign_id FROM campaign_executions WHERE id=$1) AND control_state='running'`,
    [executionId],
  );
}

/**
 * Moves a command to a terminal state, bumping the fencing version with it.
 *
 * `expectedVersion` is the fence. A worker whose lease expired can still be
 * holding a provider response when a newer worker has already taken the message
 * over; writing that response would roll the command back to a state the newer
 * worker has moved past. Comparing the version the worker owns makes that
 * impossible: the `UPDATE` matches nothing, and the caller is told so rather
 * than believing it succeeded.
 *
 * Pass `null` for a transition no worker owns — recovery of an orphaned
 * attempt, which is by definition not racing anybody.
 */
async function settle(
  sql: SqlExecutor,
  messageId: string,
  state: string,
  reason: string | null,
  detail: string | null,
  providerMessageId: string | null = null,
  expectedVersion: number | null = null,
): Promise<boolean> {
  const result = await sql.query(
    `UPDATE outbound_messages
        SET command_state = $2,
            state_reason = $3,
            provider_message_id = coalesce($4, provider_message_id),
            settled_at = now(),
            dispatch_version = dispatch_version + 1
      WHERE id = $1
        AND ($5::integer IS NULL OR dispatch_version = $5)`,
    [messageId, state, reason === null ? detail : reason, providerMessageId, expectedVersion],
  );
  return result.rowCount === 1;
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
