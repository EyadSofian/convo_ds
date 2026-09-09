import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, CREDENTIAL_SETTINGS, withCredentialResolvedTenant } from '@convo/database';
import type { ChannelKind, NormalizedBatch } from '@convo/domain';
import { answerMetaChallenge, PROVIDER_OF, verifyMetaSignature } from '@convo/domain';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import { adapterClaiming, META_KINDS } from './adapters.js';
import { journalBatch, writeReceipt } from './ingress-journal.js';
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
    // The handshake belongs to the app, not to a channel: one subscription
    // covers all three Meta products, so it is answered with the shared scheme
    // rather than by choosing an adapter that has not been identified yet.
    const answer = answerMetaChallenge(query, app.verify_token_hash, nodeChannelCrypto);
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
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: false,
        outcome: 'signature_invalid',
        tenantId: null,
        eventCount: 0,
      });
      throw new ApiHttpError(
        503,
        'channel_secret_unavailable',
        'The provider app secret is not configured.',
      );
    }

    // Signature first, with the shared Meta scheme: the three Meta channels are
    // one app registration signing one way, so the *verification* is common
    // even though nothing built on top of it is.
    const verdict = verifyMetaSignature(
      {
        rawBody: delivery.rawBody,
        headers: delivery.headers,
        secret,
        now: delivery.receivedAt,
      },
      nodeChannelCrypto,
    );
    if (!verdict.valid) {
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: false,
        outcome: 'signature_invalid',
        tenantId: null,
        eventCount: 0,
      });
      return { status: 'rejected', code: verdict.reason, httpStatus: 401 };
    }

    // Parsing happens only now. An unparsable body from a *verified* sender is
    // a real event we cannot read, which is different from an attacker's junk.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(delivery.rawBody).toString('utf8'));
    } catch {
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: true,
        outcome: 'malformed',
        tenantId: null,
        eventCount: 0,
      });
      return { status: 'rejected', code: 'malformed_body', httpStatus: 400 };
    }

    // Which of the three products this delivery is. Meta multiplexes them over
    // one webhook and distinguishes them only by the envelope's `object`.
    const adapter = adapterClaiming(payload, META_KINDS);
    if (adapter === null) {
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: true,
        outcome: 'unsupported',
        tenantId: null,
        eventCount: 0,
      });
      return { status: 'rejected', code: 'unknown_envelope', httpStatus: 202 };
    }

    const batch = adapter.normalize(payload, delivery.receivedAt);
    if (batch.assetId === null) {
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: true,
        outcome: 'unsupported',
        tenantId: null,
        eventCount: 0,
      });
      // A verified delivery with nothing addressable in it. ACKed, because
      // retrying it forever helps nobody, and journaled so it is not invisible.
      return { status: 'rejected', code: 'no_asset_in_payload', httpStatus: 202 };
    }

    const fingerprint = assetFingerprint(
      PROVIDER_OF[adapter.kind],
      adapter.kind,
      batch.assetId,
    );
    const routed = await this.storeRouted(app, delivery, bodySha, fingerprint, batch);
    if (routed === null) {
      await writeReceipt(asExecutor(this.pool), {
        appId: app.id,
        delivery,
        bodySha,
        signatureValid: true,
        outcome: 'unknown_asset',
        tenantId: null,
        eventCount: 0,
      });
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
        const receiptId = await writeReceipt(sql, {
          appId: app.id,
          delivery,
          bodySha,
          signatureValid: true,
          outcome: 'routed',
          tenantId: resolved.tenantId,
          eventCount: batch.events.length + batch.quarantined.length,
        });
        const stored = await journalBatch(sql, {
          tenantId: resolved.tenantId,
          connectionId: resolved.value,
          receiptId,
          batch,
        });
        const outcome: IngressOutcome = { status: 'accepted', receiptId, ...stored };
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

}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Re-exported so the ingress controller can name the kind it serves. */
export const INGRESS_KIND: ChannelKind = 'whatsapp';
