import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { requireRow } from '../require-row.js';
import { API_POOL, CHANNEL_TRANSPORT } from '../tokens.js';
import type { ChannelTransportPort } from './channel-transport.js';
import { ChannelCredentialService } from './credential.service.js';
import { ContactService } from '../contacts/contact.service.js';
import { normalizeSearchText } from '@convo/domain';
import { ConversationService } from '../conversations/conversation.service.js';
import { inboundRowFrom } from './inbound-projection.js';
import type { InboundRow } from './inbound-projection.js';

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
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(ContactService) private readonly contacts: ContactService,
    @Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransportPort,
    @Inject(ChannelCredentialService) private readonly credentials: ChannelCredentialService,
  ) {}

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

  async pendingProfileTenants(limit = 50): Promise<readonly string[]> {
    const rows = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM contact_profile_queue
        WHERE attempts < 5 AND next_attempt_at <= now()
          AND (lease_until IS NULL OR lease_until < now()) LIMIT $1`, [limit],
    );
    return rows.rows.map((row) => row.tenant_id);
  }

  /** Profile failures retry independently; they never roll back inbound mail. */
  async drainProfiles(tenantId: string, limit = 10): Promise<number> {
    if (this.transport.fetchPeerProfile === undefined) return 0;
    const rows = await withTenant(this.pool, tenantId, async (client) => asExecutor(client).query<{
      contact_id: string; connection_id: string; peer_identity: string; kind: 'messenger' | 'instagram';
    }>(
      `WITH claimed AS (
         SELECT q.tenant_id, q.contact_id, q.connection_id
           FROM contact_profile_queue q
          WHERE q.tenant_id=$1 AND q.attempts<5 AND q.next_attempt_at<=now()
            AND (q.lease_until IS NULL OR q.lease_until<now())
          ORDER BY q.next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED
       ), leased AS (
         UPDATE contact_profile_queue q SET lease_until=now()+interval '45 seconds'
           FROM claimed x WHERE q.tenant_id=x.tenant_id AND q.contact_id=x.contact_id
             AND q.connection_id=x.connection_id
         RETURNING q.contact_id, q.connection_id
       )
       SELECT l.contact_id::text, l.connection_id::text, i.external_id AS peer_identity, c.kind
         FROM leased l
         JOIN channel_connections c ON c.id=l.connection_id
         JOIN contact_identities i ON i.contact_id=l.contact_id AND i.scope_id=l.connection_id
           AND i.valid_to IS NULL`, [tenantId, limit],
    ));
    let enriched = 0;
    for (const row of rows.rows) {
      // The credential exists only inside the callback and is never logged or
      // returned by the API. A bounded provider timeout protects this worker.
      let name: string | null = null;
      try {
        name = await withTenant(this.pool, tenantId, async (client) =>
          this.credentials.withActive(asExecutor(client),
            { tenantId, connectionId: row.connection_id, purpose: 'access_token' },
            (token) => this.transport.fetchPeerProfile!(row.kind, token, row.peer_identity)));
      } catch {
        // A missing/rotating key or provider failure is retryable profile work,
        // never a reason to stop normalizing customer messages.
      }
      await withTenant(this.pool, tenantId, async (client) => {
        const sql = asExecutor(client);
        if (name !== null) {
          // Never overwrite a name an operator corrected manually.
          const changed = await sql.query(
            `UPDATE contacts SET display_name=$3, search_name=$4, updated_at=now()
              WHERE id=$1 AND display_name=$2 AND deleted_at IS NULL`,
            [row.contact_id, row.peer_identity, name, normalizeSearchText(name)],
          );
          if (Number(changed.rowCount) > 0) enriched += 1;
          await sql.query('DELETE FROM contact_profile_queue WHERE tenant_id=$1 AND contact_id=$2 AND connection_id=$3',
            [tenantId, row.contact_id, row.connection_id]);
        } else {
          await sql.query(
            `UPDATE contact_profile_queue SET attempts=attempts+1, lease_until=NULL,
                next_attempt_at=now() + make_interval(secs => least(86400, 60 * power(2, attempts))::int),
                last_error_code='profile_unavailable'
              WHERE tenant_id=$1 AND contact_id=$2 AND connection_id=$3`,
            [tenantId, row.contact_id, row.connection_id],
          );
        }
      });
    }
    return enriched;
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
        if (inserted === null) {
          alreadyProjected += 1;
        } else {
          projected += 1;
          // The inbox side of the same transaction: a conversation exists, it
          // knows a customer is waiting, and the feed says so. All three commit
          // with the normalized event or none of them do (DEL-07).
          await this.record(sql, tenantId, row.connection_id, inserted.id, inserted.row);
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

  /**
   * Turns one normalized event into inbox state.
   *
   * Only a customer *message* touches the conversation. A delivery receipt is
   * about an outbound message and is folded on the outbound side; an
   * unsupported or quarantined element is a fact about a payload, not about a
   * customer, and must not make a conversation appear in the queue.
   */
  private async record(
    sql: SqlExecutor,
    tenantId: string,
    connectionId: string,
    inboundEventId: string,
    inbound: InboundRow,
  ): Promise<void> {
    if (inbound.kind !== 'message') {
      return;
    }
    const conversation = await this.conversations.ensure(
      sql,
      tenantId,
      connectionId,
      inbound.peerIdentity,
    );
    // Bind at normalization time, after ensure selected or created the active
    // thread. Both writes share the worker transaction, including the first
    // inbound that opened a new conversation.
    await sql.query(
      `UPDATE inbound_events SET conversation_id=$2
        WHERE id=$1 AND tenant_id=$3 AND conversation_id IS NULL`,
      [inboundEventId, conversation.id, tenantId],
    );
    // The customer's identity, resolved in this same transaction. It is scoped
    // to the connection the message arrived on: the same person writing to two
    // pages is two identities until somebody says otherwise (CT-02, CT-03).
    const kind = await connectionKind(sql, connectionId);
    const contact = await this.contacts.resolve(
      sql,
      tenantId,
      { kind, scopeId: connectionId, externalId: inbound.peerIdentity },
      { source: 'inbound_message', providerMessageId: inbound.providerMessageId },
    );
    // A name the channel sent with the message (a WhatsApp profile name, the
    // operator's own system naming its customer) replaces the bare identity —
    // and only that: a name somebody gave the contact is never overwritten.
    const senderName = inbound.senderName;
    if (senderName !== null) {
      await sql.query(
        `UPDATE contacts SET display_name=$3, search_name=$4, updated_at=now()
          WHERE id=$1 AND display_name=$2 AND deleted_at IS NULL`,
        [contact.contactId, inbound.peerIdentity, senderName, normalizeSearchText(senderName)],
      );
    }
    if (kind === 'messenger' || kind === 'instagram') {
      await sql.query(
        `INSERT INTO contact_profile_queue (tenant_id, contact_id, connection_id)
         SELECT $1, $2, $3 WHERE EXISTS
           (SELECT 1 FROM contacts WHERE id=$2 AND display_name=$4)
         ON CONFLICT DO NOTHING`,
        [tenantId, contact.contactId, connectionId, inbound.peerIdentity],
      );
    }
    await this.conversations.noteInbound(sql, tenantId, conversation, {
      inboundEventId,
      occurredAt: inbound.occurredAt,
      contactId: contact.contactId,
      payload: {
        providerMessageId: inbound.providerMessageId,
        contentType: inbound.contentType,
        text: inbound.text,
      },
    });
  }
}

/** The channel a connection speaks. An identity is only meaningful within it. */
async function connectionKind(sql: SqlExecutor, connectionId: string): Promise<string> {
  const rows = await sql.query<{ kind: string }>(
    'SELECT kind FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  return requireRow(rows.rows, 'the message names a channel that does not exist').kind;
}

/**
 * Projects one journaled event into the normalized table.
 *
 * Returns the row it added, or `null` when the event was already projected.
 * `ON CONFLICT DO NOTHING` against the source-uniqueness index is what makes a
 * replay idempotent: running this over an event that was already projected
 * changes nothing and reports so, rather than either failing or silently
 * doubling a customer's message. The caller uses the returned row to decide
 * what the arrival means for the inbox — which is exactly the work a replay
 * must not repeat.
 */
async function projectEvent(
  sql: SqlExecutor,
  tenantId: string,
  eventId: string,
  connectionId: string,
  event: Record<string, unknown>,
): Promise<{ readonly id: string; readonly row: InboundRow } | null> {
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
  const insertedId = inserted.rows[0]?.id;
  return insertedId === undefined ? null : { id: insertedId, row };
}
