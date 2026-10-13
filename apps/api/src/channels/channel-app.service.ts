import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PINNED_GRAPH_VERSION } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { unlessConstraint } from '../pg-error.js';
import { API_CONFIG } from '../tokens.js';
import { setUpCipher } from './credential-cipher.js';

export interface ChannelAppSummary {
  readonly id: string;
  readonly external_app_id: string;
  readonly scope: 'workspace' | 'installation';
  readonly status: string;
  readonly secret_held: boolean;
  readonly created_at: string;
}

export interface CreatedChannelApp extends ChannelAppSummary {
  /** Returned once. Only its SHA-256 hash is retained for Meta's GET challenge. */
  readonly verify_token: string;
}

const META_APP_ID = /^[0-9]{1,32}$/;
const APP_SECRET = /^[\x21-\x7e]{16,256}$/;

@Injectable()
export class ChannelAppService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async list(session: AuthenticatedSession, tenantId: string): Promise<readonly ChannelAppSummary[]> {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql }) => {
      const rows = await sql.query<{
        id: string; external_app_id: string; tenant_id: string | null;
        status: string; secret_held: boolean; created_at: Date;
      }>(
        `SELECT id::text, external_app_id, tenant_id::text, status,
                (secret_ciphertext IS NOT NULL OR secret_ref IS NOT NULL) AS secret_held, created_at
           FROM channel_apps
          WHERE provider = 'meta' AND (tenant_id = $1 OR tenant_id IS NULL)
          ORDER BY tenant_id NULLS LAST, created_at`,
        [tenantId],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        external_app_id: row.external_app_id,
        scope: row.tenant_id === null ? 'installation' : 'workspace',
        status: row.status,
        secret_held: row.secret_held,
        created_at: row.created_at.toISOString(),
      }));
    });
  }

  async create(session: AuthenticatedSession, tenantId: string, body: unknown): Promise<CreatedChannelApp> {
    const input = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const externalAppId = typeof input['externalAppId'] === 'string' ? input['externalAppId'].trim() : '';
    const appSecret = typeof input['appSecret'] === 'string' ? input['appSecret'] : '';
    if (!META_APP_ID.test(externalAppId) || !APP_SECRET.test(appSecret)) {
      throw new ApiHttpError(400, 'invalid_input', 'Enter a numeric Meta App ID and a valid App Secret.', [
        ...(!META_APP_ID.test(externalAppId) ? [{ field: 'externalAppId', code: 'malformed', message: 'Enter the numeric Meta App ID.' }] : []),
        ...(!APP_SECRET.test(appSecret) ? [{ field: 'appSecret', code: 'malformed', message: 'Enter the Meta App Secret (16–256 printable characters, no spaces).' }] : []),
      ]);
    }
    const setup = setUpCipher(this.config.secrets.credentialKeys, this.config.secrets.authHash);
    if (!setup.ok) throw new ApiHttpError(503, 'credential_storage_unavailable', setup.message);
    const id = randomUUID();
    const verifyToken = randomBytes(32).toString('base64url');
    const sealed = setup.cipher.seal(appSecret, { tenantId, connectionId: id, purpose: 'meta_app_secret' });
    const verifyHash = createHash('sha256').update(verifyToken).digest('hex');

    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql }) => {
      await this.authorization.requirePermission(sql, session, 'credential.rotate');
      const inserted = await unlessConstraint('channel_apps_external_uq',
        new ApiHttpError(409, 'meta_app_already_registered', 'This Meta App ID is already registered.'),
        () => sql.query<{ created_at: Date }>(
          `INSERT INTO channel_apps
             (id, tenant_id, provider, external_app_id, secret_ref, secret_fingerprint,
              verify_token_hash, graph_version, secret_ciphertext, secret_iv,
              secret_auth_tag, secret_key_version)
           VALUES ($1, $2, 'meta', $3, NULL, $4, $5, $6, $7, $8, $9, $10)
           RETURNING created_at`,
          [id, tenantId, externalAppId, sealed.fingerprint, verifyHash, PINNED_GRAPH_VERSION,
            sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
        ));
      return {
        id,
        external_app_id: externalAppId,
        scope: 'workspace',
        status: 'active',
        secret_held: true,
        created_at: inserted.rows[0]!.created_at.toISOString(),
        verify_token: verifyToken,
      };
    });
  }
}
