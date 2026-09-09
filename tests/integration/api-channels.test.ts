import { createHash, createHmac, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import type { ApiAdapters } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { ChannelDispatcherService } from '../../apps/api/src/channels/dispatcher.service.js';
import { ChannelNormalizationService } from '../../apps/api/src/channels/normalization.service.js';
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
 * honest state of this build until authorized Meta assets exist.
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

function textMessage(id: string, body: string, from = '15559998888'): Record<string, unknown> {
  return {
    id,
    from,
    timestamp: '1789000000',
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
    expect(byKind.get('instagram')?.['host']).toBe('graph.instagram.com');
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
    expect(connection['missing_evidence']).toEqual([
      'credential_verified',
      'webhook_subscribed',
      'first_inbound',
      'first_outbound',
    ]);
    // And the token is nowhere in the response, at any depth.
    expect(JSON.stringify(connection)).not.toContain('EAAGtestaccesstoken');
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

  beforeAll(async () => {
    api = await createHarness({
      channelTransport: {
        name: 'test-stub',
        validateConnection: () => Promise.resolve(answer),
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
    await deliver(api, messageDelivery([textMessage('wamid.norm-1', 'مرحبا بالعالم')]));

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
        send: async (_kind, _credential, command) => {
          sent.push(command);
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

  /** Opens the reply window by having the customer write first. */
  async function openWindow(identity: string): Promise<void> {
    await deliver(
      api,
      messageDelivery([textMessage(`wamid.open-${identity}`, 'مرحبا', identity)]),
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
    delay = 250;

    const dispatching = dispatcher.dispatch(api.tenantId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const midflight = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ outcome: string | null }>(
        'SELECT outcome FROM outbound_attempts WHERE message_id = $1',
        [id],
      ),
    );
    expect(midflight.rows).toHaveLength(1);
    expect(midflight.rows[0]?.outcome).toBeNull();
    await dispatching;
    delay = 0;
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
    const response = await queue({
      peerIdentity: to,
      text: '',
      template: { name: 'order_update', language: 'ar' },
    });
    expect(response.statusCode).toBe(202);
    const id = (response.json() as { data: { id: string } }).data.id;
    answer = accepted(`wamid.template-${to}`);

    const result = await dispatcher.dispatch(api.tenantId);
    expect(result.accepted).toBe(1);
    const command = sent.at(-1);
    expect(command?.template).toEqual({ name: 'order_update', language: 'ar' });
    // A template-only message carries no text, and that is not an error.
    expect(command?.text).toBeNull();

    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    expect((read.json() as { data: { command_state: string } }).data.command_state).toBe(
      'provider_accepted',
    );
  });

  it('refuses to dispatch when the credential has gone, without sending', async () => {
    const created = await connect(api, owner, 'phone-outbound-nocred');
    const cid = (created.json() as { data: { id: string } }).data.id;
    const to = peer();
    const queued = await send(api, owner, 'POST', `/channels/${cid}/messages`, {
      peerIdentity: to,
      messageType: 'text',
      text: '',
      template: { name: 'order_update', language: 'ar' },
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
    const queued = await send(api, owner, 'POST', `/channels/${cid}/messages`, {
      peerIdentity: to,
      messageType: 'text',
      text: '',
      template: { name: 'order_update', language: 'ar' },
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
    delay = 250;

    const dispatching = dispatcher.dispatch(api.tenantId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const read = await send(api, owner, 'GET', `/outbound-messages/${id}`);
    const attempts = (read.json() as { data: { attempts: { completed_at: string | null }[] } }).data
      .attempts;
    expect(attempts).toHaveLength(1);
    // Started, not finished — visible as exactly that rather than as nothing.
    expect(attempts[0]?.completed_at).toBeNull();
    await dispatching;
    delay = 0;
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
      ...(settings === undefined ? {} : { settings }),
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
              message: { mid: 'mid.ig.1', text: 'رسالة إنستغرام' },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    await normalizer.drain(api.tenantId);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string }>(
        `SELECT connection_id::text FROM inbound_events WHERE provider_message_id = 'mid.ig.1'`,
      ),
    );
    expect(rows.rows[0]?.connection_id).toBe(connectionId);
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

  it('refuses a Custom Channel connection that declared no origins', async () => {
    // An unconfigured allowlist is not an open one.
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
