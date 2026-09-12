import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityMatrix, ChannelKind, EvidenceRecord, Readiness, SqlExecutor } from '@convo/domain';
import { capabilitiesFor, missingEvidence, PROVIDER_OF, readinessOf } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG, CHANNEL_TRANSPORT } from '../tokens.js';
import { implementedKinds } from './adapters.js';
import { parseConnectChannel, parseRotateCredential } from './channel-request.js';
import type { ConnectChannelRequest } from './channel-request.js';
import type { ChannelTransportPort } from './channel-transport.js';
import { ChannelCredentialService } from './credential.service.js';
import { assetFingerprint } from './node-crypto.js';

/**
 * Channel connections: the operator-facing half of the channel foundation.
 *
 * The rule this service exists to enforce is that **"connected" is earned, not
 * declared**. A caller supplies an asset id and a token; that produces a
 * connection in `authorization_needed`, not a working channel. Each later state
 * needs its own evidence, recorded by the thing that actually observed it: the
 * provider accepting the credential, the provider subscribing the webhook, a
 * real inbound delivery arriving, a real outbound send being accepted.
 *
 * The screen therefore cannot show "Connected" because a form was submitted,
 * and no code path here can set that state directly.
 */

export interface ChannelEvidenceView {
  readonly kind: string;
  readonly satisfied: boolean;
  readonly observed_at: string | null;
}

export interface ChannelConnectionSummary {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly provider: string;
  readonly display_name: string;
  readonly external_asset_id: string;
  readonly provider_app_id: string | null;
  readonly status: Readiness;
  readonly capabilities: CapabilityMatrix;
  readonly evidence: readonly ChannelEvidenceView[];
  readonly missing_evidence: readonly string[];
  readonly last_error_code: string | null;
  readonly last_error_at: string | null;
  readonly created_at: string;
  readonly disconnected_at: string | null;
  /** Whether a credential is held. Never the credential, never a prefix of it. */
  readonly credential_held: boolean;
  readonly credential_fingerprint: string | null;
}

export interface ChannelCatalogueEntry {
  readonly kind: ChannelKind;
  readonly provider: string;
  readonly implemented: boolean;
  readonly capabilities: CapabilityMatrix;
}

interface ConnectionRow {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly display_name: string;
  readonly external_asset_id: string;
  readonly provider_app_id: string | null;
  readonly capabilities: unknown;
  readonly asset_verified_at: Date | null;
  readonly credential_verified_at: Date | null;
  readonly webhook_subscribed_at: Date | null;
  readonly first_inbound_at: Date | null;
  readonly first_outbound_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_error_at: Date | null;
  readonly created_at: Date;
  readonly disconnected_at: Date | null;
  readonly credential_fingerprint: string | null;
}

const ASSET_TAKEN_INDEX = 'channel_asset_registry_asset_uq';
const LIVE_ASSET_INDEX = 'channel_connections_live_asset_uq';

/**
 * Which kind of secret a channel holds.
 *
 * A provider channel holds a grant *they* issued us and we present. Website
 * Chat and the Custom Channel API hold a key the installation signs *its*
 * deliveries with. They are stored identically and used in opposite directions,
 * so naming the purpose is what keeps a verifier from ever being handed a
 * sending credential.
 */
function credentialPurpose(kind: ChannelKind): 'access_token' | 'signing_key' {
  return kind === 'web_chat' || kind === 'custom' ? 'signing_key' : 'access_token';
}

/** Only the channels we own store settings; the rest have nothing to put there. */
function settingsColumn(request: ConnectChannelRequest): Record<string, unknown> {
  if (request.kind !== 'web_chat' && request.kind !== 'custom') {
    return {};
  }
  const settings: Record<string, unknown> = {};
  if (request.settings.origins !== undefined) settings['origins'] = request.settings.origins;
  if (request.settings.ratePerMinute !== undefined) {
    settings['rate_per_minute'] = request.settings.ratePerMinute;
  }
  if (request.settings.declaredTypes !== undefined) {
    settings['declared_types'] = request.settings.declaredTypes;
  }
  return settings;
}

@Injectable()
export class ChannelService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(ChannelCredentialService) private readonly credentials: ChannelCredentialService,
    @Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransportPort,
  ) {}

  /**
   * What this build can do, before anything is connected.
   *
   * Returned to every member who may read channels, because knowing that
   * Instagram exists and is not yet implemented is not privileged information —
   * and hiding it would make the screen look broken rather than incomplete.
   */
  async catalogue(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly ChannelCatalogueEntry[]> {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async () => {
      const implemented = new Set(implementedKinds());
      return (['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'] as const).map((kind) => ({
        kind,
        provider: PROVIDER_OF[kind],
        implemented: implemented.has(kind),
        capabilities: capabilitiesFor(kind),
      }));
    });
  }

  async list(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly ChannelConnectionSummary[]> {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql }) =>
      readConnections(sql, null),
    );
  }

  /**
   * Claims a provider asset for this tenant and stores its credential.
   *
   * Idempotent by key, because a retried connect that minted a second
   * connection would leave two rows racing for the same inbound messages. The
   * asset claim, the connection and the credential all commit together.
   */
  async connect(
    session: AuthenticatedSession,
    tenantId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ChannelConnectionSummary> {
    const parsed = parseConnectChannel(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }
    const request = parsed.value;
    this.authorization.assertTenantId(tenantId);

    const outcome = await this.idempotency.execute(
      {
        tenantContextId: tenantId,
        tenantId,
        principalId: session.userId,
        operation: 'channel.connect',
        key: idempotencyKey,
        // The token is part of the request, so a retry with a *different* token
        // is correctly a conflict rather than a silent replay of the first.
        requestHash: requestHash(body as JsonValue, this.config.secrets.idempotencyHash),
      },
      async (sql) => {
        await this.authorization.requirePermission(sql, session, 'channel.manage');
        const summary = await this.connectWithin(sql, tenantId, request);
        return { statusCode: 201, body: summary };
      },
    );

    if (outcome.status === 'conflict') {
      throw new ApiHttpError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return outcome.response.body as ChannelConnectionSummary;
  }

  private async connectWithin(
    sql: SqlExecutor,
    tenantId: string,
    request: ConnectChannelRequest,
  ): Promise<ChannelConnectionSummary> {
    const provider = PROVIDER_OF[request.kind];
    const capabilities = capabilitiesFor(request.kind);
    const appId = await resolveChannelApp(sql, provider, request);

    const inserted = await unlessConstraint(LIVE_ASSET_INDEX, assetTaken(), () =>
      sql.query<{ id: string }>(
        `INSERT INTO channel_connections
           (tenant_id, app_id, kind, external_asset_id, display_name, status,
            capabilities, settings, asset_verified_at)
         VALUES ($1, $2, $3, $4, $5, 'authorization_needed', $6::jsonb, $7::jsonb, now())
         RETURNING id::text`,
        [
          tenantId,
          appId,
          request.kind,
          request.externalAssetId,
          request.displayName,
          JSON.stringify(capabilities),
          JSON.stringify(settingsColumn(request)),
        ],
      ),
    );
    const connectionId = requireRow(inserted.rows, 'connection insert returned no id').id;

    // The installation-wide claim. A second tenant attempting the same asset is
    // refused here, and the refusal does not name the tenant that holds it:
    // that this number is already connected somewhere is not information the
    // claimant is entitled to (CH-03).
    await unlessConstraint(ASSET_TAKEN_INDEX, assetTaken(), () =>
      sql.query(
        `INSERT INTO channel_asset_registry
           (asset_fingerprint, provider, kind, external_asset_id, tenant_id, connection_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          assetFingerprint(provider, request.kind, request.externalAssetId),
          provider,
          request.kind,
          request.externalAssetId,
          tenantId,
          connectionId,
        ],
      ),
    );

    await this.credentials.store(
      sql,
      { tenantId, connectionId, purpose: credentialPurpose(request.kind) },
      request.accessToken,
      null,
    );

    const rows = await readConnections(sql, connectionId);
    return requireRow(rows, 'the connection vanished mid-transaction');
  }

  /**
   * Asks the provider whether the stored credential actually works.
   *
   * This is the only thing that may set `credential_verified_at`: a form that
   * accepted a token proves the operator typed something, and a screen that
   * called that "connected" is the specific lie this design refuses to tell.
   */
  async test(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
  ): Promise<ChannelConnectionSummary> {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql }) => {
      const connection = await requireConnection(sql, connectionId);
      const check = await this.credentials.withActive(
        sql,
        { tenantId, connectionId, purpose: credentialPurpose(connection.kind) },
        (token) => this.transport.validateConnection(connection.kind, token, connection.external_asset_id),
      );

      if (check === null) {
        await recordError(sql, connectionId, 'credential_missing');
      } else if (check.ok) {
        await sql.query(
          `UPDATE channel_connections
              SET credential_verified_at = now(), last_error_code = NULL, last_error_at = NULL
            WHERE id = $1`,
          [connectionId],
        );
      } else {
        await recordError(sql, connectionId, check.code ?? 'provider_rejected');
      }

      await refreshStatus(sql, connectionId);
      const rows = await readConnections(sql, connectionId);
      return requireRow(rows, 'the connection vanished mid-transaction');
    });
  }

  /**
   * Replaces the stored credential with a new one.
   *
   * Requires `credential.rotate`, not `channel.manage`: reaching a provider
   * credential is the narrower act, and the permission catalogue already
   * separates them. The previous version is superseded rather than deleted, and
   * verification is reset — the new token has proved nothing yet.
   */
  async rotate(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
    body: unknown,
  ): Promise<ChannelConnectionSummary> {
    const parsed = parseRotateCredential(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }
    return this.authorization.authorized(session, tenantId, 'credential.rotate', async ({ sql }) => {
      const connection = await requireConnection(sql, connectionId);
      await this.credentials.store(
        sql,
        { tenantId, connectionId, purpose: credentialPurpose(connection.kind) },
        parsed.value.accessToken,
        null,
      );
      await sql.query(
        `UPDATE channel_connections
            SET credential_verified_at = NULL, last_error_code = NULL, last_error_at = NULL
          WHERE id = $1`,
        [connectionId],
      );
      await refreshStatus(sql, connectionId);
      const rows = await readConnections(sql, connectionId);
      return requireRow(rows, 'the connection vanished mid-transaction');
    });
  }

  /**
   * Takes a connection out of service and revokes its credentials.
   *
   * The asset claim is released so the same number can be connected again —
   * here or, once the operator has genuinely given it up, by another tenant.
   * The connection row and its event history stay: they are evidence.
   */
  async disconnect(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string,
  ): Promise<void> {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql }) => {
      const connection = await requireConnection(sql, connectionId);
      if (connection.disconnected_at !== null) {
        // Already disconnected. Idempotent by nature, so this is a success
        // rather than a 409: the caller's intent is satisfied.
        return;
      }
      await this.credentials.revokeAll(sql, connectionId);
      await sql.query(
        `DELETE FROM channel_asset_registry WHERE connection_id = $1`,
        [connectionId],
      );
      await sql.query(
        `UPDATE channel_connections
            SET status = 'disconnected', disconnected_at = now()
          WHERE id = $1`,
        [connectionId],
      );
    });
  }
}

/* ------------------------------------------------------------- shared sql -- */

async function requireConnection(sql: SqlExecutor, connectionId: string): Promise<ConnectionRow> {
  const rows = await sql.query<ConnectionRow>(
    `SELECT c.id::text, c.kind, c.display_name, c.external_asset_id,
            app.external_app_id AS provider_app_id, c.capabilities,
            c.asset_verified_at, c.credential_verified_at, c.webhook_subscribed_at,
            c.first_inbound_at, c.first_outbound_at, c.last_error_code, c.last_error_at,
            c.created_at, c.disconnected_at, NULL::text AS credential_fingerprint
       FROM channel_connections c
       LEFT JOIN channel_apps app ON app.id = c.app_id
      WHERE c.id = $1`,
    [connectionId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
  }
  return row;
}

async function recordError(sql: SqlExecutor, connectionId: string, code: string): Promise<void> {
  await sql.query(
    `UPDATE channel_connections SET last_error_code = $2, last_error_at = now() WHERE id = $1`,
    [connectionId, code],
  );
}

/**
 * Recomputes the stored status from the evidence in the row.
 *
 * Derived in one place, from the same pure function the screen uses, so the
 * column and the rendering can never disagree — and no endpoint can set
 * `healthy` by writing it.
 */
async function refreshStatus(sql: SqlExecutor, connectionId: string): Promise<void> {
  const rows = await sql.query<ConnectionRow>(
    `SELECT id::text, kind, display_name, external_asset_id, NULL::text AS provider_app_id, capabilities,
            asset_verified_at, credential_verified_at, webhook_subscribed_at,
            first_inbound_at, first_outbound_at, last_error_code, last_error_at,
            created_at, disconnected_at, NULL::text AS credential_fingerprint
       FROM channel_connections WHERE id = $1`,
    [connectionId],
  );
  const row = requireRow(rows.rows, 'the connection vanished mid-transaction');
  await sql.query('UPDATE channel_connections SET status = $2 WHERE id = $1', [
    connectionId,
    statusOf(row),
  ]);
}

function evidenceOf(row: ConnectionRow): EvidenceRecord {
  return {
    asset_verified: row.asset_verified_at !== null,
    credential_verified: row.credential_verified_at !== null,
    webhook_subscribed: row.webhook_subscribed_at !== null,
    first_inbound: row.first_inbound_at !== null,
    first_outbound: row.first_outbound_at !== null,
  };
}

function statusOf(row: ConnectionRow): Readiness {
  return readinessOf({
    evidence: evidenceOf(row),
    disconnected: row.disconnected_at !== null,
    hasError: row.last_error_code !== null,
  });
}

async function readConnections(
  sql: SqlExecutor,
  connectionId: string | null,
): Promise<readonly ChannelConnectionSummary[]> {
  const rows = await sql.query<ConnectionRow>(
    `SELECT c.id::text, c.kind, c.display_name, c.external_asset_id,
            app.external_app_id AS provider_app_id, c.capabilities,
            c.asset_verified_at, c.credential_verified_at, c.webhook_subscribed_at,
            c.first_inbound_at, c.first_outbound_at, c.last_error_code, c.last_error_at,
            c.created_at, c.disconnected_at,
            (SELECT cr.fingerprint FROM channel_credentials cr
              WHERE cr.connection_id = c.id AND cr.status = 'active') AS credential_fingerprint
       FROM channel_connections c
       LEFT JOIN channel_apps app ON app.id = c.app_id
      WHERE ($1::uuid IS NULL OR c.id = $1)
      ORDER BY c.created_at`,
    [connectionId],
  );
  return rows.rows.map((row) => {
    const evidence = evidenceOf(row);
    return {
      id: row.id,
      kind: row.kind,
      provider: PROVIDER_OF[row.kind],
      display_name: row.display_name,
      external_asset_id: row.external_asset_id,
      provider_app_id: row.provider_app_id,
      status: statusOf(row),
      capabilities: capabilitiesFor(row.kind),
      evidence: [
        view('asset_verified', row.asset_verified_at),
        view('credential_verified', row.credential_verified_at),
        view('webhook_subscribed', row.webhook_subscribed_at),
        view('first_inbound', row.first_inbound_at),
        view('first_outbound', row.first_outbound_at),
      ],
      missing_evidence: missingEvidence(evidence),
      last_error_code: row.last_error_code,
      last_error_at: row.last_error_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      disconnected_at: row.disconnected_at?.toISOString() ?? null,
      credential_held: row.credential_fingerprint !== null,
      credential_fingerprint: row.credential_fingerprint,
    };
  });
}

async function resolveChannelApp(
  sql: SqlExecutor,
  provider: string,
  request: ConnectChannelRequest,
): Promise<string | null> {
  if (provider !== 'meta') return null;
  const byExternal = request.providerAppId !== null;
  const reference = request.providerAppId ?? request.appId;
  if (reference === null) {
    throw new ApiHttpError(422, 'channel_app_required', 'Choose the Meta App ID configured on this server.');
  }
  const rows = await sql.query<{ id: string }>(
    `SELECT id::text FROM channel_apps
      WHERE provider = $1 AND status = 'active'
        AND (CASE WHEN $2::boolean THEN external_app_id = $3 ELSE id = $3::uuid END)`,
    [provider, byExternal, reference],
  );
  const app = rows.rows[0];
  if (app === undefined) {
    throw new ApiHttpError(422, 'channel_app_not_configured', 'That Meta App ID is not configured on this server yet.');
  }
  return app.id;
}

function view(kind: string, at: Date | null): ChannelEvidenceView {
  return { kind, satisfied: at !== null, observed_at: at?.toISOString() ?? null };
}

/**
 * One message for both uniqueness failures.
 *
 * Whether the asset is held by this tenant or another one is deliberately
 * indistinguishable: the second answer would be a cross-tenant oracle.
 */
function assetTaken(): ApiHttpError {
  return new ApiHttpError(
    409,
    'asset_already_connected',
    'That provider asset is already connected.',
  );
}
