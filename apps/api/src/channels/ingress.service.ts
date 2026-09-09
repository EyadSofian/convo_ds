import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, CREDENTIAL_SETTINGS, withCredentialResolvedTenant } from '@convo/database';
import type { ChannelKind, NormalizedBatch, SqlExecutor } from '@convo/domain';
import { PROVIDER_OF } from '@convo/domain';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import { adapterFor } from './adapters.js';
import { assetFingerprint, nodeChannelCrypto, sha256BytesHex } from './node-crypto.js';

/**
 * Webhook ingress: the only door provider events come through.
 *
 * The order below is the whole design, and it is the order ADR-0005 fixes:
 *
 * 1. Read the raw bytes. Not the parsed body — the exact bytes, because a
 *    signature over a re-serialized object verifies a document nobody signed.
 * 2. Verify the signature and the replay window. Before anything is parsed,
 *    before any lookup, before any write.
 * 3. Resolve the tenant from the **verified asset id inside the payload**. A
 *    path parameter, a header or a query string is never authority (DEL-02).
 * 4. Persist the raw envelope and its dedupe key, then ACK. Durable means
 *    committed; if the write fails the answer is a retryable non-2xx, never 200.
 * 5. Everything else — normalization, the inbox, CRM, media, AI — happens
 *    afterwards, off this path (DEL-04).
 *
 * A receipt is written for every delivery including the refused ones, because
 * "we received bytes that failed to verify" is exactly the evidence an operator
 * needs when a provider says it delivered something.
 */

export type IngressOutcome =
  | { readonly status: 'accepted'; readonly receiptId: string; readonly stored: number; readonly duplicates: number }
  | { readonly status: 'rejected'; readonly code: string; readonly httpStatus: number };

export interface IngressDelivery {
  readonly routeKey: string;
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly receivedAt: Date;
}

interface AppRow {
  readonly id: string;
  readonly provider: string;
  readonly secret_ref: string;
  readonly verify_token_hash: string;
  readonly status: string;
}

@Injectable()
export class ChannelIngressService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The GET subscription handshake.
   *
   * Answering it proves we hold the verify token. It is not authentication for
   * a POST and nothing here treats it as such.
   */
  async challenge(
    routeKey: string,
    query: Readonly<Record<string, string | undefined>>,
  ): Promise<string> {
    const app = await this.loadApp(routeKey);
    const adapter = adapterFor('whatsapp');
    /* c8 ignore next 3 -- the WhatsApp adapter is registered at module load */
    if (adapter === null) {
      throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
    }
    const answer = adapter.verifyChallenge(query, app.verify_token_hash, nodeChannelCrypto.sha256Hex);
    if (answer === null) {
      // The same 403 for a wrong token, a wrong mode and a missing challenge.
      // Distinguishing them would let a caller probe for the token's shape.
      throw new ApiHttpError(403, 'verification_failed', 'The subscription challenge failed.');
    }
    return answer;
  }

  /**
   * Receives one signed delivery.
   *
   * Returns a value rather than throwing for the refusals, because every one of
   * them still writes a receipt and the controller needs to know which status
   * to answer with. A *storage* failure does throw: that must reach the
   * provider as a retryable non-2xx (DEL-03).
   */
  async receive(delivery: IngressDelivery): Promise<IngressOutcome> {
    const app = await this.loadApp(delivery.routeKey);
    const secret = this.config.channelSecrets[app.secret_ref];
    const bodySha = sha256BytesHex(delivery.rawBody);

    if (secret === undefined) {
      // Configuration is missing, so nothing can be verified. This is our fault
      // and the delivery is worth retrying once it is fixed, so it is a 503 and
      // not a silent 200 that would lose the message forever.
      await this.writeReceipt(app.id, delivery, bodySha, false, 'signature_invalid', null, 0);
      throw new ApiHttpError(
        503,
        'channel_secret_unavailable',
        'The provider app secret is not configured.',
      );
    }

    const adapter = adapterFor('whatsapp');
    /* c8 ignore next 3 -- the WhatsApp adapter is registered at module load */
    if (adapter === null) {
      throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
    }

    const verdict = adapter.verifySignature({
      rawBody: delivery.rawBody,
      headers: delivery.headers,
      secret,
      now: delivery.receivedAt,
    });
    if (!verdict.valid) {
      await this.writeReceipt(app.id, delivery, bodySha, false, 'signature_invalid', null, 0);
      return { status: 'rejected', code: verdict.reason, httpStatus: 401 };
    }

    // Parsing happens only now. An unparsable body from a *verified* sender is
    // a real event we cannot read, which is different from an attacker's junk.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(delivery.rawBody).toString('utf8'));
    } catch {
      await this.writeReceipt(app.id, delivery, bodySha, true, 'malformed', null, 0);
      return { status: 'rejected', code: 'malformed_body', httpStatus: 400 };
    }

    const batch = adapter.normalize(payload, delivery.receivedAt);
    if (batch.assetId === null) {
      await this.writeReceipt(app.id, delivery, bodySha, true, 'unsupported', null, 0);
      // A verified delivery with nothing addressable in it. ACKed, because
      // retrying it forever helps nobody, and journaled so it is not invisible.
      return { status: 'rejected', code: 'no_asset_in_payload', httpStatus: 202 };
    }

    const fingerprint = assetFingerprint(PROVIDER_OF['whatsapp'], 'whatsapp', batch.assetId);
    const routed = await this.storeRouted(app, delivery, bodySha, fingerprint, batch);
    if (routed === null) {
      await this.writeReceipt(app.id, delivery, bodySha, true, 'unknown_asset', null, 0);
      // Signature-valid but for an asset nobody here has connected. ACKed with
      // no content retained: storing a stranger's messages would be worse than
      // dropping them.
      return { status: 'rejected', code: 'unknown_asset', httpStatus: 202 };
    }
    return routed;
  }

  /**
   * Resolves the tenant from the verified asset and stores the batch.
   *
   * The registry read happens under a one-row-wide RLS carve-out keyed on the
   * fingerprint we just derived from a signature-verified payload, so no tenant
   * context is needed to find the owner and no other tenant's row is visible
   * while we do.
   */
  private async storeRouted(
    app: AppRow,
    delivery: IngressDelivery,
    bodySha: string,
    fingerprint: string,
    batch: NormalizedBatch,
  ): Promise<IngressOutcome | null> {
    return withCredentialResolvedTenant(
      this.pool,
      CREDENTIAL_SETTINGS.channelAsset,
      fingerprint,
      async (client) => {
        const rows = await asExecutor(client).query<{ tenant_id: string; connection_id: string }>(
          `SELECT tenant_id::text, connection_id::text
             FROM channel_asset_registry WHERE asset_fingerprint = $1`,
          [fingerprint],
        );
        const row = rows.rows[0];
        return row === undefined
          ? null
          : { tenantId: row.tenant_id, value: row.connection_id };
      },
      async (client, resolved) => {
        const sql = asExecutor(client);
        // The receipt and the events commit together. A receipt saying "routed"
        // with no events behind it would be evidence of something that did not
        // happen.
        const receiptId = await this.writeReceiptWithin(
          sql,
          app.id,
          delivery,
          bodySha,
          true,
          'routed',
          resolved.tenantId,
          batch.events.length + batch.quarantined.length,
        );

        let stored = 0;
        let duplicates = 0;
        for (const event of batch.events) {
          const inserted = await insertEvent(sql, {
            tenantId: resolved.tenantId,
            connectionId: resolved.value,
            receiptId,
            dedupeKey: event.dedupeKey,
            eventType: event.eventType,
            // The provider's element is the evidence; the normalized form is
            // what the projection is built from. Both are kept.
            payload: event.source,
            normalized: event,
            quarantineReason: null,
          });
          if (inserted) stored += 1;
          else duplicates += 1;
        }
        // A poison element does not lose the rest of the batch (EVT-03): it is
        // stored beside its siblings, marked, with its payload intact.
        for (const element of batch.quarantined) {
          const inserted = await insertEvent(sql, {
            tenantId: resolved.tenantId,
            connectionId: resolved.value,
            receiptId,
            dedupeKey: element.dedupeKey,
            eventType: element.eventType,
            payload: element.payload,
            normalized: null,
            quarantineReason: element.reason,
          });
          if (inserted) stored += 1;
          else duplicates += 1;
        }

        // First inbound is evidence, and this is the only place that can
        // observe it. `coalesce` so a later delivery does not move the mark.
        await sql.query(
          `UPDATE channel_connections
              SET first_inbound_at = coalesce(first_inbound_at, now()),
                  webhook_subscribed_at = coalesce(webhook_subscribed_at, now())
            WHERE id = $1`,
          [resolved.value],
        );

        const outcome: IngressOutcome = {
          status: 'accepted',
          receiptId,
          stored,
          duplicates,
        };
        return outcome;
      },
    );
  }

  private async loadApp(routeKey: string): Promise<AppRow> {
    const rows = await asExecutor(this.pool).query<AppRow>(
      `SELECT id::text, provider, secret_ref, verify_token_hash, status
         FROM channel_apps WHERE id::text = $1 AND status = 'active'`,
      [UUID_PATTERN.test(routeKey) ? routeKey : '00000000-0000-4000-8000-000000000000'],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      // The same 404 a nonexistent route gives. Whether this installation has a
      // Meta app registered is not something an unauthenticated caller learns.
      throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
    }
    return row;
  }

  private async writeReceipt(
    appId: string,
    delivery: IngressDelivery,
    bodySha: string,
    signatureValid: boolean,
    outcome: string,
    tenantId: string | null,
    eventCount: number,
  ): Promise<string> {
    return this.writeReceiptWithin(
      asExecutor(this.pool),
      appId,
      delivery,
      bodySha,
      signatureValid,
      outcome,
      tenantId,
      eventCount,
    );
  }

  private async writeReceiptWithin(
    sql: SqlExecutor,
    appId: string,
    delivery: IngressDelivery,
    bodySha: string,
    signatureValid: boolean,
    outcome: string,
    tenantId: string | null,
    eventCount: number,
  ): Promise<string> {
    const rows = await sql.query<{ id: string }>(
      `INSERT INTO webhook_receipts
         (app_id, route_key, body_sha256, body_bytes, signature_valid, outcome, tenant_id, event_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id::text`,
      [
        appId,
        delivery.routeKey,
        bodySha,
        delivery.rawBody.byteLength,
        signatureValid,
        outcome,
        tenantId,
        eventCount,
      ],
    );
    return requireRow(rows.rows, 'receipt insert returned no id').id;
  }
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface EventInsert {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly receiptId: string;
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly normalized: unknown;
  readonly quarantineReason: string | null;
}

/**
 * Inserts one event, or reports that it was already here.
 *
 * `ON CONFLICT DO NOTHING` on the per-tenant dedupe key is what makes
 * redelivery safe (DEL-05, EVT-02): the same fact arriving twice, in two
 * differently ordered batches, produces one row and therefore one domain
 * effect — and the duplicate is counted rather than silently ignored, so an
 * operator can see redelivery happening.
 */
async function insertEvent(sql: SqlExecutor, event: EventInsert): Promise<boolean> {
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO channel_events
       (tenant_id, connection_id, receipt_id, dedupe_key, event_type, payload, normalized,
        status, quarantine_reason, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, coalesce($8::jsonb, '{}'::jsonb),
             CASE WHEN $7::text IS NULL THEN 'received' ELSE 'quarantined' END,
             $7,
             -- A quarantined element has already been dealt with: it is not
             -- waiting for a normalizer, so it carries a processing time.
             CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id::text`,
    [
      event.tenantId,
      event.connectionId,
      event.receiptId,
      event.dedupeKey,
      event.eventType,
      JSON.stringify(event.payload ?? null),
      event.quarantineReason,
      event.normalized === null ? null : JSON.stringify(event.normalized),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    return false;
  }
  // The queue entry commits with the event. A quarantined element is already
  // dealt with and is not queued: there is nothing for a worker to do with it
  // beyond what the row already records.
  if (event.quarantineReason === null) {
    await sql.query(
      `INSERT INTO channel_event_queue (event_id, tenant_id) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [row.id, event.tenantId],
    );
  }
  return true;
}

/** Re-exported so the ingress controller can name the kind it serves. */
export const INGRESS_KIND: ChannelKind = 'whatsapp';
