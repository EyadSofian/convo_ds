import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, CREDENTIAL_SETTINGS, withCredentialResolvedTenant } from '@convo/database';
import type { ChannelAdapter, ChannelKind, NormalizedBatch } from '@convo/domain';
import { originAllowed, PROVIDER_OF } from '@convo/domain';
import type { Pool } from 'pg';
import { AuthRateLimiter } from '../auth/auth-rate-limiter.js';
import { requireRow } from '../require-row.js';
import { API_POOL } from '../tokens.js';
import { adapterFor } from './adapters.js';
import { ChannelCredentialService } from './credential.service.js';
import type { IngressDelivery, IngressOutcome } from './ingress.service.js';
import { journalBatch, writeReceipt } from './ingress-journal.js';
import { assetFingerprint, sha256BytesHex } from './node-crypto.js';

/**
 * Ingress for the channels we own: Website Chat and the Custom Channel API.
 *
 * These have no provider, which changes where every guarantee comes from. With
 * Meta, the app secret is installation configuration and the signature proves
 * the sender is Meta. Here the signing key belongs to **one connection**, so
 * the route names the asset, the key is looked up to check the signature, and
 * nothing is stored until it holds.
 *
 * That lookup-before-verify is not a weakening of DEL-02: it is the same shape
 * as reading Meta's app secret from the app id in the URL. What matters is that
 * the route key is used to *find a key*, never to decide who the delivery
 * belongs to — the tenant comes from the registry row whose fingerprint the
 * route key produced, and the delivery is discarded if its signature fails.
 *
 * Two protections a provider would otherwise give us are enforced here:
 *
 * - an **origin allowlist**, because a widget's signing key lives in a page and
 *   a key that has leaked can otherwise be used from anywhere;
 * - a **rate limit** per connection, because a widget is reachable by anyone
 *   who loads the page.
 */
@Injectable()
export class SelfHostedIngressService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(ChannelCredentialService) private readonly credentials: ChannelCredentialService,
    @Inject(AuthRateLimiter) private readonly limiter: AuthRateLimiter,
  ) {}

  async receive(kind: ChannelKind, delivery: IngressDelivery): Promise<IngressOutcome> {
    const adapter = adapterFor(kind);
    const bodySha = sha256BytesHex(delivery.rawBody);
    const fingerprint = assetFingerprint(PROVIDER_OF[kind], kind, delivery.routeKey);

    const outcome = await withCredentialResolvedTenant(
      this.pool,
      CREDENTIAL_SETTINGS.channelAsset,
      fingerprint,
      async (client) => {
        const rows = await asExecutor(client).query<{
          tenant_id: string;
          connection_id: string;
        }>(
          `SELECT tenant_id::text, connection_id::text
             FROM channel_asset_registry WHERE asset_fingerprint = $1`,
          [fingerprint],
        );
        const row = rows.rows[0];
        return row === undefined ? null : { tenantId: row.tenant_id, value: row.connection_id };
      },
      async (client, resolved) => this.verifyAndStore(client, resolved, adapter, delivery, bodySha),
    );

    if (outcome === null) {
      // Nobody here has that installation. No content is retained and no
      // detail is returned: whether an id exists is not an unauthenticated
      // caller's business.
      await writeReceipt(asExecutor(this.pool), {
        appId: null,
        delivery,
        bodySha,
        signatureValid: false,
        outcome: 'unknown_asset',
        tenantId: null,
        eventCount: 0,
      });
      return { status: 'rejected', code: 'unknown_asset', httpStatus: 404 };
    }
    return outcome;
  }

  private async verifyAndStore(
    client: Parameters<typeof asExecutor>[0],
    resolved: { readonly tenantId: string; readonly value: string },
    adapter: ChannelAdapter,
    delivery: IngressDelivery,
    bodySha: string,
  ): Promise<IngressOutcome> {
    const sql = asExecutor(client);
    // Disconnecting releases the asset claim, so a retired installation never
    // reaches here at all — the registry lookup above already answered 404 for
    // it, which is deliberately the same answer an id nobody ever used gets.
    const connection = await sql.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM channel_connections WHERE id = $1',
      [resolved.value],
    );
    const row = requireRow(connection.rows, 'the connection behind a registry row vanished');

    const allowed = stringArray(row.settings['origins']);
    if (!originAllowed(delivery.headers['origin'], allowed)) {
      await this.receiptWithin(sql, delivery, bodySha, false, 'signature_invalid', null);
      return { status: 'rejected', code: 'origin_not_allowed', httpStatus: 403 };
    }

    // Before the signature check: an attacker with no key can otherwise make us
    // do the HMAC work as fast as they can send.
    const perMinute = numberOr(row.settings['rate_per_minute'], 120);
    const decision = await this.limiter.consume('channel-ingress', resolved.value, {
      maxAttempts: perMinute,
      windowSeconds: 60,
    });
    if (decision.status === 'blocked') {
      return { status: 'rejected', code: 'rate_limited', httpStatus: 429 };
    }

    const verified = await this.credentials.withActive(
      sql,
      { tenantId: resolved.tenantId, connectionId: resolved.value, purpose: 'signing_key' },
      (secret) =>
        Promise.resolve(
          adapter.verifySignature({
            rawBody: delivery.rawBody,
            headers: delivery.headers,
            secret,
            now: delivery.receivedAt,
          }),
        ),
    );
    if (verified === null) {
      await this.receiptWithin(sql, delivery, bodySha, false, 'signature_invalid', null);
      return { status: 'rejected', code: 'signing_key_missing', httpStatus: 503 };
    }
    if (!verified.valid) {
      await this.receiptWithin(sql, delivery, bodySha, false, 'signature_invalid', null);
      return { status: 'rejected', code: verified.reason, httpStatus: 401 };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(delivery.rawBody).toString('utf8'));
    } catch {
      await this.receiptWithin(sql, delivery, bodySha, true, 'malformed', null);
      return { status: 'rejected', code: 'malformed_body', httpStatus: 400 };
    }

    const batch: NormalizedBatch = adapter.normalize(payload, delivery.receivedAt);
    const receiptId = await this.receiptWithin(
      sql,
      delivery,
      bodySha,
      true,
      'routed',
      resolved.tenantId,
      batch.events.length + batch.quarantined.length,
    );
    const stored = await journalBatch(sql, {
      tenantId: resolved.tenantId,
      connectionId: resolved.value,
      receiptId,
      batch,
    });
    return { status: 'accepted', receiptId, ...stored };
  }

  private async receiptWithin(
    sql: ReturnType<typeof asExecutor>,
    delivery: IngressDelivery,
    bodySha: string,
    signatureValid: boolean,
    outcome: string,
    tenantId: string | null,
    eventCount = 0,
  ): Promise<string> {
    return writeReceipt(sql, {
      appId: null,
      delivery,
      bodySha,
      signatureValid,
      outcome,
      tenantId,
      eventCount,
    });
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
