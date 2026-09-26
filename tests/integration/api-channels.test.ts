import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import type { ApiAdapters } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { ChannelDispatcherService } from '../../apps/api/src/channels/dispatcher.service.js';
import { ChannelNormalizationService } from '../../apps/api/src/channels/normalization.service.js';
import type { ProviderTemplate, TemplateFetchResult } from '../../apps/api/src/channels/channel-transport.js';
import { tickFor } from '../../apps/api/src/workers/worker-roles.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { ConnectionCheck, SendCommand, SendOutcome } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchMigrationPool,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The channel foundation against a real PostgreSQL with FORCE RLS.
 *
 * The path under test is the one the whole milestone is built around:
 *
 *   connect an asset → provider delivers a signed webhook → the tenant is
 *   resolved from the asset → the raw event is journaled → a normalized inbound
 *   event exists.
 *
 * Every step is proved with the properties that actually matter: a forged
 * signature is refused before anything is written, a forged tenant header is
 * ignored, a redelivered batch produces one effect, one bad element does not
 * lose its siblings, and one tenant cannot see or claim another's asset.
 *
 * **No provider is contacted.** The signatures are computed with the app secret
 * this test configures, which is exactly what the provider would do — that
 * makes the verification real. The *transport* is not configured, so every send
 * and every connection test refuses with `provider_not_connected`, which is the
 * honest state of this isolated test harness without provider transport.
 */

const BOOTSTRAP_TOKEN = 'channels-bootstrap-token-value-00000001';
const OWNER_PASSWORD = 'owner password for channel tests';
const MEMBER_PASSWORD = 'member password for channel tests';
const APP_SECRET = 'meta-app-secret-for-integration-tests';
const VERIFY_TOKEN = 'the-verify-token';
const CREDENTIAL_KEY = `v1:${Buffer.alloc(32, 11).toString('base64')}`;
const PHONE_ID = 'phone-15550001111';

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly names: DatabaseNames;
  readonly tenantId: string;
  readonly appId: string;
}

interface Browser {
  readonly cookie: string;
  readonly csrf: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Channels Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'channels-integration-hash-secret-0001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'channels-idempotency-secret-000001',
    CONVO_CREDENTIAL_KEYS: CREDENTIAL_KEY,
    CONVO_CHANNEL_SECRET_META_APP: APP_SECRET,
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(adapters: ApiAdapters = {}): Promise<Harness> {
  const names = await createScratchDatabase('convo_channels');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 6);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool, adapters);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;

  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'channels-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@channels.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;

  // The provider app is installation configuration. It is seeded through the
  // schema owner, not the runtime role, because the runtime role has only
  // SELECT on it — registering an app is an operations act, and the grants say
  // so rather than a comment saying so.
  const admin = scratchMigrationPool(names);
  let appId: string;
  try {
    const appRow = await admin.query<{ id: string }>(
      `INSERT INTO channel_apps
         (provider, external_app_id, secret_ref, secret_fingerprint, verify_token_hash, graph_version)
       VALUES ('meta', '100000000000001', 'META_APP', $1, $2, 'v21.0')
       RETURNING id::text`,
      [sha256(APP_SECRET), sha256(VERIFY_TOKEN)],
    );
    appId = appRow.rows[0]?.id as string;
  } finally {
    await admin.end();
  }
  return { app, pool, server, names, tenantId, appId };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function login(api: Harness, email: string, password: string): Promise<Browser> {
  const response = await api.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': 'CONVO channel test' },
    payload: { email, password },
  });
  expect(response.statusCode, `login ${email}`).toBe(200);
  const raw = response.headers['set-cookie'];
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrf =
    cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('convo_csrf='))
      ?.slice('convo_csrf='.length) ?? '';
  return { cookie, csrf };
}

async function send(
  api: Harness,
  browser: Browser,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
  key = `channel-${String(Math.random()).slice(2)}`,
): Promise<LightMyRequestResponse> {
  return api.server.inject({
    method,
    url: `/api/v1/tenants/${api.tenantId}${path}`,
    headers: {
      cookie: browser.cookie,
      'x-csrf-token': browser.csrf,
      'idempotency-key': key,
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A signed delivery, exactly as the provider would compose it. */
function deliver(
  api: Harness,
  body: unknown,
  options: { secret?: string; timestamp?: string; signature?: string } = {},
): Promise<LightMyRequestResponse> {
  const raw = JSON.stringify(body);
  const signature =
    options.signature ??
    `sha256=${createHmac('sha256', options.secret ?? APP_SECRET).update(raw).digest('hex')}`;
  return api.server.inject({
    method: 'POST',
    url: `/api/v1/webhooks/meta/${api.appId}`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      ...(options.timestamp === undefined ? {} : { 'x-hub-timestamp': options.timestamp }),
    },
    payload: raw,
  });
}

function messageDelivery(
  messages: readonly Record<string, unknown>[],
  phoneId = PHONE_ID,
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneId },
              messages,
            },
          },
        ],
      },
    ],
  };
}

/** A status receipt delivery, as the provider composes it. */
function statusDelivery(
  id: string,
  state: string,
  timestamp: string,
  recipient = '15559998888',
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_ID },
              statuses: [{ id, status: state, recipient_id: recipient, timestamp }],
            },
          },
        ],
      },
    ],
  };
}

function textMessage(
  id: string,
  body: string,
  from = '15559998888',
  timestamp = String(Math.floor(Date.now() / 1000)),
): Record<string, unknown> {
  return {
    id,
    from,
    // This fixture opens a provider reply window. A calendar date here turns
    // the suite red once it becomes older than the real 24-hour window.
    timestamp,
    type: 'text',
    text: { body },
  };
}

async function connect(api: Harness, browser: Browser, assetId = PHONE_ID) {
  return send(api, browser, 'POST', '/channels', {
    kind: 'whatsapp',
    externalAssetId: assetId,
    displayName: 'Enrollment line',
    accessToken: 'EAAGtestaccesstoken0001',
    appId: api.appId,
  });
}

/* --------------------------------------------------------------- lifecycle -- */

describe('channel connections', () => {
  let api: Harness;
  let owner: Browser;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('lists the catalogue before anything is connected, saying what is implemented', async () => {
    const response = await send(api, owner, 'GET', '/channels/catalogue');
    expect(response.statusCode).toBe(200);
    const entries = (response.json() as { data: { kind: string; implemented: boolean }[] }).data;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'whatsapp',
      'messenger',
      'instagram',
      'web_chat',
      'custom',
    ]);
    // Every kind now has an adapter, and each declares its own matrix.
    expect(entries.every((entry) => entry.implemented)).toBe(true);
  });

  it('gives each channel its own matrix rather than WhatsApp’s', async () => {
    const response = await send(api, owner, 'GET', '/channels/catalogue');
    const entries = (
      response.json() as {
        data: { kind: string; capabilities: Record<string, unknown> }[];
      }
    ).data;
    const byKind = new Map(entries.map((entry) => [entry.kind, entry.capabilities]));
    // The three differences that matter most, asserted through the API rather
    // than only in the domain unit tests.
    expect(byKind.get('instagram')?.['host']).toBe('graph.facebook.com');
    expect(byKind.get('whatsapp')?.['host']).toBe('graph.facebook.com');
    expect(byKind.get('whatsapp')?.['templates']).toBe(true);
    expect(byKind.get('messenger')?.['templates']).toBe(false);
    expect(byKind.get('instagram')?.['templates']).toBe(false);
    expect(byKind.get('messenger')?.['businessInitiated']).toBe(false);
    expect(byKind.get('web_chat')?.['windowHours']).toBeNull();
  });

  it('connects an asset without claiming it works', async () => {
    const response = await connect(api, owner, 'phone-lifecycle-1');
    expect(response.statusCode).toBe(201);
    const connection = (response.json() as { data: Record<string, unknown> }).data;

    // The single most important assertion in this file: a submitted form does
    // not produce a working channel.
    expect(connection['status']).toBe('authorization_needed');
    expect(connection['credential_held']).toBe(true);
    expect(connection['provider_app_id']).toBe('100000000000001');
    expect(connection['missing_evidence']).toEqual([
      'credential_verified',
      'webhook_subscribed',
      'first_inbound',
      'first_outbound',
    ]);
    // And the token is nowhere in the response, at any depth.
    expect(JSON.stringify(connection)).not.toContain('EAAGtestaccesstoken');
  });

  it('resolves the provider-facing Meta App ID and refuses an unconfigured one', async () => {
    const connected = await send(api, owner, 'POST', '/channels', {
      kind: 'whatsapp',
      externalAssetId: 'phone-provider-app-1',
      displayName: 'Provider app reference',
      accessToken: 'EAAGtestaccesstoken0001',
      providerAppId: '100000000000001',
    });
    expect(connected.statusCode, connected.body).toBe(201);
    expect((connected.json() as { data: { provider_app_id: string } }).data.provider_app_id).toBe('100000000000001');

    const unknown = await send(api, owner, 'POST', '/channels', {
      kind: 'whatsapp',
      externalAssetId: 'phone-provider-app-2',
      displayName: 'Unknown provider app',
      accessToken: 'EAAGtestaccesstoken0001',
      providerAppId: '999999999999999',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: { code: 'channel_app_not_configured' } });

    const absent = await send(api, owner, 'POST', '/channels', {
      kind: 'whatsapp',
      externalAssetId: 'phone-provider-app-3',
      displayName: 'Missing provider app',
      accessToken: 'EAAGtestaccesstoken0001',
    });
    expect(absent.statusCode).toBe(422);
    expect(absent.json()).toMatchObject({ error: { code: 'channel_app_required' } });

    const unknownInternal = await send(api, owner, 'POST', '/channels', {
      kind: 'whatsapp',
      externalAssetId: 'phone-provider-app-4',
      displayName: 'Unknown internal app',
      accessToken: 'EAAGtestaccesstoken0001',
      appId: '99999999-9999-4999-8999-999999999999',
    });
    expect(unknownInternal.statusCode).toBe(422);
    expect(unknownInternal.json()).toMatchObject({ error: { code: 'channel_app_not_configured' } });
  });

  it('connects a self-owned channel without a Meta app reference', async () => {
    const response = await send(api, owner, 'POST', '/channels', {
      kind: 'web_chat',
      externalAssetId: 'website-widget-1',
      displayName: 'Website chat',
      accessToken: 'website-signing-key-0001',
      settings: { origins: ['https://school.example'], ratePerMinute: 120 },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      data: { kind: 'web_chat', provider_app_id: null, credential_held: true },
    });
  });

  it('never returns or stores the token in readable form', async () => {
    const stored = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ ciphertext: Buffer; fingerprint: string }>(
        `SELECT ciphertext, fingerprint FROM channel_credentials WHERE status = 'active' LIMIT 1`,
      ),
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    expect(row?.ciphertext.toString('utf8')).not.toContain('EAAG');
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays an identical connect and refuses a different one under the same key', async () => {
    const key = 'connect-idempotency-key';
    const first = await send(
      api,
      owner,
      'POST',
      '/channels',
      {
        kind: 'whatsapp',
        externalAssetId: 'phone-idem-1',
        displayName: 'Idempotent',
        accessToken: 'EAAGtestaccesstoken0002',
        appId: api.appId,
      },
      key,
    );
    expect(first.statusCode).toBe(201);
    const replay = await send(
      api,
      owner,
      'POST',
      '/channels',
      {
        kind: 'whatsapp',
        externalAssetId: 'phone-idem-1',
        displayName: 'Idempotent',
        accessToken: 'EAAGtestaccesstoken0002',
        appId: api.appId,
      },
      key,
    );
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { data: { id: string } }).data.id).toBe(
      (first.json() as { data: { id: string } }).data.id,
    );

    const different = await send(
      api,
      owner,
      'POST',
      '/channels',
      {
        kind: 'whatsapp',
        externalAssetId: 'phone-idem-2',
        displayName: 'Different',
        accessToken: 'EAAGtestaccesstoken0003',
        appId: api.appId,
      },
      key,
    );
    expect(different.statusCode).toBe(409);
    expect(different.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('refuses a second connection for an asset already claimed', async () => {
    const first = await connect(api, owner, 'phone-contested-1');
    expect(first.statusCode).toBe(201);
    const second = await connect(api, owner, 'phone-contested-1');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'asset_already_connected' } });
  });

  it('keeps 100 distinct Meta assets separate without claiming provider readiness', async () => {
    const kinds = ['whatsapp', 'messenger', 'instagram'] as const;
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const kind = kinds[index % kinds.length] as (typeof kinds)[number];
      const response = await send(api, owner, 'POST', '/channels', {
        kind,
        externalAssetId: `synthetic-asset-${String(index)}`,
        displayName: `Synthetic ${kind} ${String(index)}`,
        accessToken: `synthetic-test-token-${String(index).padStart(3, '0')}`,
        appId: api.appId,
        ...(kind === 'instagram' ? { settings: { facebookPageId: String(100000000000000 + index) } } : {}),
      });
      expect(response.statusCode, `asset ${String(index)}`).toBe(201);
      const connection = (response.json() as { data: { id: string; status: string } }).data;
      expect(connection.status).toBe('authorization_needed');
      ids.add(connection.id);
    }

    const listed = await send(api, owner, 'GET', '/channels');
    expect(listed.statusCode).toBe(200);
    const synthetic = (listed.json() as {
      data: { id: string; kind: string; external_asset_id: string; status: string }[];
    }).data.filter((connection) => connection.external_asset_id.startsWith('synthetic-asset-'));
    expect(ids.size).toBe(100);
    expect(synthetic).toHaveLength(100);
    expect(new Set(synthetic.map((connection) => connection.external_asset_id)).size).toBe(100);
    expect(synthetic.every((connection) => connection.status === 'authorization_needed')).toBe(true);
    for (const kind of kinds) {
      expect(synthetic.some((connection) => connection.kind === kind)).toBe(true);
    }
  });

  it('reports a connection test honestly when no provider transport is configured', async () => {
    const created = await connect(api, owner, 'phone-test-1');
    const id = (created.json() as { data: { id: string } }).data.id;

    const tested = await send(api, owner, 'POST', `/channels/${id}/test`);
    expect(tested.statusCode).toBe(200);
    const connection = (tested.json() as { data: Record<string, unknown> }).data;
    // Not "connected", not a fabricated success: the state names exactly why.
    expect(connection['last_error_code']).toBe('provider_not_connected');
    expect(connection['status']).toBe('authorization_needed');
  });

  it('rotates a credential, superseding the old version and clearing verification', async () => {
    const created = await connect(api, owner, 'phone-rotate-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    const before = (created.json() as { data: { credential_fingerprint: string } }).data
      .credential_fingerprint;

    const rotated = await send(api, owner, 'POST', `/channels/${id}/credential`, {
      accessToken: 'EAAGrotatedtoken0001',
    });
    expect(rotated.statusCode).toBe(200);
    const after = (rotated.json() as { data: { credential_fingerprint: string } }).data
      .credential_fingerprint;
    expect(after).not.toBe(before);

    // Superseded, not deleted: a credential in flight during the rotation can
    // still be identified afterwards.
    const versions = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number; status: string }>(
        `SELECT version, status FROM channel_credentials
          WHERE connection_id = $1 ORDER BY version`,
        [id],
      ),
    );
    expect(versions.rows).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'active' },
    ]);
  });

  it('contains the blast radius of a disconnect', async () => {
    const kept = await connect(api, owner, 'phone-kept-1');
    const dropped = await connect(api, owner, 'phone-dropped-1');
    const keptId = (kept.json() as { data: { id: string } }).data.id;
    const droppedId = (dropped.json() as { data: { id: string } }).data.id;

    const response = await send(api, owner, 'DELETE', `/channels/${droppedId}`);
    expect(response.statusCode).toBe(204);

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string; status: string }>(
        `SELECT connection_id::text, status FROM channel_credentials
          WHERE connection_id IN ($1, $2) AND version = 1`,
        [keptId, droppedId],
      ),
    );
    const byConnection = new Map(rows.rows.map((row) => [row.connection_id, row.status]));
    expect(byConnection.get(droppedId)).toBe('revoked');
    // The other connection is untouched (CH-05).
    expect(byConnection.get(keptId)).toBe('active');

    // The asset claim is released, so the number can be connected again.
    const again = await connect(api, owner, 'phone-dropped-1');
    expect(again.statusCode).toBe(201);
  });

  it('treats a second disconnect as already done', async () => {
    const created = await connect(api, owner, 'phone-twice-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    expect((await send(api, owner, 'DELETE', `/channels/${id}`)).statusCode).toBe(204);
    expect((await send(api, owner, 'DELETE', `/channels/${id}`)).statusCode).toBe(204);
  });

  it('records a missing credential rather than reporting the connection healthy', async () => {
    const created = await connect(api, owner, 'phone-nocred-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    // Revoked out from under the connection, as a provider-side revocation or a
    // partial disconnect would leave it.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE channel_credentials SET status = 'revoked', revoked_at = now() WHERE connection_id = $1`,
        [id],
      ),
    );
    const tested = await send(api, owner, 'POST', `/channels/${id}/test`);
    expect((tested.json() as { data: { last_error_code: string } }).data.last_error_code).toBe(
      'credential_missing',
    );
  });

  it('rejects a malformed rotation before it touches the connection', async () => {
    const created = await connect(api, owner, 'phone-badrotate-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    const response = await send(api, owner, 'POST', `/channels/${id}/credential`, { accessToken: '' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('reports a disconnected connection as disconnected, with its timestamp', async () => {
    const created = await connect(api, owner, 'phone-listed-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    await send(api, owner, 'DELETE', `/channels/${id}`);

    const listed = await send(api, owner, 'GET', '/channels');
    const rows = (listed.json() as { data: { id: string; status: string; disconnected_at: string | null }[] })
      .data;
    const row = rows.find((entry) => entry.id === id);
    expect(row?.status).toBe('disconnected');
    expect(row?.disconnected_at).not.toBeNull();
    // Kept in the list rather than hidden: the connection and its history are
    // evidence, and an operator needs to see that it was taken out of service.
    expect(rows.length).toBeGreaterThan(1);
  });

  it('answers an unknown connection with the same 404 a stranger gets', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await send(api, owner, 'POST', `/channels/${missing}/test`)).statusCode).toBe(404);
    expect((await send(api, owner, 'DELETE', `/channels/${missing}`)).statusCode).toBe(404);
  });

  it.each([
    ['a missing body', {}],
    ['an unknown kind', { kind: 'telegram', externalAssetId: 'x', displayName: 'x', accessToken: 'aaaaaaaa' }],
  ])('rejects %s', async (_label, payload) => {
    const response = await send(api, owner, 'POST', '/channels', payload);
    expect(response.statusCode).toBe(400);
  });

  it('accepts an ordinary API request with an empty body', async () => {
    // The webhook parser also serves every other route. An empty body there is
    // "no body", not a parse failure.
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/channels`,
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'idempotency-key': 'empty-body',
        'content-type': 'application/json',
      },
      payload: '',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('rejects an ordinary API request whose body is not JSON', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/channels`,
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'idempotency-key': 'bad-body',
        'content-type': 'application/json',
      },
      payload: '{oh no',
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires an idempotency key to connect', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/channels`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: { kind: 'whatsapp', externalAssetId: 'x', displayName: 'x', accessToken: 'aaaaaaaa' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
  });
});

/* ------------------------------------------------------------ authorization -- */

describe('channel authorization', () => {
  let api: Harness;
  let owner: Browser;
  let agent: Browser;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
    const user = await api.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id::text`,
      ['agent@channels.test', hash],
    );
    await withTenant(api.pool, api.tenantId, async (client) => {
      const role = await client.query<{ id: string }>(
        `SELECT id::text FROM roles WHERE key = 'agent'`,
      );
      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [api.tenantId, user.rows[0]?.id, role.rows[0]?.id],
      );
    });
    agent = await login(api, 'agent@channels.test', MEMBER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('denies an Agent every channel operation, by key', async () => {
    // An Agent holds no `channel.manage`, so the server refuses regardless of
    // what any UI chose to render.
    expect((await send(api, agent, 'GET', '/channels')).statusCode).toBe(403);
    expect((await send(api, agent, 'GET', '/channels/catalogue')).statusCode).toBe(403);
    expect((await connect(api, agent, 'phone-denied-1')).statusCode).toBe(403);
  });

  it('separates rotating a credential from managing a channel', async () => {
    const created = await connect(api, owner, 'phone-perm-1');
    const id = (created.json() as { data: { id: string } }).data.id;
    const response = await send(api, agent, 'POST', `/channels/${id}/credential`, {
      accessToken: 'EAAGrotate0002',
    });
    expect(response.statusCode).toBe(403);
  });

  it('requires CSRF on every mutation', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/channels`,
      headers: { cookie: owner.cookie, 'idempotency-key': 'no-csrf' },
      payload: { kind: 'whatsapp', externalAssetId: 'x', displayName: 'x', accessToken: 'aaaaaaaa' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('conceals another tenant behind the same 404 non-membership gives', async () => {
    const stranger = '88888888-8888-4888-8888-888888888888';
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${stranger}/channels`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ---------------------------------------------------------------- ingress -- */

describe('webhook ingress', () => {
  let api: Harness;
  let owner: Browser;
  let connectionId: string;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    const created = await connect(api, owner);
    expect(created.statusCode).toBe(201);
    connectionId = (created.json() as { data: { id: string } }).data.id;
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('answers the subscription challenge with the token it holds', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/webhooks/meta/${api.appId}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('12345');
  });

  it.each([
    ['a wrong verify token', `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`],
    ['a wrong mode', `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`],
  ])('refuses the challenge with %s', async (_label, query) => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/webhooks/meta/${api.appId}?${query}`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a delivery to an unknown app the way an unknown route answers', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/webhooks/meta/99999999-9999-4999-8999-999999999999?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('accepts a signed delivery and journals it before answering', async () => {
    const response = await deliver(api, messageDelivery([textMessage('wamid.first', 'مرحبا')]));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'received', stored: 1, duplicates: 0 });

    const events = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ dedupe_key: string; status: string; payload: Record<string, unknown> }>(
        `SELECT dedupe_key, status, payload FROM channel_events WHERE dedupe_key = 'wa:msg:wamid.first'`,
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.status).toBe('received');
    // The provider's own element is what was journaled — the evidence, not our
    // interpretation of it.
    expect(events.rows[0]?.payload).toMatchObject({ id: 'wamid.first', type: 'text' });

    // Receiving is itself evidence, and only the ingress can observe it.
    const connection = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ first_inbound_at: Date | null; webhook_subscribed_at: Date | null }>(
        'SELECT first_inbound_at, webhook_subscribed_at FROM channel_connections WHERE id = $1',
        [connectionId],
      ),
    );
    expect(connection.rows[0]?.first_inbound_at).not.toBeNull();
    expect(connection.rows[0]?.webhook_subscribed_at).not.toBeNull();
  });

  it('refuses an altered body, and writes nothing but a receipt', async () => {
    const body = messageDelivery([textMessage('wamid.tampered', 'original')]);
    const signature = `sha256=${createHmac('sha256', APP_SECRET).update(JSON.stringify(body)).digest('hex')}`;
    // The signature is over the original bytes; the body sent is one byte
    // different. This is EVT-01.
    const tampered = messageDelivery([textMessage('wamid.tampered', 'originaL')]);
    const response = await deliver(api, tampered, { signature });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'mismatch' });
    const events = await withTenant(api.pool, api.tenantId, (client) =>
      client.query(`SELECT 1 FROM channel_events WHERE dedupe_key = 'wa:msg:wamid.tampered'`),
    );
    expect(events.rows).toHaveLength(0);

    const receipts = await api.pool.query<{ outcome: string; signature_valid: boolean }>(
      `SELECT outcome, signature_valid FROM webhook_receipts
        WHERE outcome = 'signature_invalid' ORDER BY received_at DESC LIMIT 1`,
    );
    // The refusal is still evidence: an operator can see that bytes arrived.
    expect(receipts.rows[0]).toMatchObject({ outcome: 'signature_invalid', signature_valid: false });
  });

  it('refuses a delivery signed with another secret', async () => {
    const response = await deliver(api, messageDelivery([textMessage('wamid.wrongsecret', 'x')]), {
      secret: 'not-the-app-secret-at-all-0000000001',
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a replayed delivery outside the window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await deliver(api, messageDelivery([textMessage('wamid.replay', 'x')]), {
      timestamp: stale,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'stale' });
  });

  it('ignores a forged tenant header and routes only by the verified asset', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    const raw = JSON.stringify(messageDelivery([textMessage('wamid.forged', 'x')]));
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${api.appId}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
        // Every shape a caller might hope is authority.
        'x-tenant-id': other,
        'x-convo-tenant': other,
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);

    const routed = await api.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id::text FROM webhook_receipts WHERE outcome = 'routed' ORDER BY received_at DESC LIMIT 1`,
    );
    // The tenant came from the asset in the payload, not from a header (DEL-02).
    expect(routed.rows[0]?.tenant_id).toBe(api.tenantId);
  });

  it('acknowledges a verified delivery for an asset nobody has connected, and keeps no content', async () => {
    const response = await deliver(
      api,
      messageDelivery([textMessage('wamid.stranger', 'secret')], 'phone-not-connected'),
    );
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ reason: 'unknown_asset' });

    const receipts = await api.pool.query<{ outcome: string; tenant_id: string | null }>(
      `SELECT outcome, tenant_id::text FROM webhook_receipts
        WHERE outcome = 'unknown_asset' ORDER BY received_at DESC LIMIT 1`,
    );
    expect(receipts.rows[0]).toMatchObject({ outcome: 'unknown_asset', tenant_id: null });
    // No message content is retained for an asset this installation does not
    // know: that is somebody else's customer.
    const stored = await api.pool.query(
      `SELECT 1 FROM channel_events WHERE dedupe_key = 'wa:msg:wamid.stranger'`,
    );
    expect(stored.rows).toHaveLength(0);
  });

  it('absorbs a redelivery, in either order, as one effect', async () => {
    const first = textMessage('wamid.dup-a', 'first');
    const second = textMessage('wamid.dup-b', 'second');

    const original = await deliver(api, messageDelivery([first, second]));
    expect(original.json()).toMatchObject({ stored: 2, duplicates: 0 });

    // The provider redelivers the same facts with the batch reordered (EVT-02).
    const redelivered = await deliver(api, messageDelivery([second, first]));
    expect(redelivered.statusCode).toBe(200);
    expect(redelivered.json()).toMatchObject({ stored: 0, duplicates: 2 });

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `SELECT 1 FROM channel_events WHERE dedupe_key IN ('wa:msg:wamid.dup-a', 'wa:msg:wamid.dup-b')`,
      ),
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('keeps a message and a status about it as separate facts', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.status-1', 'hello')]));
    const statuses = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                statuses: [
                  {
                    id: 'wamid.status-1',
                    status: 'delivered',
                    recipient_id: '15559998888',
                    timestamp: '1789000001',
                  },
                  {
                    id: 'wamid.status-1',
                    status: 'read',
                    recipient_id: '15559998888',
                    timestamp: '1789000002',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const response = await deliver(api, statuses);
    // Two statuses about a message that already exists: three rows in total,
    // none of them suppressing another.
    expect(response.json()).toMatchObject({ stored: 2, duplicates: 0 });
  });

  it('stores a poison element beside its siblings instead of losing the batch', async () => {
    const response = await deliver(
      api,
      messageDelivery([
        textMessage('wamid.good-1', 'first'),
        { from: 'nobody', type: 'text', text: { body: 'no id' } },
        textMessage('wamid.good-2', 'third'),
      ]),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stored: 3 });

    const quarantined = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ quarantine_reason: string; payload: Record<string, unknown> }>(
        `SELECT quarantine_reason, payload FROM channel_events WHERE status = 'quarantined'`,
      ),
    );
    expect(quarantined.rows.some((row) => row.quarantine_reason === 'message_missing_id_or_sender')).toBe(
      true,
    );
    // Its payload is kept intact, so it can be diagnosed and replayed.
    expect(
      quarantined.rows.find((row) => row.quarantine_reason === 'message_missing_id_or_sender')
        ?.payload,
    ).toMatchObject({ from: 'nobody' });

    const good = await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `SELECT 1 FROM channel_events WHERE dedupe_key IN ('wa:msg:wamid.good-1', 'wa:msg:wamid.good-2')`,
      ),
    );
    expect(good.rows).toHaveLength(2);
  });

  it('absorbs a redelivered poison element too', async () => {
    const poison = messageDelivery([
      textMessage('wamid.poison-1', 'first'),
      { from: 'twice', type: 'text', text: { body: 'no id' } },
    ]);
    const first = await deliver(api, poison);
    expect(first.json()).toMatchObject({ stored: 2, duplicates: 0 });
    // The quarantine key is content-addressed, so redelivering the same broken
    // element does not pile up rows.
    const second = await deliver(api, poison);
    expect(second.json()).toMatchObject({ stored: 0, duplicates: 2 });
  });

  it('quarantines a null element in a messages array', async () => {
    const response = await deliver(api, messageDelivery([null as unknown as Record<string, unknown>]));
    expect(response.statusCode).toBe(200);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ payload: unknown }>(
        `SELECT payload FROM channel_events
          WHERE status = 'quarantined' AND quarantine_reason = 'message_missing_id_or_sender'
            AND payload = 'null'::jsonb`,
      ),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a delivery whose content type we do not parse', async () => {
    // The parser never runs, so there are no bytes to verify, and the signature
    // check refuses on a mismatch rather than on a crash.
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${api.appId}`,
      headers: {
        'content-type': 'text/plain',
        'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
      },
      payload: 'not json at all',
    });
    expect([401, 415]).toContain(response.statusCode);
  });

  it('acknowledges a verified delivery with nothing addressable in it', async () => {
    const response = await deliver(api, { object: 'page', entry: [] });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ reason: 'no_asset_in_payload' });
  });

  it('refuses an unparsable body from a verified sender', async () => {
    const raw = '{not json';
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${api.appId}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: 'malformed_body' });
  });

  it('refuses a delivery on a route key that is not an id at all', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/meta/not-a-uuid',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` },
      payload: '{}',
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers a retryable 503 when our own app secret is not configured', async () => {
    // The delivery is real and worth keeping. Silently 200-ing it would lose a
    // customer's message over a configuration mistake of ours.
    const admin = scratchMigrationPool(api.names);
    let strayApp: string;
    try {
      const row = await admin.query<{ id: string }>(
        `INSERT INTO channel_apps
           (provider, external_app_id, secret_ref, secret_fingerprint, verify_token_hash, graph_version)
         VALUES ('meta', '200000000000002', 'UNCONFIGURED_APP', $1, $2, 'v21.0')
         RETURNING id::text`,
        [sha256('x'), sha256('y')],
      );
      strayApp = row.rows[0]?.id as string;
    } finally {
      await admin.end();
    }
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${strayApp}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` },
      payload: '{}',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'channel_secret_unavailable' } });
  });

  it('refuses a delivery with an empty body', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${api.appId}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update('').digest('hex')}`,
      },
      payload: '',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a delivery with no signature at all', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/meta/${api.appId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(messageDelivery([textMessage('wamid.nosig', 'x')])),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'missing_header' });
  });
});

/* --------------------------------------------------- a stubbed transport -- */

describe('with a stubbed provider transport', () => {
  /**
   * A **stub**, not a provider and not a simulator of one.
   *
   * It exists to exercise our own success and failure handling, which is
   * otherwise unreachable while no authorized Meta assets exist. It never
   * produces a message id, never claims a send happened, and is bound only
   * inside this test. Nothing in the shipped composition root has a transport.
   */
  let api: Harness;
  let owner: Browser;
  let answer: ConnectionCheck;
  let checkedInstagramPageId: string | null | undefined;
  let templatesAnswer: TemplateFetchResult = { ok: true, templates: [] };

  beforeAll(async () => {
    api = await createHarness({
      channelTransport: {
        name: 'test-stub',
        validateConnection: (kind, _credential, _assetIdentity, facebookPageId) => {
          if (kind === 'instagram') checkedInstagramPageId = facebookPageId;
          return Promise.resolve(answer);
        },
        fetchTemplates: () => Promise.resolve(templatesAnswer),
        send: () =>
          Promise.resolve({
            status: 'definitely_rejected' as const,
            code: 'stub',
            message: 'This stub never sends.',
            retryable: false,
          }),
      },
    });
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('records credential verification only when the provider says yes', async () => {
    const created = await connect(api, owner, 'phone-stub-ok');
    const id = (created.json() as { data: { id: string } }).data.id;

    answer = { ok: true, assetIdentity: 'phone-stub-ok', code: null, message: null };
    const tested = await send(api, owner, 'POST', `/channels/${id}/test`);
    const connection = (tested.json() as { data: Record<string, unknown> }).data;
    expect(connection['last_error_code']).toBeNull();
    // Verified, and still not healthy: no webhook has arrived yet, and each
    // piece of evidence is earned separately (CH-02).
    expect(connection['status']).toBe('webhook_pending');
    expect(connection['missing_evidence']).toEqual([
      'webhook_subscribed',
      'first_inbound',
      'first_outbound',
    ]);
  });

  it('binds an existing Instagram connection only after verifying the linked Page', async () => {
    const created = await send(api, owner, 'POST', '/channels', {
      kind: 'instagram', externalAssetId: '17841470000000001', displayName: 'Test Instagram',
      accessToken: 'EAAGtestaccesstoken0001', appId: api.appId,
      settings: { facebookPageId: '483612900000001' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;

    answer = { ok: false, assetIdentity: null, code: 'asset_mismatch', message: 'Wrong Page.' };
    const rejected = await send(api, owner, 'POST', `/channels/${id}/instagram-page`, { facebookPageId: '483612900000002' });
    expect(rejected.statusCode).toBe(422);
    expect(checkedInstagramPageId).toBe('483612900000002');
    const unchanged = await send(api, owner, 'GET', '/channels');
    const before = (unchanged.json() as { data: Array<{ id: string; facebook_page_id: string }> }).data.find((item) => item.id === id);
    expect(before?.facebook_page_id).toBe('483612900000001');

    answer = { ok: false, assetIdentity: null, code: null, message: null };
    const unnamedRefusal = await send(api, owner, 'POST', `/channels/${id}/instagram-page`, { facebookPageId: '483612900000002' });
    expect(unnamedRefusal.statusCode).toBe(422);

    await withTenant(api.pool, api.tenantId, (client) => client.query(
      `UPDATE channel_credentials SET status='revoked', revoked_at=now() WHERE connection_id=$1 AND status='active'`, [id],
    ));
    const noCredential = await send(api, owner, 'POST', `/channels/${id}/instagram-page`, { facebookPageId: '483612900000002' });
    expect(noCredential.statusCode).toBe(422);
    const rotated = await send(api, owner, 'POST', `/channels/${id}/credential`, { accessToken: 'EAAGtestaccesstoken0002' });
    expect(rotated.statusCode).toBe(200);

    answer = { ok: true, assetIdentity: '17841470000000001', code: null, message: null };
    const verified = await send(api, owner, 'POST', `/channels/${id}/instagram-page`, { facebookPageId: '483612900000003' });
    expect(verified.statusCode, verified.body).toBe(201);
    expect(checkedInstagramPageId).toBe('483612900000003');
    expect((verified.json() as { data: { facebook_page_id: string } }).data.facebook_page_id).toBe('483612900000003');

    const malformed = await send(api, owner, 'POST', `/channels/${id}/instagram-page`, { facebookPageId: 'not-an-id' });
    expect(malformed.statusCode).toBe(400);
    // A pre-upgrade Instagram row can have inbound evidence but no Page-bound
    // outbound configuration. The API must not still call it healthy.
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      `UPDATE channel_connections SET settings = settings - 'facebook_page_id' WHERE id = $1`, [id],
    ));
    const legacy = await send(api, owner, 'GET', '/channels');
    const unbound = (legacy.json() as { data: Array<{ id: string; status: string; last_error_code: string }> }).data.find((item) => item.id === id);
    expect(unbound).toMatchObject({ status: 'degraded', last_error_code: 'instagram_page_required' });
    const whatsapp = await connect(api, owner, 'phone-stub-instagram-page');
    const whatsappId = (whatsapp.json() as { data: { id: string } }).data.id;
    expect((await send(api, owner, 'POST', `/channels/${whatsappId}/instagram-page`, { facebookPageId: '483612900000003' })).statusCode).toBe(404);
  });

  it('falls back to a generic code when the provider refuses without naming one', async () => {
    const created = await connect(api, owner, 'phone-stub-bad');
    const id = (created.json() as { data: { id: string } }).data.id;

    answer = { ok: false, assetIdentity: null, code: null, message: null };
    const tested = await send(api, owner, 'POST', `/channels/${id}/test`);
    expect((tested.json() as { data: { last_error_code: string } }).data.last_error_code).toBe(
      'provider_rejected',
    );
  });

  it('degrades a connection that worked and then stopped', async () => {
    const created = await connect(api, owner, 'phone-stub-degrade');
    const id = (created.json() as { data: { id: string } }).data.id;

    answer = { ok: true, assetIdentity: 'phone-stub-degrade', code: null, message: null };
    await send(api, owner, 'POST', `/channels/${id}/test`);
    answer = { ok: false, assetIdentity: null, code: 'token_expired', message: 'Expired.' };
    const again = await send(api, owner, 'POST', `/channels/${id}/test`);

    const connection = (again.json() as { data: Record<string, unknown> }).data;
    // Degraded, not "webhook_pending": it was authorized and then broke, and
    // telling an operator to keep waiting would be the wrong instruction.
    expect(connection['status']).toBe('degraded');
    expect(connection['last_error_code']).toBe('token_expired');
  });

  it('synchronizes the remote template catalogue and disables removed entries', async () => {
    const created = await connect(api, owner, 'phone-stub-templates');
    const id = (created.json() as { data: { id: string } }).data.id;
    templatesAnswer = { ok: true, templates: [
      { providerId: 'provider-template-1', name: 'welcome', language: 'ar', category: 'utility', status: 'approved', components: [{ type: 'BODY', text: 'Hi {{1}}' }], variables: ['{{1}}'] },
    ] };
    const first = await send(api, owner, 'POST', `/channels/${id}/templates/sync`);
    expect(first.statusCode, first.body).toBe(201);
    expect((first.json() as { data: { imported: number; disabled: number } }).data).toMatchObject({ imported: 1, disabled: 0 });
    templatesAnswer = { ok: true, templates: [] };
    const second = await send(api, owner, 'POST', `/channels/${id}/templates/sync`);
    expect((second.json() as { data: { imported: number; disabled: number } }).data).toMatchObject({ imported: 0, disabled: 1 });
  });

  it('records typed provider failures and refuses unsupported template connections', async () => {
    const created = await connect(api, owner, 'phone-stub-template-failure');
    const id = (created.json() as { data: { id: string } }).data.id;
    templatesAnswer = { ok: false, code: 'provider_timeout', message: 'Timeout.', retryable: true };
    expect((await send(api, owner, 'POST', `/channels/${id}/templates/sync`)).statusCode).toBe(503);
    const listed = await send(api, owner, 'GET', '/channels');
    const failed = (listed.json() as { data: Array<{ id: string; last_error_code: string | null }> }).data.find((item) => item.id === id);
    expect(failed?.last_error_code).toBe('provider_timeout');
    templatesAnswer = { ok: false, code: 'credential_rejected', message: 'Rejected.', retryable: false };
    expect((await send(api, owner, 'POST', `/channels/${id}/templates/sync`)).statusCode).toBe(422);

    const missing = await connect(api, owner, 'phone-stub-template-missing');
    const missingId = (missing.json() as { data: { id: string } }).data.id;
    await withTenant(api.pool, api.tenantId, (client) => client.query(`UPDATE channel_credentials SET status='revoked',revoked_at=now() WHERE connection_id=$1`, [missingId]));
    expect((await send(api, owner, 'POST', `/channels/${missingId}/templates/sync`)).statusCode).toBe(409);

    const web = await send(api, owner, 'POST', '/channels', {
      kind: 'web_chat', externalAssetId: 'widget-template-test', displayName: 'Widget', accessToken: 'signing-key-value', settings: { origins: ['https://school.example'] },
    });
    const webId = (web.json() as { data: { id: string } }).data.id;
    expect((await send(api, owner, 'POST', `/channels/${webId}/templates/sync`)).statusCode).toBe(422);
  });
});

/* ---------------------------------------------------------- normalization -- */

describe('normalization', () => {
  let api: Harness;
  let owner: Browser;
  let normalizer: ChannelNormalizationService;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    expect((await connect(api, owner)).statusCode).toBe(201);
    normalizer = api.app.get(ChannelNormalizationService);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('turns a journaled event into a normalized inbound event', async () => {
    await deliver(
      api,
      messageDelivery([textMessage('wamid.norm-1', 'مرحبا بالعالم', '15559998888', '1789000000')]),
    );

    expect(await normalizer.pendingTenants()).toContain(api.tenantId);
    const result = await normalizer.drain(api.tenantId);
    expect(result.projected).toBeGreaterThan(0);

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{
        kind: string;
        provider_message_id: string;
        peer_identity: string;
        asset_identity: string;
        text_body: string;
        occurred_at: Date;
      }>(
        `SELECT kind, provider_message_id, peer_identity, asset_identity, text_body, occurred_at
           FROM inbound_events WHERE provider_message_id = 'wamid.norm-1'`,
      ),
    );
    expect(rows.rows[0]).toMatchObject({
      kind: 'message',
      peer_identity: '15559998888',
      asset_identity: PHONE_ID,
      text_body: 'مرحبا بالعالم',
    });
    // The provider's time, not ours: both are stored and they disagree.
    expect(rows.rows[0]?.occurred_at.toISOString()).toBe('2026-09-10T00:26:40.000Z');
  });

  it('is idempotent: a second drain adds nothing', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.norm-2', 'once')]));
    await normalizer.drain(api.tenantId);
    const after = await normalizer.drain(api.tenantId);
    expect(after.claimed).toBe(0);

    const count = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_events WHERE provider_message_id = 'wamid.norm-2'`,
      ),
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('projects an out-of-order read before its delivered without folding them', async () => {
    const statuses = (state: string, timestamp: string) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                statuses: [
                  { id: 'wamid.order-1', status: state, recipient_id: '1555', timestamp },
                ],
              },
            },
          ],
        },
      ],
    });

    // `read` arrives first, `delivered` second — the anomaly ADR-0006 names.
    await deliver(api, statuses('read', '1789000005'));
    await deliver(api, statuses('delivered', '1789000004'));
    await normalizer.drain(api.tenantId);

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ kind: string; occurred_at: Date }>(
        `SELECT kind, occurred_at FROM inbound_events
          WHERE provider_message_id = 'wamid.order-1' ORDER BY occurred_at`,
      ),
    );
    // Two independent rows. Nothing was overwritten, and the later provider
    // timestamp still belongs to `read`.
    expect(rows.rows.map((row) => row.kind)).toEqual(['delivery_status', 'read_status']);
  });

  it('marks a drained event so it is not claimed twice', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.norm-3', 'drain me')]));
    await normalizer.drain(api.tenantId);
    const states = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ status: string; processed_at: Date | null }>(
        `SELECT status, processed_at FROM channel_events WHERE dedupe_key = 'wa:msg:wamid.norm-3'`,
      ),
    );
    expect(states.rows[0]?.status).toBe('normalized');
    expect(states.rows[0]?.processed_at).not.toBeNull();
  });

  it('reports an already-projected event on a deliberate replay', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.replay-1', 'again')]));
    await normalizer.drain(api.tenantId);

    // An operator replaying a batch re-queues the event. The projection is
    // keyed on its source, so the replay converges rather than duplicating.
    const eventId = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT id::text FROM channel_events WHERE dedupe_key = 'wa:msg:wamid.replay-1'`,
      ),
    );
    await api.pool.query(
      `INSERT INTO channel_event_queue (event_id, tenant_id) VALUES ($1, $2)`,
      [eventId.rows[0]?.id, api.tenantId],
    );

    const result = await normalizer.drain(api.tenantId);
    expect(result).toMatchObject({ claimed: 1, projected: 0, alreadyProjected: 1, failed: 0 });
    const count = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_events WHERE provider_message_id = 'wamid.replay-1'`,
      ),
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('keeps queued work it cannot read, rather than dropping it', async () => {
    // A queue row pointing at an event this context cannot see — what a
    // cascade delete or a routing bug would leave behind. Deleting it silently
    // is how an inbox loses a message.
    const orphan = randomUUID();
    await api.pool.query(
      `INSERT INTO channel_event_queue (event_id, tenant_id) VALUES ($1, $2)`,
      [orphan, api.tenantId],
    );
    const result = await normalizer.drain(api.tenantId);
    expect(result.failed).toBeGreaterThan(0);

    const row = await api.pool.query<{ attempts: number; last_error: string; lease_until: Date | null }>(
      `SELECT attempts, last_error, lease_until FROM channel_event_queue WHERE event_id = $1`,
      [orphan],
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, last_error: 'event_not_visible' });
    // The lease is released so a later attempt can pick it up again.
    expect(row.rows[0]?.lease_until).toBeNull();
    await api.pool.query('DELETE FROM channel_event_queue WHERE event_id = $1', [orphan]);
  });

  it('leaves a quarantined element out of the normalized projection', async () => {
    await deliver(
      api,
      messageDelivery([{ from: 'nobody', type: 'text', text: { body: 'no id' } }]),
    );
    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_events WHERE peer_identity = 'nobody'`,
      ),
    );
    // Kept as evidence in `channel_events`, absent from the inbox projection.
    expect(rows.rows[0]?.count).toBe('0');
  });
});

/* ------------------------------------------------------- tenant isolation -- */

describe('channel tenant isolation', () => {
  let api: Harness;
  let owner: Browser;
  let otherTenant: string;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    expect((await connect(api, owner)).statusCode).toBe(201);
    // A second company, created the way the runtime role must: inside its own
    // tenant context, so the row it writes is the row RLS lets it write.
    otherTenant = randomUUID();
    await withTenant(api.pool, otherTenant, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Other', 'other-co', 'active')`,
        [otherTenant],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('hides a connection from another tenant’s context under FORCE RLS', async () => {
    const rows = await withTenant(api.pool, otherTenant, (client) =>
      client.query(`SELECT 1 FROM channel_connections`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('hides the credential rows too', async () => {
    const rows = await withTenant(api.pool, otherTenant, (client) =>
      client.query(`SELECT 1 FROM channel_credentials`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('hides the registry row unless the asset fingerprint is presented', async () => {
    // The carve-out is one row wide and keyed on a fingerprint the ingress can
    // only derive from a signature-verified payload.
    const blind = await withTenant(api.pool, otherTenant, (client) =>
      client.query(`SELECT 1 FROM channel_asset_registry`),
    );
    expect(blind.rows).toHaveLength(0);
  });

  it('refuses a cross-tenant write even with a row id in hand', async () => {
    const id = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(`SELECT id::text FROM channel_connections LIMIT 1`),
    );
    const target = id.rows[0]?.id as string;
    const updated = await withTenant(api.pool, otherTenant, (client) =>
      client.query(`UPDATE channel_connections SET display_name = 'stolen' WHERE id = $1`, [target]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('refuses to claim an asset another tenant already holds', async () => {
    // Attempted directly against the database, bypassing the service, because
    // the guarantee has to hold below the application too (CH-03).
    await expect(
      withTenant(api.pool, otherTenant, async (client) => {
        const connection = await client.query<{ id: string }>(
          `INSERT INTO channel_connections (tenant_id, kind, external_asset_id, display_name)
           VALUES ($1, 'whatsapp', $2, 'Theirs') RETURNING id::text`,
          [otherTenant, PHONE_ID],
        );
        await client.query(
          `INSERT INTO channel_asset_registry
             (asset_fingerprint, provider, kind, external_asset_id, tenant_id, connection_id)
           VALUES ($1, 'meta', 'whatsapp', $2, $3, $4)`,
          [
            createHash('sha256').update(`meta:whatsapp:${PHONE_ID}`).digest('hex'),
            PHONE_ID,
            otherTenant,
            connection.rows[0]?.id,
          ],
        );
      }),
    ).rejects.toThrow(/channel_asset_registry_pkey|channel_asset_registry_asset_uq/);
  });

  it('keeps a tenant’s events invisible to another tenant', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.isolated', 'private')]));
    const rows = await withTenant(api.pool, otherTenant, (client) =>
      client.query(`SELECT 1 FROM channel_events`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- outbound -- */

/**
 * The outbound path, with a **stub** transport whose answer each test chooses.
 *
 * A stub, not a simulator of a provider: it exists so our own handling of
 * accepted, rejected and unknown outcomes can be exercised at all. Nothing here
 * is evidence about Meta, and no stub is bound anywhere outside this file.
 */
describe('the outbound path', () => {
  let api: Harness;
  let owner: Browser;
  let dispatcher: ChannelDispatcherService;
  let normalizer: ChannelNormalizationService;
  let connectionId: string;
  let answer: SendOutcome;
  let sent: SendCommand[];
  let delay: number;
  type TransportGate = {
    started: Promise<void>;
    signalStarted: () => void;
    waiting: Promise<void>;
    release: () => void;
  };
  let pendingTransportGate: TransportGate | null = null;
  let templateCatalogue: readonly ProviderTemplate[] = [];

  function pauseNextTransportCall(): TransportGate {
    let signalStarted!: () => void;
    let release!: () => void;
    const gate: TransportGate = {
      started: new Promise<void>((resolve) => { signalStarted = resolve; }),
      signalStarted: () => signalStarted(),
      waiting: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
    };
    pendingTransportGate = gate;
    return gate;
  }

  async function dispatchWhileTransportPaused<T>(
    tenantId: string,
    inspect: () => Promise<T>,
  ): Promise<{ result: Awaited<ReturnType<ChannelDispatcherService['dispatch']>>; value: T }> {
    const gate = pauseNextTransportCall();
    const dispatching = dispatcher.dispatch(tenantId);
    try {
      await gate.started;
      const value = await inspect();
      gate.release();
      const result = await dispatching;
      return { result, value };
    } finally {
      gate.release();
      await dispatching;
    }
  }

  const accepted = (id: string): SendOutcome => ({
    status: 'accepted',
    providerMessageId: id,
    raw: {},
  });

  beforeAll(async () => {
    sent = [];
    delay = 0;
    answer = accepted('wamid.stub');
    api = await createHarness({
      channelTransport: {
        name: 'test-stub',
        validateConnection: () =>
          Promise.resolve({ ok: true, assetIdentity: PHONE_ID, code: null, message: null }),
        fetchTemplates: () => Promise.resolve({ ok: true as const, templates: templateCatalogue }),
        send: async (_kind, _credential, command) => {
          sent.push(command);
          const gate = pendingTransportGate;
          if (gate !== null) {
            pendingTransportGate = null;
            gate.signalStarted();
            await gate.waiting;
          }
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          return answer;
        },
      },
    });
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    const created = await connect(api, owner);
    expect(created.statusCode).toBe(201);
    connectionId = (created.json() as { data: { id: string } }).data.id;
    dispatcher = api.app.get(ChannelDispatcherService);
    normalizer = api.app.get(ChannelNormalizationService);

    // A customer message, so the reply window is open at dispatch time.
    await deliver(api, messageDelivery([textMessage('wamid.opener', 'مرحبا')]));
    await normalizer.drain(api.tenantId);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  let counter = 0;
  function clientId(): string {
    counter += 1;
    return `client-message-${String(counter).padStart(4, '0')}`;
  }

  /**
   * A recipient nobody else in this file is talking to.
   *
   * Each test gets its own conversation, because the dispatch gate is
   * per-conversation: sharing one recipient would make every test contend for
   * the same slot and assert on somebody else's message.
   */
  function peer(): string {
    counter += 1;
    return `1555${String(counter).padStart(7, '0')}`;
  }

  async function syncApprovedTemplate(name = 'order_update', targetConnectionId = connectionId): Promise<string> {
    templateCatalogue = [{
      providerId: `provider-${name}-${randomUUID()}`, name, language: 'ar', category: 'utility', status: 'approved',
      components: [{ type: 'BODY', text: 'تحديث الطلب {{1}}' }], variables: ['{{1}}'],
    }];
    const synced = await send(api, owner, 'POST', `/channels/${targetConnectionId}/templates/sync`);
    expect(synced.statusCode, synced.body).toBe(201);
    const rows = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text FROM whatsapp_templates WHERE connection_id=$1 AND template_name=$2 AND status='approved' ORDER BY last_synced_at DESC LIMIT 1`,
      [targetConnectionId, name],
    ));
    return rows.rows[0]!.id;
  }

  /** Opens the reply window by having the customer write first. */
  async function openWindow(identity: string, timestamp?: string): Promise<void> {
    await deliver(
      api,
      messageDelivery([textMessage(`wamid.open-${identity}`, 'مرحبا', identity, timestamp)]),
    );
    await normalizer.drain(api.tenantId);
  }

  async function queue(payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return send(api, owner, 'POST', `/channels/${connectionId}/messages`, {
      messageType: 'text',
      text: 'رد من الفريق',
      clientMessageId: clientId(),
      ...payload,
    });
  }

  /**
   * A newer owner takes the message over while a worker is still in flight.
   *
   * What actually happens when a lease expires: another worker, or an operator
   * cancelling, moves the command on and bumps the version. The in-flight
   * worker's write must then lose the fence.
   */
  async function takeOver(messageId: string): Promise<void> {
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE outbound_messages
            SET command_state = 'cancelled', state_reason = 'operator_cancelled',
                settled_at = now(), dispatch_version = dispatch_version + 1
          WHERE id = $1`,
        [messageId],
      ),
    );
  }

  async function readMessage(messageId: string): Promise<Record<string, unknown>> {
    const response = await send(api, owner, 'GET', `/outbound-messages/${messageId}`);
    return (response.json() as { data: Record<string, unknown> }).data;
  }

  it('answers 202 with a queued command, and nothing is sent yet', async () => {
    const before = sent.length;
    const response = await queue({ peerIdentity: peer() });
    expect(response.statusCode).toBe(202);
    const message = (response.json() as { data: Record<string, unknown> }).data;
    // 202, not 200: the command is durably written and nothing has left.
    expect(message['command_state']).toBe('queued');
    expect(message['provider_message_id']).toBeNull();
    expect(message['attempts']).toEqual([]);
    expect(sent.length).toBe(before);

    // The command and its outbox entry commit together (DEL-07).
    const queued = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM outbox WHERE message_id = $1', [message['id']]),
    );
    expect(queued.rows).toHaveLength(1);
  });

  it('treats the caller’s retry of the same client id as the same message', async () => {
    const id = clientId();
    const to = peer();
    const first = await queue({ clientMessageId: id, peerIdentity: to });
    const again = await queue({ clientMessageId: id, peerIdentity: to });
    expect(again.statusCode).toBe(202);
    expect((again.json() as { data: { id: string } }).data.id).toBe(
      (first.json() as { data: { id: string } }).data.id,
    );
  });

  it('dispatches, records the attempt, and marks the command accepted', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'أهلًا', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted('wamid.accepted-1');

    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.accepted).toBeGreaterThan(0);
    // Provider URLs are scoped by the external Page/IG/phone asset ID, never
    // by CONVO's internal channel_connections UUID.
    expect(sent.at(-1)?.assetIdentity).toBe(PHONE_ID);
    expect(sent.at(-1)?.assetIdentity).not.toBe(connectionId);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['command_state']).toBe('provider_accepted');
    expect(message['provider_message_id']).toBe('wamid.accepted-1');
    expect(message['attempts']).toHaveLength(1);
    expect((message['attempts'] as { outcome: string }[])[0]?.outcome).toBe('accepted');

    // Accepted work leaves the outbox.
    const remaining = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM outbox WHERE message_id = $1', [id]),
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it('writes the attempt before the network call, not after', async () => {
    // Proved by observing the row while the transport is still in flight: if
    // the attempt were written afterwards, a crash here would leave no trace
    // that we may already have contacted the customer (DEL-12).
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'قيد الإرسال', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted('wamid.inflight');
    const { value: midflight } = await dispatchWhileTransportPaused(api.tenantId, () =>
      withTenant(api.pool, api.tenantId, (client) =>
        client.query<{ outcome: string | null }>(
          'SELECT outcome FROM outbound_attempts WHERE message_id = $1',
          [id],
        ),
      ),
    );
    expect(midflight.rows).toHaveLength(1);
    expect(midflight.rows[0]?.outcome).toBeNull();
  });

  it('never resends an unknown outcome, and leaves it visible', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'مجهول', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = { status: 'outcome_unknown', code: 'ETIMEDOUT', message: 'The answer never came.' };

    const first = await dispatcher.dispatch(api.tenantId);
    expect(first.unknown).toBe(1);
    const before = sent.length;

    // Every later sweep, including recovery, must leave it alone.
    await dispatcher.dispatch(api.tenantId);
    await dispatcher.recoverOrphanedAttempts(api.tenantId, 0);
    expect(sent.length).toBe(before);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['command_state']).toBe('outcome_unknown');
    expect(message['state_reason']).toBe('ETIMEDOUT');
    // The uncertainty stays on screen rather than being resolved by guessing.
    expect(message['provider_message_id']).toBeNull();
  });

  it('recovers an attempt that was started and never answered', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'انقطاع', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    // What a crash between the attempt row and the response looks like.
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query(
        `INSERT INTO outbound_attempts (tenant_id, message_id, attempt_no)
         VALUES ($1, $2, 1)`,
        [api.tenantId, id],
      );
    });
    const before = sent.length;

    const recovered = await dispatcher.recoverOrphanedAttempts(api.tenantId, 0);
    expect(recovered).toBeGreaterThan(0);
    // Recovery is not a retry: nothing goes back on the wire.
    expect(sent.length).toBe(before);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { command_state: string } }).data.command_state).toBe(
      'outcome_unknown',
    );
  });

  it('bounds orphan recovery and leaves the remainder claimable', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const to = peer();
      await openWindow(to);
      const response = await queue({ text: `orphan-${String(index)}`, peerIdentity: to });
      const id = (response.json() as { data: { id: string } }).data.id;
      ids.push(id);
      await withTenant(api.pool, api.tenantId, (client) =>
        client.query(
          `INSERT INTO outbound_attempts (tenant_id, message_id, attempt_no, started_at)
           VALUES ($1, $2, 1, now() - interval '10 minutes')`,
          [api.tenantId, id],
        ),
      );
    }

    expect(await dispatcher.recoverOrphanedAttempts(api.tenantId, 0, 1)).toBe(1);
    const afterFirst = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ pending: string }>(
        `SELECT count(*)::text AS pending FROM outbound_attempts
          WHERE message_id = ANY($1::uuid[]) AND outcome IS NULL`,
        [ids],
      ),
    );
    expect(afterFirst.rows[0]?.pending).toBe('1');
    expect(await dispatcher.recoverOrphanedAttempts(api.tenantId, 0, 1)).toBe(1);
  });

  it('retries a transient rejection with backoff, then gives up', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'مؤقت', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = {
      status: 'definitely_rejected',
      code: 'http_503',
      message: 'Try later.',
      retryable: true,
    };

    const first = await dispatcher.dispatch(api.tenantId);
    expect(first.retried).toBe(1);

    const scheduled = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ available_at: Date; attempts: number; last_error: string }>(
        'SELECT available_at, attempts, last_error FROM outbox WHERE message_id = $1',
        [id],
      ),
    );
    expect(scheduled.rows[0]?.attempts).toBe(1);
    expect(scheduled.rows[0]?.last_error).toBe('http_503');
    // Backed off, so an immediate sweep does not pick it up again.
    expect(scheduled.rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now());
    const idle = await dispatcher.dispatch(api.tenantId);
    expect(idle.claimed).toBe(0);

    // Exhaust the budget by hand rather than waiting out the backoff.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query('UPDATE outbox SET attempts = 5, available_at = now() WHERE message_id = $1', [id]),
    );
    const final = await dispatcher.dispatch(api.tenantId);
    expect(final.rejected).toBe(1);
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { command_state: string } }).data.command_state).toBe('failed');
  });

  it('rejects a permanent refusal without retrying it', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'مرفوض', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = {
      status: 'definitely_rejected',
      code: 'template_not_approved',
      message: 'No.',
      retryable: false,
    };

    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.rejected).toBe(1);
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['command_state']).toBe('rejected');
    expect(message['state_reason']).toBe('template_not_approved');
    const remaining = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM outbox WHERE message_id = $1', [id]),
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it('re-checks consent at dispatch time and skips a suppressed recipient', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ peerIdentity: to, text: 'بعد الانسحاب' });
    const id = (response.json() as { data: { id: string } }).data.id;
    // Consent withdrawn *after* the message was queued — the case the permit is
    // re-evaluated for (DEL-11).
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO channel_suppressions (tenant_id, kind, peer_identity, reason)
         VALUES ($1, 'whatsapp', $2, 'opt_out')`,
        [api.tenantId, to],
      ),
    );
    const before = sent.length;
    answer = accepted('wamid.never');

    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.skipped).toBe(1);
    expect(sent.length).toBe(before);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['command_state']).toBe('skipped');
    expect(message['state_reason']).toBe('consent_withheld');
    expect(message['attempts']).toEqual([]);
  });

  it('skips a message whose window closed while it waited', async () => {
    const response = await queue({ peerIdentity: peer(), text: 'خارج النافذة' });
    const id = (response.json() as { data: { id: string } }).data.id;
    // This recipient never wrote to us, so there is no open window at dispatch.
    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.skipped).toBeGreaterThan(0);
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { state_reason: string } }).data.state_reason).toBe(
      'template_required',
    );
  });

  it('refuses a private note at the door and never queues it', async () => {
    const before = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM outbound_messages'),
    );
    const response = await queue({ peerIdentity: peer(), isPrivateNote: true, text: 'ملاحظة داخلية' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'note_not_deliverable' } });
    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM outbound_messages'),
    );
    // Not queued, not stored, nowhere near a provider.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('refuses a message type the channel cannot carry', async () => {
    const response = await queue({ peerIdentity: peer(), messageType: 'carrier_pigeon' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'not_supported' } });
  });

  it('refuses to queue on a disconnected channel', async () => {
    const created = await connect(api, owner, 'phone-outbound-gone');
    const goneId = (created.json() as { data: { id: string } }).data.id;
    await send(api, owner, 'DELETE', `/channels/${goneId}`);
    const response = await send(api, owner, 'POST', `/channels/${goneId}/messages`, {
      peerIdentity: peer(),
      messageType: 'text',
      text: 'x',
      clientMessageId: clientId(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'channel_disconnected' } });
  });

  it('holds one conversation to one message on the wire at a time', async () => {
    // The serialized dispatch gate: two queued messages for the same recipient
    // are claimed one at a time, so they cannot be sent out of order (DEL-18).
    const to = peer();
    await openWindow(to);
    await queue({ peerIdentity: to, text: 'أولًا' });
    await queue({ peerIdentity: to, text: 'ثانيًا' });

    answer = accepted(`wamid.gate-${to}`);
    // Both are ready, and exactly one is claimed: a conversation puts one
    // message on the wire at a time, so they cannot arrive out of order.
    const first = await dispatcher.dispatch(api.tenantId, 10);
    expect(first.claimed).toBe(1);
    const second = await dispatcher.dispatch(api.tenantId, 10);
    expect(second.claimed).toBe(1);
  });

  it('folds a receipt that arrived before the send response', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'إيصال مبكر', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    // The receipt lands first — an ordinary inbound event whose message we
    // cannot identify yet (DEL-17).
    await deliver(api, statusDelivery('wamid.early-1', 'delivered', '1789000010', to));
    await normalizer.drain(api.tenantId);

    answer = accepted('wamid.early-1');
    await dispatcher.dispatch(api.tenantId);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    // Held and reconciled the moment the id was learned, not dropped.
    expect(message['delivery_state']).toBe('delivered');
  });

  it('keeps a read that arrives before its delivered, and records the anomaly', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'ترتيب غريب', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted('wamid.anomaly-1');
    await dispatcher.dispatch(api.tenantId);

    await deliver(api, statusDelivery('wamid.anomaly-1', 'read', '1789000020', to));
    await normalizer.drain(api.tenantId);
    expect(await dispatcher.reconcileReceipts(api.tenantId)).toBeGreaterThan(0);

    await deliver(api, statusDelivery('wamid.anomaly-1', 'delivered', '1789000021', to));
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    // The timeline stays at read; the disagreement is evidence, not noise.
    expect(message['delivery_state']).toBe('read');
    expect(message['delivery_anomaly']).toBe('delivered_after_read');
  });

  it('runs the receipt fold twice without double counting', async () => {
    const before = await dispatcher.reconcileReceipts(api.tenantId);
    const again = await dispatcher.reconcileReceipts(api.tenantId);
    expect(again).toBe(0);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('sends a template outside the window, and carries it to the transport', async () => {
    // Outside the window WhatsApp needs an approved template, and the template
    // has to reach the provider rather than being dropped on the way.
    const to = peer();
    // Keep the provider event immutable and make it genuinely older than the
    // service window at ingestion time. The app role cannot rewrite inbound
    // evidence, by design.
    await openWindow(to, String(Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000)));
    const conversationRows = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2 AND status <> 'archived'`, [connectionId, to],
    ));
    const conversationId = conversationRows.rows[0]!.id;
    const templateId = await syncApprovedTemplate();
    const catalogue = await send(api, owner, 'GET', `/conversations/${conversationId}/whatsapp-templates`);
    expect(catalogue.statusCode, catalogue.body).toBe(200);
    expect(catalogue.json()).toMatchObject({ data: [{ id: templateId, name: 'order_update', sendSupported: true, parameters: [{ key: 'body:1' }] }] });
    const response = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'template', text: '', template: { id: templateId, parameters: { 'body:1': 'A-52' } }, clientMessageId: clientId(),
    });
    expect(response.statusCode).toBe(202);
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted(`wamid.template-${to}`);

    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.accepted).toBe(1);
    const command = sent.at(-1);
    expect(command?.template).toEqual({ name: 'order_update', language: 'ar', components: [{ type: 'body', parameters: [{ type: 'text', text: 'A-52' }] }] });
    // A template-only message carries no text, and that is not an error.
    expect(command?.text).toBeNull();

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { command_state: string } }).data.command_state).toBe(
      'provider_accepted',
    );
    const timeline = await send(api, owner, 'GET', `/conversations/${conversationId}/messages`);
    expect(timeline.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ template_name: 'order_update', template_language: 'ar', template_preview: 'تحديث الطلب A-52' })]) });
  });

  it('filters and paginates the authorized conversation catalogue with escaped search semantics', async () => {
    const to = peer();
    await openWindow(to);
    const conversationRows = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2 AND status <> 'archived'`, [connectionId, to],
    ));
    const conversationId = conversationRows.rows[0]!.id;
    await syncApprovedTemplate('catalogue_page_match');
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      `INSERT INTO whatsapp_templates(tenant_id,connection_id,provider_template_id,template_name,language,category,status,components,variables,last_synced_at)
       SELECT $1,$2,'coverage-'||n,'coverage_template_'||lpad(n::text,2,'0'),'en_US','utility','approved',
              '[{"type":"BODY","text":"Hello"}]'::jsonb,'[]'::jsonb,now()
       FROM generate_series(1,51) n`, [api.tenantId, connectionId],
    ));
    const filtered = await send(api, owner, 'GET', `/conversations/${conversationId}/whatsapp-templates?search=catalogue_page_match&language=ar&category=UTILITY&status=approved`);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ data: [expect.objectContaining({ name: 'catalogue_page_match', language: 'ar', category: 'utility' })] });

    const first = await send(api, owner, 'GET', `/conversations/${conversationId}/whatsapp-templates?status=approved`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: expect.any(Array), page: { next_cursor: '50', has_more: true } });
    const second = await send(api, owner, 'GET', `/conversations/${conversationId}/whatsapp-templates?status=approved&cursor=50`);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ page: { next_cursor: null, has_more: false } });
    const invalidCursor = await send(api, owner, 'GET', `/conversations/${conversationId}/whatsapp-templates?cursor=-1`);
    expect(invalidCursor.statusCode).toBe(400);
  });

  it('fails closed for conversation sends without inbound evidence and revalidates template identity, status and values', async () => {
    const outboundPeer = peer();
    const opened = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,connection_id,peer_identity) VALUES($1,$2,$3) RETURNING id::text`, [api.tenantId, connectionId, outboundPeer],
    ));
    const noInbound = await send(api, owner, 'POST', `/conversations/${opened.rows[0]!.id}/messages`, {
      messageType: 'text', text: 'This has no opening inbound.', clientMessageId: clientId(),
    });
    expect(noInbound.statusCode).toBe(422);
    expect(noInbound.json()).toMatchObject({ error: { code: 'outside_service_window' } });

    const to = peer();
    await openWindow(to);
    const conversations = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2 AND status <> 'archived'`, [connectionId, to],
    ));
    const conversationId = conversations.rows[0]!.id;
    const templateId = await syncApprovedTemplate('validate_template');
    const missingSelection = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'template', text: '', template: { name: 'validate_template', language: 'ar' }, clientMessageId: clientId(),
    });
    expect(missingSelection.statusCode).toBe(422);
    expect(missingSelection.json()).toMatchObject({ error: { code: 'template_selection_required' } });
    const mismatch = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text', text: 'Mismatch', template: { id: templateId, parameters: { 'body:1': 'X' } }, clientMessageId: clientId(),
    });
    expect(mismatch.statusCode).toBe(400);
    const incomplete = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'template', text: '', template: { id: templateId, parameters: {} }, clientMessageId: clientId(),
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json()).toMatchObject({ error: { code: 'template_parameters_invalid' } });
    await withTenant(api.pool, api.tenantId, (client) => client.query(`UPDATE whatsapp_templates SET status='paused' WHERE id=$1`, [templateId]));
    const stale = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'template', text: '', template: { id: templateId, parameters: { 'body:1': 'X' } }, clientMessageId: clientId(),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'template_not_sendable' } });
  });

  it('refuses to dispatch when the credential has gone, without sending', async () => {
    const created = await connect(api, owner, 'phone-outbound-nocred');
    const cid = (created.json() as { data: { id: string } }).data.id;
    const to = peer();
    const templateId = await syncApprovedTemplate('order_update', cid);
    const queued = await send(api, owner, 'POST', `/channels/${cid}/messages`, {
      peerIdentity: to,
      messageType: 'template', text: '', template: { id: templateId, parameters: { 'body:1': 'A-53' } },
      clientMessageId: clientId(),
    });
    const id = (queued.json() as { data: { id: string } }).data.id;
    // Revoked out from under the queued message, as a provider-side revocation
    // would leave it.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE channel_credentials SET status = 'revoked', revoked_at = now() WHERE connection_id = $1`,
        [cid],
      ),
    );
    const before = sent.length;

    await dispatcher.dispatch(api.tenantId);
    expect(sent.length).toBe(before);
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { state_reason: string } }).data.state_reason).toBe(
      'credential_missing',
    );
  });

  it('skips a message whose channel was disconnected after it was queued', async () => {
    const created = await connect(api, owner, 'phone-outbound-later-gone');
    const cid = (created.json() as { data: { id: string } }).data.id;
    const to = peer();
    const templateId = await syncApprovedTemplate('order_update', cid);
    const queued = await send(api, owner, 'POST', `/channels/${cid}/messages`, {
      peerIdentity: to,
      messageType: 'template', text: '', template: { id: templateId, parameters: { 'body:1': 'A-54' } },
      clientMessageId: clientId(),
    });
    const id = (queued.json() as { data: { id: string } }).data.id;
    await send(api, owner, 'DELETE', `/channels/${cid}`);
    const before = sent.length;

    await dispatcher.dispatch(api.tenantId);
    expect(sent.length).toBe(before);
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['command_state']).toBe('skipped');
    expect(message['state_reason']).toBe('channel_disconnected');
  });

  it('shows an attempt that has not finished yet', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'أثناء الطيران', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted(`wamid.midflight-${to}`);
    const { value: read } = await dispatchWhileTransportPaused(api.tenantId, () =>
      send(api, owner, 'GET', `/outbound-messages/${id}`),
    );
    const attempts = (read.json() as { data: { attempts: { completed_at: string | null }[] } }).data.attempts;
    expect(attempts).toHaveLength(1);
    // Started, not finished — visible as exactly that rather than as nothing.
    expect(attempts[0]?.completed_at).toBeNull();
  });

  it('falls back to the build’s matrix when a connection stored none', async () => {
    const created = await connect(api, owner, 'phone-outbound-nomatrix');
    const cid = (created.json() as { data: { id: string } }).data.id;
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(`UPDATE channel_connections SET capabilities = '{}'::jsonb WHERE id = $1`, [cid]),
    );
    // An old row is not a reason to refuse an agent's reply.
    const response = await send(api, owner, 'POST', `/channels/${cid}/messages`, {
      peerIdentity: peer(),
      messageType: 'text',
      text: 'بدون مصفوفة مخزّنة',
      clientMessageId: clientId(),
    });
    expect(response.statusCode).toBe(202);
  });

  it('folds a read receipt onto a message that was already delivered', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'قراءة لاحقة', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted(`wamid.readlater-${to}`);
    await dispatcher.dispatch(api.tenantId);

    await deliver(api, statusDelivery(`wamid.readlater-${to}`, 'delivered', '1789000030', to));
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);
    await deliver(api, statusDelivery(`wamid.readlater-${to}`, 'read', '1789000031', to));
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    expect(message['delivery_state']).toBe('read');
    expect(message['delivery_anomaly']).toBeNull();
  });

  it('refuses a stale worker’s result while keeping its provider evidence', async () => {
    // The race the fence exists for: a worker's lease expires, a newer worker
    // takes the message over, and then the first worker's provider response
    // finally arrives. Writing it would roll the command back to a state the
    // newer worker has already moved past.
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'مسبوق', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted(`wamid.stale-${to}`);
    // A newer owner moves the command on while the first is still in flight.
    const { result } = await dispatchWhileTransportPaused(api.tenantId, () => takeOver(id));

    expect(result.stale).toBe(1);
    expect(result.accepted).toBe(0);

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const message = (read.json() as { data: Record<string, unknown> }).data;
    // The newer state stands.
    expect(message['command_state']).toBe('cancelled');
    expect(message['provider_message_id']).toBeNull();
    // And the evidence survives: somebody investigating a duplicate message
    // needs to know a request went out and what the provider said.
    const attempts = message['attempts'] as { outcome: string; error_code: string }[];
    expect(attempts[0]?.outcome).toBe('accepted');
    expect(attempts[0]?.error_code).toBe('stale_dispatch');
  });

  it('refuses a stale worker’s unknown outcome rather than resurrecting the message', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'مجهول ومسبوق', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = { status: 'outcome_unknown', code: 'ETIMEDOUT', message: 'The answer never came.' };
    const { result } = await dispatchWhileTransportPaused(api.tenantId, () => takeOver(id));

    expect(result.stale).toBe(1);
    // `outcome_unknown` is terminal, and terminal states are still fenced: it is
    // not a licence to overwrite a command a newer worker already settled.
    expect(result.unknown).toBe(0);
    const message = await readMessage(id);
    expect(message['command_state']).toBe('cancelled');

    const attempts = message['attempts'] as { outcome: string; error_code: string }[];
    // The provider's own code survives — the marker is added beside it, not over
    // it, because why this attempt went unanswered is the evidence.
    expect(attempts[0]?.outcome).toBe('outcome_unknown');
    expect(attempts[0]?.error_code).toBe('ETIMEDOUT');
    const recorded = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ error_message: string }>(
        'SELECT error_message FROM outbound_attempts WHERE message_id = $1',
        [id],
      ),
    );
    expect(recorded.rows[0]?.error_message).toContain('newer worker');
  });

  it('refuses a stale worker’s rejection rather than failing a live message', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'رفض مسبوق', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = {
      status: 'definitely_rejected',
      code: 'template_not_approved',
      message: 'No.',
      retryable: false,
    };
    const { result } = await dispatchWhileTransportPaused(api.tenantId, () => takeOver(id));

    expect(result.stale).toBe(1);
    expect(result.rejected).toBe(0);
    const message = await readMessage(id);
    expect(message['command_state']).toBe('cancelled');
    expect(message['state_reason']).toBe('operator_cancelled');
  });

  it('refuses a stale worker’s retry rather than rescheduling somebody else’s message', async () => {
    const to = peer();
    await openWindow(to);
    const response = await queue({ text: 'إعادة مسبوقة', peerIdentity: to });
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = {
      status: 'definitely_rejected',
      code: 'http_503',
      message: 'Try later.',
      retryable: true,
    };
    const { result } = await dispatchWhileTransportPaused(api.tenantId, () => takeOver(id));

    expect(result.stale).toBe(1);
    expect(result.retried).toBe(0);
    expect((await readMessage(id))['command_state']).toBe('cancelled');

    // Scheduling belongs to whoever owns the message now, so the stale worker
    // writes no backoff: a losing worker that still rescheduled would keep
    // resurrecting a cancelled message.
    const outbox = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ last_error: string | null; attempts: number }>(
        'SELECT last_error, attempts FROM outbox WHERE message_id = $1',
        [id],
      ),
    );
    expect(outbox.rows[0]?.last_error).toBeNull();
  });

  it('reports which companies have dispatchable work', async () => {
    await queue({ peerIdentity: peer(), text: 'قائمة الانتظار' });
    expect(await dispatcher.pendingTenants()).toContain(api.tenantId);
  });

  it('lists a channel’s outbound messages', async () => {
    const response = await send(api, owner, 'GET', `/channels/${connectionId}/messages`);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('answers an unknown message and an unknown channel with the same 404', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await send(api, owner, 'GET', `/outbound-messages/${missing}`)).statusCode).toBe(404);
    // Queueing onto a channel that does not exist is the same answer a
    // non-member gets: whether it exists is not this caller's business.
    const queued = await send(api, owner, 'POST', `/channels/${missing}/messages`, {
      peerIdentity: peer(),
      messageType: 'text',
      text: 'x',
      clientMessageId: clientId(),
    });
    expect(queued.statusCode).toBe(404);
  });

  it('rejects a malformed send body', async () => {
    const response = await send(api, owner, 'POST', `/channels/${connectionId}/messages`, {
      peerIdentity: '',
      messageType: 'text',
      clientMessageId: 'x',
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ------------------------------------------------- the other four channels -- */

describe('durable Meta sender profile enrichment', () => {
  it('does not claim profiles when the configured provider has no profile capability', async () => {
    const api = await createHarness();
    try {
      expect(await api.app.get(ChannelNormalizationService).drainProfiles(api.tenantId)).toBe(0);
    } finally {
      await api.app.close();
    }
  });

  it('resolves a Page-scoped sender after inbound commits, then shows the name without replacing its identity', async () => {
    const profile = vi.fn(async (): Promise<string | null> => 'Eyad Test');
    const api = await createHarness({ channelTransport: {
      name: 'profile-test',
      validateConnection: async () => ({ ok: true, assetIdentity: '483612954841071', code: null, message: null }),
      send: async () => ({ status: 'definitely_rejected', code: 'not_sent', message: 'Test only.', retryable: false }),
      fetchPeerProfile: profile,
    } });
    try {
      const owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
      const connected = await send(api, owner, 'POST', '/channels', {
        kind: 'messenger', externalAssetId: '483612954841071', displayName: 'I BOTS test Page',
        accessToken: 'synthetic-page-token-for-profile-test', appId: api.appId,
      });
      expect(connected.statusCode).toBe(201);
      const connectionId = (connected.json() as { data: { id: string } }).data.id;
      const delivered = await deliver(api, { object: 'page', entry: [{ id: '483612954841071', messaging: [{
        sender: { id: '4528904674043162' }, recipient: { id: '483612954841071' },
        timestamp: 1789000000000, message: { mid: 'mid.profile.1', text: 'Controlled message' },
      }] }] });
      expect(delivered.statusCode).toBe(200);
      const normalizer = api.app.get(ChannelNormalizationService);
      await normalizer.drain(api.tenantId);
      expect(await normalizer.pendingProfileTenants()).toContain(api.tenantId);
      expect(await normalizer.drainProfiles(api.tenantId)).toBe(1);
      expect(profile).toHaveBeenCalledWith('messenger', 'synthetic-page-token-for-profile-test', '4528904674043162');
      const rows = await withTenant(api.pool, api.tenantId, (client) => client.query<{
        display_name: string; external_id: string;
      }>(`SELECT c.display_name, i.external_id FROM contacts c
           JOIN contact_identities i ON i.contact_id=c.id
          WHERE i.scope_id=$1 AND i.external_id='4528904674043162'`, [connectionId]));
      expect(rows.rows).toEqual([{ display_name: 'Eyad Test', external_id: '4528904674043162' }]);
      expect(await normalizer.pendingProfileTenants()).not.toContain(api.tenantId);

      // Profile lookups are optional enrichment. A transient Meta failure must
      // not remove the already-ingested message, and the due row can retry.
      profile.mockResolvedValueOnce(null);
      await deliver(api, { object: 'page', entry: [{ id: '483612954841071', messaging: [{
        sender: { id: '4528904674043163' }, recipient: { id: '483612954841071' },
        timestamp: 1789000001000, message: { mid: 'mid.profile.2', text: 'Still delivered' },
      }] }] });
      await normalizer.drain(api.tenantId);
      expect(await normalizer.drainProfiles(api.tenantId)).toBe(0);
      const waiting = await withTenant(api.pool, api.tenantId, (client) => client.query<{ attempts: number }>(
        `SELECT attempts FROM contact_profile_queue q JOIN contact_identities i ON i.contact_id=q.contact_id
          WHERE i.external_id='4528904674043163'`,
      ));
      expect(waiting.rows[0]?.attempts).toBe(1);
      await withTenant(api.pool, api.tenantId, (client) => client.query(
        'UPDATE contact_profile_queue SET next_attempt_at=now() WHERE tenant_id=$1', [api.tenantId],
      ));
      expect(await normalizer.drainProfiles(api.tenantId)).toBe(1);

      // A manually corrected contact name wins over a later provider result.
      await deliver(api, { object: 'page', entry: [{ id: '483612954841071', messaging: [{
        sender: { id: '4528904674043164' }, recipient: { id: '483612954841071' },
        timestamp: 1789000002000, message: { mid: 'mid.profile.3', text: 'Manual name' },
      }] }] });
      await normalizer.drain(api.tenantId);
      await withTenant(api.pool, api.tenantId, (client) => client.query(
        `UPDATE contacts SET display_name='Operator correction'
          WHERE id=(SELECT contact_id FROM contact_identities WHERE external_id='4528904674043164')`,
      ));
      expect(await normalizer.drainProfiles(api.tenantId)).toBe(0);
      const corrected = await withTenant(api.pool, api.tenantId, (client) => client.query<{ display_name: string }>(
        `SELECT display_name FROM contacts WHERE id=(SELECT contact_id FROM contact_identities WHERE external_id='4528904674043164')`,
      ));
      expect(corrected.rows[0]?.display_name).toBe('Operator correction');

      profile.mockRejectedValueOnce(new Error('Provider credential detail must remain private'));
      await deliver(api, { object: 'page', entry: [{ id: '483612954841071', messaging: [{
        sender: { id: '4528904674043165' }, recipient: { id: '483612954841071' },
        timestamp: 1789000003000, message: { mid: 'mid.profile.4', text: 'Provider temporarily unavailable' },
      }] }] });
      await normalizer.drain(api.tenantId);
      expect(await normalizer.drainProfiles(api.tenantId)).toBe(0);
    } finally {
      await api.app.close();
    }
  }, 180_000);
});

describe('the channels beyond WhatsApp', () => {
  let api: Harness;
  let owner: Browser;
  let normalizer: ChannelNormalizationService;

  const PAGE_ID = 'page-100000000000001';
  const IG_ID = 'ig-100000000000002';
  const WIDGET_ID = 'widget-installation-1';
  const GATEWAY_ID = 'gateway-1';
  const WIDGET_KEY = 'widget-signing-key-000000000000001';
  const GATEWAY_KEY = 'gateway-signing-key-00000000000001';

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    normalizer = api.app.get(ChannelNormalizationService);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  async function connectKind(
    kind: string,
    assetId: string,
    token: string,
    settings?: Record<string, unknown>,
  ): Promise<string> {
    const response = await send(api, owner, 'POST', '/channels', {
      kind,
      externalAssetId: assetId,
      displayName: `${kind} line`,
      accessToken: token,
      ...(kind === 'whatsapp' || kind === 'messenger' || kind === 'instagram'
        ? { appId: api.appId }
        : {}),
      ...(kind === 'instagram'
        ? { settings: { facebookPageId: '123456789012345', ...settings } }
        : settings === undefined ? {} : { settings }),
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    return (response.json() as { data: { id: string } }).data.id;
  }

  /** A delivery signed the way our own channels sign: `v1=` over stamp + body. */
  function selfSigned(
    path: string,
    body: unknown,
    key: string,
    options: { origin?: string; stamp?: string } = {},
  ): Promise<LightMyRequestResponse> {
    const raw = JSON.stringify(body);
    const stamp = options.stamp ?? String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(`${stamp}.${raw}`).digest('hex');
    return api.server.inject({
      method: 'POST',
      url: `/api/v1/${path}`,
      headers: {
        'content-type': 'application/json',
        'x-convo-signature': `v1=${signature}`,
        'x-convo-timestamp': stamp,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
      payload: raw,
    });
  }

  it('routes a Messenger delivery by its envelope, not by the URL', async () => {
    const connectionId = await connectKind('messenger', PAGE_ID, 'EAAGpagetoken00001');
    const response = await deliver(api, {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1789000000000,
              message: { mid: 'mid.mg.1', text: 'مرحبا من ماسنجر' },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'received', stored: 1 });

    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string; peer_identity: string; text_body: string }>(
        `SELECT connection_id::text, peer_identity, text_body FROM inbound_events
          WHERE provider_message_id = 'mid.mg.1'`,
      ),
    );
    // The same webhook URL as WhatsApp, and it landed on the Messenger
    // connection because the envelope said `page`.
    expect(rows.rows[0]).toMatchObject({
      connection_id: connectionId,
      peer_identity: 'psid-1',
      text_body: 'مرحبا من ماسنجر',
    });
  });

  it('routes an Instagram delivery to its own connection', async () => {
    const connectionId = await connectKind('instagram', IG_ID, 'IGQVJtoken000000001');
    const response = await deliver(api, {
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          messaging: [
            {
              sender: { id: 'igsid-1' },
              recipient: { id: IG_ID },
              timestamp: 1789000000000,
              message: { mid: 'mid.ig.1', text: 'رسالة إنستغرام 😀' },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string; text_body: string }>(
        `SELECT connection_id::text, text_body FROM inbound_events WHERE provider_message_id = 'mid.ig.1'`,
      ),
    );
    expect(rows.rows[0]?.connection_id).toBe(connectionId);
    expect(rows.rows[0]?.text_body).toBe('رسالة إنستغرام 😀');
  });

  it('acknowledges a verified Meta delivery no adapter claims', async () => {
    const response = await deliver(api, { object: 'threads', entry: [] });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ reason: 'unknown_envelope' });
  });

  it('accepts a signed widget delivery from an allowed origin', async () => {
    const connectionId = await connectKind('web_chat', WIDGET_ID, WIDGET_KEY, {
      origins: ['https://school.example'],
      ratePerMinute: 100,
    });
    const response = await selfSigned(
      `webhooks/web-chat/${WIDGET_ID}`,
      {
        object: 'web_chat',
        installation_id: WIDGET_ID,
        events: [
          { id: 'wc.1', session_id: 'sess-1', type: 'message', text: 'أحتاج مساعدة' },
        ],
      },
      WIDGET_KEY,
      { origin: 'https://school.example' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'received', stored: 1 });

    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string; peer_identity: string }>(
        `SELECT connection_id::text, peer_identity FROM inbound_events
          WHERE provider_message_id = 'wc.1'`,
      ),
    );
    expect(rows.rows[0]).toMatchObject({ connection_id: connectionId, peer_identity: 'sess-1' });
  });

  it('refuses a widget delivery from an origin nobody declared', async () => {
    const response = await selfSigned(
      `webhooks/web-chat/${WIDGET_ID}`,
      { object: 'web_chat', installation_id: WIDGET_ID, events: [] },
      WIDGET_KEY,
      { origin: 'https://evil-school.example' },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: 'origin_not_allowed' });
  });

  it('refuses a widget delivery signed with the wrong key', async () => {
    const response = await selfSigned(
      `webhooks/web-chat/${WIDGET_ID}`,
      { object: 'web_chat', installation_id: WIDGET_ID, events: [] },
      'not-the-widget-key-0000000000000001',
      { origin: 'https://school.example' },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'mismatch' });
  });

  it('refuses a replayed widget delivery', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await selfSigned(
      `webhooks/web-chat/${WIDGET_ID}`,
      { object: 'web_chat', installation_id: WIDGET_ID, events: [] },
      WIDGET_KEY,
      { origin: 'https://school.example', stamp: stale },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'stale' });
  });

  it('answers an unknown installation the way an unknown route does', async () => {
    const response = await selfSigned(
      'webhooks/web-chat/widget-nobody-connected',
      { object: 'web_chat', events: [] },
      WIDGET_KEY,
      { origin: 'https://school.example' },
    );
    // Whether an installation id exists is not an unauthenticated caller's
    // business, so it is the same answer as a route that does not exist.
    expect(response.statusCode).toBe(404);
  });

  it('answers a disconnected installation the same way', async () => {
    const id = await connectKind('web_chat', 'widget-retired', WIDGET_KEY, {
      origins: ['https://school.example'],
    });
    await send(api, owner, 'DELETE', `/channels/${id}`);
    const response = await selfSigned(
      'webhooks/web-chat/widget-retired',
      { object: 'web_chat', events: [] },
      WIDGET_KEY,
      { origin: 'https://school.example' },
    );
    // An old widget still on a page learns nothing from being turned off.
    expect(response.statusCode).toBe(404);
  });

  it('rate-limits one installation without touching another', async () => {
    await connectKind('web_chat', 'widget-noisy', WIDGET_KEY, {
      origins: ['https://school.example'],
      ratePerMinute: 2,
    });
    const body = { object: 'web_chat', installation_id: 'widget-noisy', events: [] };
    const codes: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await selfSigned('webhooks/web-chat/widget-noisy', body, WIDGET_KEY, {
        origin: 'https://school.example',
      });
      codes.push(response.statusCode);
    }
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
    // The quiet installation is unaffected: the bucket is per connection.
    const other = await selfSigned(
      `webhooks/web-chat/${WIDGET_ID}`,
      { object: 'web_chat', installation_id: WIDGET_ID, events: [] },
      WIDGET_KEY,
      { origin: 'https://school.example' },
    );
    expect(other.statusCode).toBe(200);
  });

  it('accepts a signed Custom Channel delivery on its documented version', async () => {
    await connectKind('custom', GATEWAY_ID, GATEWAY_KEY, {
      origins: ['https://gateway.example'],
      declaredTypes: ['text'],
    });
    const response = await selfSigned(
      `webhooks/custom/${GATEWAY_ID}`,
      {
        object: 'convo_custom',
        version: '1',
        asset_id: GATEWAY_ID,
        events: [{ id: 'cc.1', from: '+201000000000', type: 'message', text: 'من البوابة' }],
      },
      GATEWAY_KEY,
      { origin: 'https://gateway.example' },
    );
    expect(response.statusCode).toBe(200);
    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ text_body: string }>(
        `SELECT text_body FROM inbound_events WHERE provider_message_id = 'cc.1'`,
      ),
    );
    expect(rows.rows[0]?.text_body).toBe('من البوابة');
  });

  it('keeps a Custom Channel payload from an unknown contract version, whole', async () => {
    const response = await selfSigned(
      `webhooks/custom/${GATEWAY_ID}`,
      {
        object: 'convo_custom',
        version: '9',
        asset_id: GATEWAY_ID,
        events: [{ id: 'cc.future', from: '+2010', type: 'message', text: 'من نسخة قادمة' }],
      },
      GATEWAY_KEY,
      { origin: 'https://gateway.example' },
    );
    expect(response.statusCode).toBe(200);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ quarantine_reason: string; payload: Record<string, unknown> }>(
        `SELECT quarantine_reason, payload FROM channel_events
          WHERE quarantine_reason LIKE 'unsupported_contract_version%'`,
      ),
    );
    // Kept for replay once that version exists, rather than parsed hopefully.
    expect(rows.rows[0]?.quarantine_reason).toBe('unsupported_contract_version:9');
    expect(rows.rows[0]?.payload).toMatchObject({ version: '9' });
  });

  it('refuses a delivery when the signing key has been revoked', async () => {
    const id = await connectKind('web_chat', 'widget-nokey', WIDGET_KEY, {
      origins: ['https://school.example'],
    });
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE channel_credentials SET status = 'revoked', revoked_at = now() WHERE connection_id = $1`,
        [id],
      ),
    );
    const response = await selfSigned(
      'webhooks/web-chat/widget-nokey',
      { object: 'web_chat', events: [] },
      WIDGET_KEY,
      { origin: 'https://school.example' },
    );
    // Our configuration is missing, so it is a retryable 503 rather than a
    // refusal that blames the caller.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ reason: 'signing_key_missing' });
  });

  it('refuses a signed body that will not parse', async () => {
    const raw = '{not json';
    const stamp = String(Math.floor(Date.now() / 1000));
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/webhooks/web-chat/${WIDGET_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-convo-signature': `v1=${createHmac('sha256', WIDGET_KEY).update(`${stamp}.${raw}`).digest('hex')}`,
        'x-convo-timestamp': stamp,
        origin: 'https://school.example',
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: 'malformed_body' });
  });

  it('refuses a browser delivery to a Custom Channel connection that declared no origins', async () => {
    // An unconfigured allowlist is not an open one: a request carrying an
    // Origin is a browser holding the key.
    await connectKind('custom', 'gateway-no-origins', GATEWAY_KEY, { declaredTypes: ['text'] });
    const response = await selfSigned(
      'webhooks/custom/gateway-no-origins',
      { object: 'convo_custom', version: '1', asset_id: 'gateway-no-origins', events: [] },
      GATEWAY_KEY,
      { origin: 'https://gateway.example' },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: 'origin_not_allowed' });
  });

  it('accepts the operator’s own server, which sends no Origin, and names the customer it names', async () => {
    const id = await connectKind('custom', 'gateway-server', GATEWAY_KEY, { declaredTypes: ['text'], outboundUrl: 'https://crm.gateway.example/in' });
    const response = await selfSigned(
      'webhooks/custom/gateway-server',
      {
        object: 'convo_custom',
        version: '1',
        asset_id: 'gateway-server',
        events: [
          { id: 'cc.srv.1', from: 'crm-4411', type: 'message', text: 'مرحبا', name: 'Hala Nabil' },
          { id: 'cc.srv.2', from: 'crm-4411', type: 'message', text: 'again', name: 'Someone Else' },
        ],
      },
      GATEWAY_KEY,
    );
    expect(response.statusCode).toBe(200);
    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ display_name: string }>(
        `SELECT c.display_name FROM contacts c
           JOIN contact_identities i ON i.contact_id = c.id
          WHERE i.scope_id = $1 AND i.external_id = 'crm-4411'`,
        [id],
      ),
    );
    // The first name replaces the bare id; a later one never overwrites a name.
    expect(rows.rows.map((row) => row.display_name)).toEqual(['Hala Nabil']);
    // A signed delivery proved the key, and the reply URL given at connect is kept.
    const listed = ((await send(api, owner, 'GET', '/channels')).json() as { data: { id: string; outbound_url: string | null; evidence: { kind: string; satisfied: boolean }[] }[] }).data
      .find((connection) => connection.id === id);
    expect(listed?.outbound_url).toBe('https://crm.gateway.example/in');
    expect(listed?.evidence.find((item) => item.kind === 'credential_verified')?.satisfied).toBe(true);
    // A signature alone is not enough once a browser is involved.
    const browser = await selfSigned(
      'webhooks/custom/gateway-server',
      { object: 'convo_custom', version: '1', asset_id: 'gateway-server', events: [] },
      GATEWAY_KEY,
      { origin: 'https://elsewhere.example' },
    );
    expect(browser.statusCode).toBe(403);
  });

  it('replies through the operator’s own URL, signed with the channel key, once one is set', async () => {
    const id = await connectKind('custom', 'gateway-replies', GATEWAY_KEY, { declaredTypes: ['text'] });
    // Before a URL exists, verifying says exactly what is missing.
    const unverified = await send(api, owner, 'POST', `/channels/${id}/test`);
    expect((unverified.json() as { data: { last_error_code: string } }).data.last_error_code).toBe('custom_endpoint_missing');

    expect((await send(api, owner, 'POST', `/channels/${id}/settings`, { outboundUrl: 'https://10.0.0.1/x' })).statusCode).toBe(400);
    const saved = await send(api, owner, 'POST', `/channels/${id}/settings`, {
      origins: ['https://gateway.example'],
      outboundUrl: 'https://crm.gateway.example/convo',
    });
    expect(saved.statusCode).toBe(201);
    expect((saved.json() as { data: unknown }).data).toMatchObject({ origins: ['https://gateway.example'], outbound_url: 'https://crm.gateway.example/convo' });
    const cleared = await send(api, owner, 'POST', `/channels/${id}/settings`, { outboundUrl: null });
    expect((cleared.json() as { data: unknown }).data).toMatchObject({ origins: ['https://gateway.example'], outbound_url: null });

    // A local server stands in for their system. The public-https rule is the
    // parser's; the transport posts wherever the stored URL says.
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message_id: `crm-out-${String(received.length)}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await withTenant(api.pool, api.tenantId, (client) =>
        client.query(`UPDATE channel_connections SET settings = settings || jsonb_build_object('outbound_url', $2::text) WHERE id = $1`, [
          id,
          `http://127.0.0.1:${String(port)}/convo`,
        ]),
      );
      const verified = await send(api, owner, 'POST', `/channels/${id}/test`);
      expect((verified.json() as { data: { last_error_code: string | null } }).data.last_error_code).toBeNull();
      expect(JSON.parse(received[0]!.body)).toMatchObject({ object: 'convo_custom', type: 'ping', asset_id: 'gateway-replies' });

      const queued = await send(api, owner, 'POST', `/channels/${id}/messages`, {
        peerIdentity: 'crm-7',
        messageType: 'text',
        text: 'ردّنا',
        trafficClass: 'interactive',
        clientMessageId: 'custom-reply-1',
      });
      expect(queued.statusCode, queued.body).toBe(202);
      await api.app.get(ChannelDispatcherService).dispatch(api.tenantId);
      const delivered = received[1]!;
      expect(JSON.parse(delivered.body)).toEqual({
        object: 'convo_custom',
        version: '1',
        asset_id: 'gateway-replies',
        messages: [{ id: expect.any(String), to: 'crm-7', type: 'text', text: 'ردّنا' }],
      });
      const stamp = String(delivered.headers['x-convo-timestamp']);
      expect(delivered.headers['x-convo-signature']).toBe(`v1=${createHmac('sha256', GATEWAY_KEY).update(`${stamp}.${delivered.body}`).digest('hex')}`);
      const rows = await withTenant(api.pool, api.tenantId, (client) =>
        client.query<{ command_state: string; provider_message_id: string }>(
          `SELECT command_state, provider_message_id FROM outbound_messages WHERE client_message_id = 'custom-reply-1'`,
        ),
      );
      expect(rows.rows[0]).toEqual({ command_state: 'provider_accepted', provider_message_id: 'crm-out-2' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps settings to the channels that have them', async () => {
    const widget = await connectKind('web_chat', 'widget-settings', WIDGET_KEY, { origins: ['https://school.example'] });
    const refused = await send(api, owner, 'POST', `/channels/${widget}/settings`, { outboundUrl: 'https://crm.school.example/convo' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'channel_settings_unsupported' } });
    const origins = await send(api, owner, 'POST', `/channels/${widget}/settings`, { origins: ['https://school.example', 'https://www.school.example'] });
    expect((origins.json() as { data: { origins: string[] } }).data.origins).toEqual(['https://school.example', 'https://www.school.example']);
    const page = await connectKind('messenger', 'page-settings-1', 'EAAGpagetoken00009');
    expect((await send(api, owner, 'POST', `/channels/${page}/settings`, { origins: [] })).statusCode).toBe(422);
    await send(api, owner, 'DELETE', `/channels/${widget}`);
    expect((await send(api, owner, 'POST', `/channels/${widget}/settings`, { origins: [] })).statusCode).toBe(404);
  });

  it('stores a signing key rather than an access token for the channels we own', async () => {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ kind: string; purpose: string }>(
        `SELECT c.kind, cr.purpose
           FROM channel_credentials cr
           JOIN channel_connections c ON c.id = cr.connection_id
          WHERE cr.status = 'active'
          ORDER BY c.kind`,
      ),
    );
    const byKind = new Map(rows.rows.map((row) => [row.kind, row.purpose]));
    // Opposite directions: a provider grant is presented, a signing key is
    // verified. Naming the purpose is what keeps a verifier from ever being
    // handed a sending credential.
    expect(byKind.get('messenger')).toBe('access_token');
    expect(byKind.get('instagram')).toBe('access_token');
    expect(byKind.get('web_chat')).toBe('signing_key');
    expect(byKind.get('custom')).toBe('signing_key');
  });

  it.each([
    ['a non-object settings block', { settings: 'open' }, 'settings'],
    ['an origin with a path', { settings: { origins: ['https://x.test/chat'] } }, 'settings.origins'],
    ['a wildcard origin', { settings: { origins: ['*'] } }, 'settings.origins'],
    ['a rate that is not a count', { settings: { ratePerMinute: 0 } }, 'settings.ratePerMinute'],
    ['a shouty declared type', { settings: { declaredTypes: ['TEXT'] } }, 'settings.declaredTypes'],
  ])('rejects %s when connecting', async (_label, extra, field) => {
    const response = await send(api, owner, 'POST', '/channels', {
      kind: 'web_chat',
      externalAssetId: `widget-${String(Math.random()).slice(2, 10)}`,
      displayName: 'Widget',
      accessToken: 'widget-key-000000000000000000001',
      ...extra,
    });
    expect(response.statusCode).toBe(400);
    expect(
      (response.json() as { error: { details: { field: string }[] } }).error.details.map(
        (detail) => detail.field,
      ),
    ).toContain(field);
  });
});

/* ------------------------------------------------------------ worker roles -- */

describe('the worker roles, on real channel work', () => {
  let api: Harness;
  let owner: Browser;
  let connectionId: string;
  let sent: SendCommand[];

  beforeAll(async () => {
    sent = [];
    api = await createHarness({
      channelTransport: {
        name: 'test-stub',
        validateConnection: () =>
          Promise.resolve({ ok: true, assetIdentity: PHONE_ID, code: null, message: null }),
        send: (_kind, _credential, command) => {
          sent.push(command);
          return Promise.resolve({
            status: 'accepted',
            // Derived from the recipient so a test knows the id the provider
            // will have handed back without having to count sends.
            providerMessageId: `wamid.role-${command.peerIdentity}`,
            raw: {},
          } satisfies SendOutcome);
        },
      },
    });
    owner = await login(api, 'owner@channels.test', OWNER_PASSWORD);
    const created = await connect(api, owner);
    connectionId = (created.json() as { data: { id: string } }).data.id;
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  function tick(role: 'worker-inbound' | 'worker-interactive' | 'worker-campaign') {
    return tickFor(role, { app: api.app, concurrency: 5 });
  }

  async function queueFor(
    peerIdentity: string,
    text: string,
    trafficClass: 'interactive' | 'bulk',
  ): Promise<void> {
    const response = await send(api, owner, 'POST', `/channels/${connectionId}/messages`, {
      peerIdentity,
      messageType: 'text',
      text,
      trafficClass,
      clientMessageId: `role-${peerIdentity}-${trafficClass}`,
    });
    expect(response.statusCode).toBe(202);
  }

  it('normalizes journalled events through the inbound role', async () => {
    await deliver(api, messageDelivery([textMessage('wamid.role-in', 'مرحبا', '15557000001')]));
    // Everything the webhook ACK deliberately did not do, done by the process
    // whose job it is.
    expect((await tick('worker-inbound')()).handled).toBeGreaterThan(0);

    const events = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM inbound_events WHERE peer_identity = $1', ['15557000001']),
    );
    expect(events.rows).toHaveLength(1);
    // Idle once the queue is empty, rather than re-normalizing what it already did.
    expect(await tick('worker-inbound')()).toEqual({ handled: 0 });
  });

  it('sends a reply through the interactive role and leaves the campaign alone', async () => {
    const replier = '15557000002';
    const recipient = '15557000003';
    // Both recipients wrote first, so the reply window is open for each and the
    // only thing separating them is the traffic class.
    await deliver(
      api,
      messageDelivery([
        textMessage('wamid.role-w1', 'سؤال', replier),
        textMessage('wamid.role-w2', 'سؤال', recipient),
      ]),
    );
    await tick('worker-inbound')();
    await queueFor(replier, 'رد تفاعلي', 'interactive');
    await queueFor(recipient, 'حملة', 'bulk');

    expect((await tick('worker-interactive')()).handled).toBeGreaterThan(0);
    const afterInteractive = sent.map((command) => command.text);
    // The separation is the point of two roles: a campaign worker being busy
    // cannot delay this reply, because it is not the process that sends it.
    expect(afterInteractive).toContain('رد تفاعلي');
    expect(afterInteractive).not.toContain('حملة');

    expect((await tick('worker-campaign')()).handled).toBeGreaterThan(0);
    expect(sent.map((command) => command.text)).toContain('حملة');
  });

  it('bounds a round and reports what it could not serve', async () => {
    const peers = ['15557100001', '15557100002', '15557100003', '15557100004', '15557100005'];
    await deliver(
      api,
      messageDelivery(peers.map((to, index) => textMessage(`wamid.round-${index}`, 'سؤال', to))),
    );
    await tick('worker-inbound')();
    for (const to of peers) {
      await queueFor(to, `رد ${to}`, 'interactive');
    }

    // Capacity is concurrency × 4, so one unit of concurrency serves four of
    // the five waiting conversations this round.
    const round = await tickFor('worker-interactive', { app: api.app, concurrency: 1 })();
    expect(round.handled).toBe(4);
    expect(round.fairness).toEqual({ offered: 5, achieved: 4 });

    // The fifth is still queued, not lost: the next round takes it.
    const next = await tickFor('worker-interactive', { app: api.app, concurrency: 1 })();
    expect(next.handled).toBe(1);
    expect(next.fairness).toEqual({ offered: 1, achieved: 1 });
  });

  it('folds a receipt for a company that is not sending anything', async () => {
    const to = '15557000004';
    await deliver(api, messageDelivery([textMessage('wamid.role-w3', 'سؤال', to)]));
    await tick('worker-inbound')();
    await queueFor(to, 'إيصال', 'interactive');
    await tick('worker-interactive')();

    // Everything this company queued has now left, so nothing is dispatchable.
    // A receipt arriving at this point is the case that matters: folding it
    // must not depend on the company happening to be sending something.
    const outbox = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM outbox'),
    );
    expect(outbox.rows).toHaveLength(0);

    const providerId = `wamid.role-${to}`;
    await deliver(api, statusDelivery(providerId, 'delivered', '1789000040', to));
    expect((await tick('worker-inbound')()).handled).toBeGreaterThan(0);

    const state = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ delivery_state: string }>(
        'SELECT delivery_state FROM outbound_messages WHERE provider_message_id = $1',
        [providerId],
      ),
    );
    expect(state.rows[0]?.delivery_state).toBe('delivered');
  });
});
