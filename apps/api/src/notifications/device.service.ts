import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { setUpCipher } from '../channels/credential-cipher.js';
import type { CredentialCipher } from '../channels/credential-cipher.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { API_CONFIG } from '../tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
export interface WebPushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

function invalid(): ApiHttpError {
  return new ApiHttpError(400, 'invalid_push_subscription', 'The push subscription is invalid or unsupported.');
}

/** No arbitrary URL may be handed to the integration worker as an SSRF target. */
export function parseWebPushSubscription(input: unknown): WebPushSubscription {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid();
  const record = input as Record<string, unknown>;
  const keys = record['keys'];
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) throw invalid();
  const pair = keys as Record<string, unknown>;
  if (typeof record['endpoint'] !== 'string' || typeof pair['p256dh'] !== 'string' || typeof pair['auth'] !== 'string') throw invalid();
  let url: URL;
  try { url = new URL(record['endpoint']); } catch { throw invalid(); }
  if (record['endpoint'].length > 2048 || url.protocol !== 'https:' || url.username !== '' ||
      url.password !== '' || url.hash !== '' || !PUSH_HOSTS.has(url.hostname) || url.port !== '') throw invalid();
  if (!/^[A-Za-z0-9_-]+$/.test(pair['p256dh']) || Buffer.from(pair['p256dh'], 'base64url').length !== 65 ||
      !/^[A-Za-z0-9_-]+$/.test(pair['auth']) || Buffer.from(pair['auth'], 'base64url').length !== 16) throw invalid();
  return { endpoint: url.toString(), keys: { p256dh: pair['p256dh'], auth: pair['auth'] } };
}

@Injectable()
export class NotificationDeviceService {
  private readonly cipher: CredentialCipher | null;

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    const setup = setUpCipher(config.secrets.credentialKeys, config.secrets.idempotencyHash);
    this.cipher = setup.ok ? setup.cipher : null;
  }

  publicKey(): string | null {
    return this.cipher === null ? null : this.config.webPush.publicKey;
  }

  async register(session: AuthenticatedSession, tenantId: string, deviceId: string, raw: unknown): Promise<void> {
    if (!UUID.test(deviceId)) throw invalid();
    const subscription = parseWebPushSubscription(raw);
    const cipher = this.cipher;
    if (cipher === null || this.config.webPush.publicKey === null) {
      throw new ApiHttpError(503, 'push_unconfigured', 'Device notifications are not configured.');
    }
    await this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const sealed = cipher.seal(JSON.stringify(subscription), {
        tenantId, connectionId: deviceId, purpose: 'notification-web-push',
      });
      const endpointFingerprint = cipher.fingerprint(subscription.endpoint);
      await sql.query(
        `UPDATE notification_devices SET enabled=false, revoked_at=COALESCE(revoked_at,now())
          WHERE token_fingerprint=$1 AND enabled=true AND (membership_id<>$2 OR device_id<>$3)`,
        [endpointFingerprint, principal.membershipId, deviceId],
      );
      await sql.query(
        `INSERT INTO notification_devices
           (tenant_id, membership_id, device_id, platform, ciphertext, iv, auth_tag,
            key_version, token_fingerprint)
         VALUES ($1,$2,$3,'web_push',$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, membership_id, device_id) DO UPDATE
           SET ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv, auth_tag=EXCLUDED.auth_tag,
               key_version=EXCLUDED.key_version, token_fingerprint=EXCLUDED.token_fingerprint,
               last_seen_at=now(), enabled=true, revoked_at=NULL`,
        [tenantId, principal.membershipId, deviceId, sealed.ciphertext, sealed.iv,
          sealed.authTag, sealed.keyVersion, endpointFingerprint],
      );
    });
  }

  async revoke(session: AuthenticatedSession, tenantId: string, deviceId: string): Promise<void> {
    if (!UUID.test(deviceId)) throw invalid();
    await this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      await sql.query(
        `UPDATE notification_devices SET enabled=false, revoked_at=COALESCE(revoked_at,now())
          WHERE membership_id=$1 AND device_id=$2`, [principal.membershipId, deviceId],
      );
    });
  }

  async list(session: AuthenticatedSession, tenantId: string) {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const rows = await sql.query<{ device_id: string; platform: string; created_at: Date; last_seen_at: Date; enabled: boolean }>(
        `SELECT device_id::text, platform, created_at, last_seen_at, enabled
           FROM notification_devices WHERE membership_id=$1
          ORDER BY last_seen_at DESC LIMIT 50`, [principal.membershipId],
      );
      return rows.rows.map((row) => ({ deviceId: row.device_id, platform: row.platform,
        createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), enabled: row.enabled }));
    });
  }
}
