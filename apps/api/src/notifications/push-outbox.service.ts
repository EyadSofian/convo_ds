import { Inject, Injectable, Optional } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { Pool } from 'pg';
import webPush from 'web-push';
import type { ApiConfig } from '../config.js';
import { setUpCipher } from '../channels/credential-cipher.js';
import type { CredentialCipher } from '../channels/credential-cipher.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import { parseWebPushSubscription } from './device.service.js';
import type { WebPushSubscription } from './device.service.js';

interface Claim { readonly id: string; readonly tenant_id: string; readonly attempt_count: number; }
interface Delivery {
  readonly notification_id: string;
  readonly device_id: string;
  readonly device_public_id: string;
  readonly kind: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly read_at: Date | null;
  readonly enabled: boolean;
  readonly member_status: string;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
  readonly key_version: string;
}
const MAX_ATTEMPTS = 5;
const PUSH_SENDER = Symbol('PUSH_SENDER');
export type PushSender = typeof webPush.sendNotification;

export function classifyPushFailure(status: number, attemptCount: number):
  { readonly action: 'revoke' | 'fail' | 'retry'; readonly code: string } {
  if (status === 404 || status === 410) return { action: 'revoke', code: 'subscription_expired' };
  const code = status === 0 ? 'push_network' : `push_http_${String(status)}`;
  // Authentication and malformed requests cannot be repaired by retrying the
  // same subscription. 429, server errors and network failures can recover.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { action: 'fail', code };
  }
  return { action: attemptCount >= MAX_ATTEMPTS ? 'fail' : 'retry', code };
}

@Injectable()
export class PushOutboxService {
  private readonly cipher: CredentialCipher | null;
  private readonly send: PushSender;
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Optional() @Inject(PUSH_SENDER) sender?: PushSender,
  ) {
    this.send = sender ?? webPush.sendNotification;
    const setup = setUpCipher(config.secrets.credentialKeys, config.secrets.idempotencyHash);
    this.cipher = setup.ok ? setup.cipher : null;
    if (config.processRole === 'worker-integration' && config.webPush.privateKey !== null && this.cipher === null) {
      throw new Error('Web Push credential encryption is not configured.');
    }
  }

  /** The worker owns provider I/O. HTTP requests only enqueue durable work. */
  async drain(limit: number): Promise<number> {
    if (this.config.webPush.privateKey === null || this.config.webPush.publicKey === null ||
        this.config.webPush.subject === null || this.cipher === null) return 0;
    let handled = 0;
    for (let index = 0; index < limit; index += 1) {
      const claim = await this.claim();
      if (claim === null) break;
      await this.process(claim);
      handled += 1;
    }
    return handled;
  }

  private async claim(): Promise<Claim | null> {
    const rows = await asExecutor(this.pool).query<Claim>(
      `UPDATE notification_push_queue
          SET attempt_count=attempt_count+1, lease_until=now()+interval '2 minutes'
        WHERE id=(
          SELECT id FROM notification_push_queue
           WHERE state='pending' AND next_attempt_at<=now()
             AND (lease_until IS NULL OR lease_until<now())
           ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        )
      RETURNING id::text,tenant_id::text,attempt_count`,
    );
    return rows.rows[0] ?? null;
  }

  private async process(claim: Claim): Promise<void> {
    const delivery = await withTenant(this.pool, claim.tenant_id, async (client) => {
      const rows = await asExecutor(client).query<Delivery>(
        `SELECT n.id::text AS notification_id, d.id::text AS device_id,
                d.device_id::text AS device_public_id, n.kind, n.target_type,
                n.target_id::text, n.read_at, d.enabled, m.status AS member_status,
                d.ciphertext,d.iv,d.auth_tag,d.key_version
           FROM notification_push_queue q
           JOIN notifications n ON n.tenant_id=q.tenant_id AND n.id=q.notification_id
           JOIN notification_devices d ON d.tenant_id=q.tenant_id AND d.id=q.device_id
           JOIN memberships m ON m.tenant_id=d.tenant_id AND m.id=d.membership_id
          WHERE q.id=$1 AND q.state='pending'`, [claim.id],
      );
      return rows.rows[0] ?? null;
    });
    if (delivery === null || delivery.read_at !== null || !delivery.enabled || delivery.member_status !== 'active') {
      await this.settle(claim, 'skipped', 'no_longer_relevant');
      return;
    }
    let subscription: WebPushSubscription;
    try {
      const plaintext = this.cipher!.open({
        ciphertext: delivery.ciphertext, iv: delivery.iv, authTag: delivery.auth_tag,
        keyVersion: delivery.key_version, fingerprint: '',
      }, { tenantId: claim.tenant_id, connectionId: delivery.device_public_id, purpose: 'notification-web-push' });
      subscription = parseWebPushSubscription(JSON.parse(plaintext) as unknown);
    } catch {
      await this.settle(claim, 'failed', 'subscription_invalid');
      return;
    }
    try {
      // Opaque IDs and a generic kind only. No customer name, phone, message,
      // note, token, or tenant data may be displayed on a lock screen.
      await this.send(subscription, JSON.stringify({
        id: delivery.notification_id, kind: delivery.kind,
        targetType: delivery.target_type, targetId: delivery.target_id,
      }), {
        vapidDetails: {
          publicKey: this.config.webPush.publicKey!,
          privateKey: this.config.webPush.privateKey!,
          subject: this.config.webPush.subject!,
        }, TTL: 300, timeout: 10_000, urgency: 'normal', contentEncoding: 'aes128gcm',
        topic: delivery.notification_id.replace(/-/g, '').slice(0, 32),
      });
      await this.settle(claim, 'sent', null);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode: unknown }).statusCode) : 0;
      const failure = classifyPushFailure(status, claim.attempt_count);
      if (failure.action === 'revoke') {
        await withTenant(this.pool, claim.tenant_id, (client) => asExecutor(client).query(
          `UPDATE notification_devices SET enabled=false,revoked_at=now() WHERE id=$1`, [delivery.device_id],
        ));
        await this.settle(claim, 'failed', failure.code);
      } else if (failure.action === 'fail') {
        await this.settle(claim, 'failed', failure.code);
      } else {
        await this.retry(claim, failure.code);
      }
    }
  }

  private async settle(claim: Claim, state: 'sent' | 'failed' | 'skipped', code: string | null): Promise<void> {
    await asExecutor(this.pool).query(
      `UPDATE notification_push_queue
          SET state=$2,last_error_code=$3,settled_at=now(),lease_until=NULL
        WHERE id=$1 AND state='pending'`, [claim.id, state, code],
    );
  }

  private async retry(claim: Claim, code: string): Promise<void> {
    await asExecutor(this.pool).query(
      `UPDATE notification_push_queue
          SET next_attempt_at=now()+make_interval(secs => LEAST(3600,30*power(2,$2-1))::int),
              lease_until=NULL,last_error_code=$3
        WHERE id=$1 AND state='pending'`, [claim.id, claim.attempt_count, code],
    );
  }
}
