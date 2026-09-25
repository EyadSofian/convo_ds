import { createHash, createHmac, randomUUID } from 'node:crypto';
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
import { AuthService } from '../../apps/api/src/auth/auth.service.js';
import { NotificationService } from '../../apps/api/src/notifications/notification.service.js';
import { PushOutboxService } from '../../apps/api/src/notifications/push-outbox.service.js';
import type { PushSender } from '../../apps/api/src/notifications/push-outbox.service.js';
import { OutboundService } from '../../apps/api/src/channels/outbound.service.js';
import { LifecycleService } from '../../apps/api/src/conversations/lifecycle.service.js';
import { tickFor } from '../../apps/api/src/workers/worker-roles.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig, encodeCursor } from '../../packages/domain/src/index.js';
import type { SendOutcome } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchMigrationPool,
  scratchRuntimePool,
  superuserPool,
} from '../support/scratch.js';


/**
 * Realtime, against a real database with FORCE RLS.
 *
 * The claim under test is the one that decides whether this feature is safe to
 * ship: **a subscription is not a way around an endpoint**. Every event is
 * authorized again on the way out, from the same `authorize` the HTTP routes
 * use, against a principal read fresh from the database — so an agent who may
 * only preview a conversation receives a queue card and not a transcript, and
 * an agent whose inbox is taken away stops receiving anything at all without
 * logging out first.
 *
 * The stream itself is exercised over HTTP with a deliberately short maximum
 * connection age, which is a real production setting rather than a test hook:
 * a bounded connection is what makes reconnect the normal path.
 */

const BOOTSTRAP_TOKEN = 'realtime-bootstrap-token-value-00000001';
const OWNER_PASSWORD = 'owner password for realtime tests';
const MEMBER_PASSWORD = 'member password for realtime tests';
const APP_SECRET = 'meta-app-secret-for-realtime-tests-01';
const VERIFY_TOKEN = 'the-realtime-verify-token';
const CREDENTIAL_KEY = `v1:${Buffer.alloc(32, 23).toString('base64')}`;
const INBOX_A = 'phone-realtime-a';
const INBOX_B = 'phone-realtime-b';

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

function envFor(names: DatabaseNames, overrides: Record<string, string> = {}): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Realtime Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'realtime',
    CONVO_AUTH_HASH_SECRET: 'realtime-integration-hash-secret-001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'realtime-idempotency-secret-000001',
    CONVO_CREDENTIAL_KEYS: CREDENTIAL_KEY,
    CONVO_WEB_PUSH_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url'),
    CONVO_CHANNEL_SECRET_META_APP: APP_SECRET,
    // A one-second connection: long enough to prove frames flow, short enough
    // that a test finishes. Production runs this at five minutes.
    CONVO_REALTIME_MAX_STREAM_MS: '1000',
    CONVO_REALTIME_POLL_MS: '50',
    CONVO_REALTIME_HEARTBEAT_MS: '1000',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
    ...overrides,
  };
}

/**
 * The provider id a send is answered with.
 *
 * Derived from the recipient rather than held in a mutable the tests take turns
 * setting: two messages sharing one provider id would make a single receipt
 * fold onto both, which is a test artefact that looks exactly like a real
 * correlation bug.
 */
function providerIdFor(peerIdentity: string): string {
  return `wamid.rt-out-${peerIdentity}`;
}

const transport: NonNullable<ApiAdapters['channelTransport']> = {
  name: 'test-stub',
  validateConnection: (_kind, _credential, asset) =>
    Promise.resolve({ ok: true, assetIdentity: asset, code: null, message: null }),
  send: (_kind, _credential, command) =>
    Promise.resolve({
      status: 'accepted',
      providerMessageId: providerIdFor(command.peerIdentity),
      raw: {},
    } satisfies SendOutcome),
};

async function createHarness(): Promise<Harness> {
  const names = await createScratchDatabase('convo_realtime');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 8);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool, { channelTransport: transport });
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;

  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'realtime-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@realtime.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;

  const admin = scratchMigrationPool(names);
  let appId: string;
  try {
    const appRow = await admin.query<{ id: string }>(
      `INSERT INTO channel_apps
         (provider, external_app_id, secret_ref, secret_fingerprint, verify_token_hash, graph_version)
       VALUES ('meta', '100000000000009', 'META_APP', $1, $2, 'v21.0')
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
    headers: { 'user-agent': 'CONVO realtime test' },
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return api.server.inject({
    method,
    url: `/api/v1/tenants/${api.tenantId}${path}`,
    headers: {
      cookie: browser.cookie,
      'x-csrf-token': browser.csrf,
      'idempotency-key': `realtime-${String(Math.random()).slice(2)}`,
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Adds a person holding a built-in role, scoped to the inboxes they may work. */
async function addMember(
  api: Harness,
  email: string,
  roleKey: string,
  scopes: readonly { type: 'tenant' | 'team' | 'inbox'; id: string | null }[],
): Promise<string> {
  const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
  const user = await api.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id::text`,
    [email, hash],
  );
  const userId = user.rows[0]?.id as string;
  return withTenant(api.pool, api.tenantId, async (client) => {
    const role = await client.query<{ id: string }>('SELECT id::text FROM roles WHERE key = $1', [
      roleKey,
    ]);
    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_id, status)
       VALUES ($1, $2, $3, 'active') RETURNING id::text`,
      [api.tenantId, userId, role.rows[0]?.id],
    );
    const membershipId = membership.rows[0]?.id as string;
    for (const scope of scopes) {
      await client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, $3, $4)`,
        [api.tenantId, membershipId, scope.type, scope.id],
      );
    }
    return membershipId;
  });
}

function deliver(api: Harness, body: unknown): Promise<LightMyRequestResponse> {
  const raw = JSON.stringify(body);
  return api.server.inject({
    method: 'POST',
    url: `/api/v1/webhooks/meta/${api.appId}`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    payload: raw,
  });
}

function messageDelivery(
  phoneId: string,
  messages: readonly Record<string, unknown>[],
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
              metadata: { display_phone_number: '15550009999', phone_number_id: phoneId },
              messages,
            },
          },
        ],
      },
    ],
  };
}

function statusDelivery(
  phoneId: string,
  id: string,
  state: string,
  timestamp: string,
  recipient: string,
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
              metadata: { phone_number_id: phoneId },
              statuses: [{ id, status: state, recipient_id: recipient, timestamp }],
            },
          },
        ],
      },
    ],
  };
}

/**
 * A customer message, timestamped in the recent past and increasing.
 *
 * Real provider timestamps are behind the clock — a webhook arrives after the
 * customer pressed send — and the timeline merges inbound events with outbound
 * commands on time. A fixed constant that happens to be in the future would put
 * every customer message after every reply, which is a fixture artefact that
 * reads exactly like an ordering bug.
 */
let providerClock = Math.floor(Date.now() / 1000) - 3600;

function textMessage(id: string, body: string, from: string): Record<string, unknown> {
  providerClock += 1;
  return { id, from, timestamp: String(providerClock), type: 'text', text: { body } };
}

interface FeedBody {
  readonly status: string;
  readonly reason?: string;
  readonly cursor: string;
  readonly backlog?: number;
  readonly events: readonly {
    readonly id: string;
    readonly seq: number;
    readonly type: string;
    readonly entity: { readonly type: string; readonly id: string; readonly version: number };
    readonly scope: { readonly conversationId: string; readonly inboxId: string };
    readonly payload: Record<string, unknown>;
  }[];
}

let api: Harness;
let owner: Browser;
let agentA: Browser;
let agentB: Browser;
let agentAMembershipId: string;
let agentBMembershipId: string;
let secondAgentA: Browser;
let secondAgentAMembershipId: string;
let supervisor: Browser;
let supervisorMembershipId: string;
let inboxA: string;
let inboxB: string;
let normalizer: ChannelNormalizationService;
let dispatcher: ChannelDispatcherService;

async function feed(browser: Browser, cursor?: string): Promise<FeedBody> {
  const response = await send(
    api,
    browser,
    'GET',
    `/realtime/events${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
  );
  expect(response.statusCode, response.payload).toBe(200);
  return (response.json() as { data: FeedBody }).data;
}

/** Delivers a customer message and normalizes it, the way the workers would. */
async function customerWrites(phoneId: string, from: string, text: string, id: string): Promise<void> {
  expect((await deliver(api, messageDelivery(phoneId, [textMessage(id, text, from)]))).statusCode).toBe(
    200,
  );
  await normalizer.drain(api.tenantId);
}

beforeAll(async () => {
  api = await createHarness();
  owner = await login(api, 'owner@realtime.test', OWNER_PASSWORD);
  normalizer = api.app.get(ChannelNormalizationService);
  dispatcher = api.app.get(ChannelDispatcherService);

  for (const [asset, label] of [
    [INBOX_A, 'خط التسجيل'],
    [INBOX_B, 'خط المحاسبة'],
  ] as const) {
    const created = await send(api, owner, 'POST', '/channels', {
      kind: 'whatsapp',
      externalAssetId: asset,
      displayName: label,
      accessToken: 'EAAGtestaccesstoken0009',
      appId: api.appId,
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    if (asset === INBOX_A) {
      inboxA = id;
    } else {
      inboxB = id;
    }
  }

  agentAMembershipId = await addMember(api, 'agent-a@realtime.test', 'agent', [
    { type: 'inbox', id: inboxA },
  ]);
  agentBMembershipId = await addMember(api, 'agent-b@realtime.test', 'agent', [
    { type: 'inbox', id: inboxB },
  ]);
  secondAgentAMembershipId = await addMember(api, 'agent-a2@realtime.test', 'agent', [
    { type: 'inbox', id: inboxA },
  ]);
  agentA = await login(api, 'agent-a@realtime.test', MEMBER_PASSWORD);
  agentB = await login(api, 'agent-b@realtime.test', MEMBER_PASSWORD);
  secondAgentA = await login(api, 'agent-a2@realtime.test', MEMBER_PASSWORD);

  // Routing authority scoped to one inbox: the case the matrix distinguishes
  // from an Owner's tenant reach and from an Agent's none.
  supervisorMembershipId = await addMember(api, 'supervisor-routing@realtime.test', 'supervisor', [
    { type: 'inbox', id: inboxA },
  ]);
  supervisor = await login(api, 'supervisor-routing@realtime.test', MEMBER_PASSWORD);
}, 240_000);

afterAll(async () => {
  await api.app.close();
});

describe('the event feed', () => {
  it('answers an empty feed before anything has happened', async () => {
    // The very first subscription any company makes: no events, no sequence
    // row. It has to be an ordinary empty page, not an expired cursor, or every
    // new company would start by being told to reload.
    const page = await feed(owner);
    expect(page).toMatchObject({ status: 'ok', events: [], backlog: 0 });
  });

  it('records a conversation and an event when a customer writes', async () => {
    await customerWrites(INBOX_A, '15557000001', 'مرحبا، أريد التسجيل', 'wamid.rt-1');

    const page = await feed(owner);
    expect(page.status).toBe('ok');
    const inbound = page.events.filter((event) => event.type === 'message.inbound');
    expect(inbound).toHaveLength(1);
    // DEL-19: schema version, own id, entity with its version, and the scope.
    expect(inbound[0]?.entity).toMatchObject({ type: 'conversation', version: 2 });
    expect(inbound[0]?.scope.inboxId).toBe(inboxA);
    expect(inbound[0]?.payload['text']).toBe('مرحبا، أريد التسجيل');

    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; waiting_since: Date | null }>(
        'SELECT id::text, waiting_since FROM conversations WHERE peer_identity = $1',
        ['15557000001'],
      ),
    );
    expect(conversation.rows).toHaveLength(1);
    // The customer is waiting for a human, and the queue knows when that started.
    expect(conversation.rows[0]?.waiting_since).not.toBeNull();
  });

  it('numbers events densely, so a client can tell a gap from silence', async () => {
    const before = await feed(owner);
    await customerWrites(INBOX_A, '15557000002', 'سؤال ثانٍ', 'wamid.rt-2');
    const after = await feed(owner);
    const numbers = after.events.map((event) => event.seq);
    expect(numbers).toEqual(numbers.slice().sort((left, right) => left - right));
    expect(numbers[numbers.length - 1]).toBe((before.events.at(-1)?.seq ?? 0) + 1);
  });

  it('does not repeat an event a client already has', async () => {
    const first = await feed(owner);
    const again = await feed(owner, first.cursor);
    // Resuming from a cursor is the dedupe: the second page starts after the
    // last event of the first, not at the beginning of the feed.
    expect(again.events).toEqual([]);

    await customerWrites(INBOX_A, '15557000003', 'سؤال ثالث', 'wamid.rt-3');
    const next = await feed(owner, first.cursor);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.payload['text']).toBe('سؤال ثالث');
    // Every event still carries a stable id, so a consumer that sees one twice
    // across a reconnect can recognise it.
    expect(next.events[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives an agent a queue card and never the customer’s message', async () => {
    const page = await feed(agentA);
    const inbound = page.events.filter((event) => event.type === 'message.inbound');
    expect(inbound.length).toBeGreaterThan(0);
    for (const event of inbound) {
      expect(event.payload['projected']).toBe(true);
      // The projection is server-side. There is no transcript in the frame for
      // a browser to be trusted to hide.
      expect(event.payload['text']).toBeUndefined();
      expect(event.payload['peerIdentity']).toBeUndefined();
      expect(event.payload['maskedLabel']).toMatch(/^••••\d{3}$/);
      expect(event.payload['claimable']).toBe(true);
    }
    expect(JSON.stringify(page.events)).not.toContain('15557000001');
  });

  it('hides another inbox’s conversations entirely', async () => {
    const page = await feed(agentB);
    // Not an empty payload and not an id: nothing. Otherwise an agent could
    // count another team's conversations by watching sequence numbers.
    expect(page.events).toEqual([]);
  });

  it('answers another company’s feed the way it answers a company that does not exist', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/99999999-9999-4999-8999-999999999999/realtime/events`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an unauthenticated subscription', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/realtime/events`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('cursors', () => {
  it('refuses a cursor minted for another company', async () => {
    const foreign = encodeCursor({
      tenantId: '99999999-9999-4999-8999-999999999999',
      seq: 1,
      authority: 'whatever',
    });
    const page = await feed(owner, foreign);
    expect(page).toMatchObject({ status: 'reset_required', reason: 'other_tenant' });
  });

  it('refuses a cursor that is not one of ours', async () => {
    expect(await feed(owner, 'not-a-cursor')).toMatchObject({
      status: 'reset_required',
      reason: 'malformed',
    });
  });

  it('refuses a cursor issued before the caller’s permissions changed', async () => {
    const before = await feed(secondAgentA);
    const membership = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT m.id::text FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE u.email = $1`,
        ['agent-a2@realtime.test'],
      ),
    );
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, 'inbox', $3)`,
        [api.tenantId, membership.rows[0]?.id, inboxB],
      ),
    );

    // Both halves of the client's view are now wrong: events it was not sent
    // may now be permitted, and a partial resume would never show them.
    expect(await feed(secondAgentA, before.cursor)).toMatchObject({
      status: 'reset_required',
      reason: 'permissions_changed',
    });
    // Starting again works immediately, with the wider reach applied.
    expect((await feed(secondAgentA)).status).toBe('ok');
  });

  it('refuses a cursor older than the feed still holds', async () => {
    const current = await feed(owner);
    const bounds = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ oldest: string; newest: string }>(
        'SELECT min(seq)::text AS oldest, max(seq)::text AS newest FROM realtime_events',
      ),
    );
    const oldest = Number(bounds.rows[0]?.oldest);
    const newest = Number(bounds.rows[0]?.newest);
    expect(newest).toBeGreaterThan(oldest + 1);

    // Retention pruning is a maintenance act outside any tenant context, so it
    // runs here as the superuser: the runtime role holds INSERT and SELECT on
    // the feed and nothing else, and FORCE RLS applies to the schema owner too.
    // Automatic pruning is not built yet; what has to work today is the client's
    // side of it, which is what this asserts.
    const admin = superuserPool(api.names.database);
    try {
      await admin.query('DELETE FROM realtime_events');
    } finally {
      await admin.end();
    }

    const stale = encodeCursor({
      tenantId: api.tenantId,
      seq: oldest,
      // The digest has to match, or the answer would be permissions_changed and
      // this test would be proving the wrong thing.
      authority: decodeAuthority(current.cursor),
    });
    expect(await feed(owner, stale)).toMatchObject({
      status: 'reset_required',
      reason: 'expired',
    });

    // Starting again works, and the numbering carries on from where it was: a
    // pruned feed is not a reset sequence, or a client's stored events would
    // collide with new ones.
    const restarted = await feed(owner);
    expect(restarted).toMatchObject({ status: 'ok', events: [] });
    await customerWrites(INBOX_A, '15557000006', 'بعد التقليم', 'wamid.rt-6');
    const resumed = await feed(owner, restarted.cursor);
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0]?.seq).toBe(newest + 1);
  });

  it('tells a consumer that has fallen too far behind to start again', async () => {
    await customerWrites(INBOX_A, '15557000004', 'تراكم أول', 'wamid.rt-4');
    await customerWrites(INBOX_A, '15557000005', 'تراكم ثانٍ', 'wamid.rt-5');
    // A separate process configured to tolerate a backlog of one, which is what
    // a slow consumer looks like from the server's side.
    const pool = scratchRuntimePool(api.names, 2);
    const app = await createApiApplication(
      parseApiConfig(envFor(api.names, { CONVO_REALTIME_MAX_BACKLOG: '1' })),
      pool,
      { channelTransport: transport },
    );
    try {
      const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tenants/${api.tenantId}/realtime/events`,
        headers: { cookie: owner.cookie },
      });
      const body = (response.json() as { data: FeedBody }).data;
      // Sending a bigger page would move the problem into memory rather than
      // solve it, so the honest answer is "reload".
      expect(body).toMatchObject({ status: 'reset_required', reason: 'too_far_behind' });
    } finally {
      await app.close();
    }
  });
});

describe('the Unassigned queue', () => {
  it('lists projected cards for the inboxes an agent may work', async () => {
    const response = await send(api, agentA, 'GET', '/conversations/unassigned');
    expect(response.statusCode).toBe(200);
    const cards = (response.json() as { data: readonly Record<string, unknown>[] }).data;
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual([
        'channel',
        'claimable',
        'id',
        'inboxLabel',
        'maskedLabel',
        'priority',
        'status',
        'version',
        'waitingSinceAt',
      ]);
    }
    expect(JSON.stringify(cards)).not.toContain('15557000001');
    expect(JSON.stringify(cards)).not.toContain('التسجيل، أريد');
  });

  it('shows an agent nothing from an inbox they do not hold', async () => {
    const response = await send(api, agentB, 'GET', '/conversations/unassigned');
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('refuses the queue to someone with no preview grant', async () => {
    await addMember(api, 'analyst@realtime.test', 'analyst', [{ type: 'tenant', id: null }]);
    const analyst = await login(api, 'analyst@realtime.test', MEMBER_PASSWORD);
    expect((await send(api, analyst, 'GET', '/conversations/unassigned')).statusCode).toBe(403);
  });
});

describe('claiming', () => {
  async function cardFor(browser: Browser, peer: string): Promise<{ id: string; version: number }> {
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    const row = conversation.rows[0];
    expect(row, `no conversation for ${peer}`).toBeDefined();
    // Proves the agent can actually see the card they are about to act on.
    const queue = await send(api, browser, 'GET', '/conversations/unassigned');
    expect((queue.json() as { data: { id: string }[] }).data.map((card) => card.id)).toContain(
      row?.id,
    );
    return row as { id: string; version: number };
  }

  it('refuses the full record before a claim and allows it after', async () => {
    await customerWrites(INBOX_A, '15557000010', 'أريد التفاصيل', 'wamid.rt-10');
    const card = await cardFor(agentA, '15557000010');

    // `conversation.read` is `own` for an agent, and nothing is theirs yet.
    expect((await send(api, agentA, 'GET', `/conversations/${card.id}`)).statusCode).toBe(403);

    const claimed = await send(api, agentA, 'POST', `/conversations/${card.id}/claim`, {
      version: card.version,
    });
    expect(claimed.statusCode).toBe(200);
    const detail = (claimed.json() as { data: Record<string, unknown> }).data;
    expect(detail['assigneeMembershipId']).toBe(agentAMembershipId);
    expect(detail['ownerState']).toBe('human_active');
    expect(detail['ownerVersion']).toBe(2);

    const audit = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ act: string; to_value: string | null; detail: Record<string, unknown> }>(
        `SELECT act, to_value, detail FROM conversation_audit
          WHERE conversation_id = $1 ORDER BY at DESC LIMIT 1`,
        [card.id],
      ),
    );
    expect(audit.rows[0]).toMatchObject({
      act: 'claim',
      to_value: agentAMembershipId,
      detail: { ownerStateTo: 'human_active', ownerVersion: 2 },
    });

    const read = await send(api, agentA, 'GET', `/conversations/${card.id}`);
    expect(read.statusCode).toBe(200);
    expect((read.json() as { data: { peerIdentity: string } }).data.peerIdentity).toBe(
      '15557000010',
    );
  });

  it('lets an agent mark only their cursor unread and release only their own claim', async () => {
    const peer = '15557000991';
    await customerWrites(INBOX_A, peer, 'Controlled queue message', 'wamid.rt-own-release');
    const card = await cardFor(agentA, peer);
    const claimed = await send(api, agentA, 'POST', `/conversations/${card.id}/claim`, { version: card.version });
    expect(claimed.statusCode).toBe(200);
    const version = (claimed.json() as { data: { version: number } }).data.version;
    expect((await send(api, agentA, 'POST', `/conversations/${card.id}/read`, {})).statusCode).toBe(200);
    expect((await send(api, owner, 'POST', `/conversations/${card.id}/read`, {})).statusCode).toBe(200);
    const unread = await send(api, agentA, 'POST', `/conversations/${card.id}/unread`);
    expect(unread.statusCode, unread.payload).toBe(200);
    expect(unread.json()).toMatchObject({ data: { unread: true } });
    const cursors = await withTenant(api.pool, api.tenantId, (client) => client.query<{ membership_id: string }>(
      'SELECT membership_id::text FROM conversation_reads WHERE conversation_id=$1', [card.id],
    ));
    expect(cursors.rows.map((row) => row.membership_id)).not.toContain(agentAMembershipId);
    expect(cursors.rows).toHaveLength(1);
    expect((await send(api, agentB, 'POST', `/conversations/${card.id}/release`, { version })).statusCode).toBe(403);
    const released = await send(api, agentA, 'POST', `/conversations/${card.id}/release`, { version });
    expect(released.statusCode, released.payload).toBe(200);
    expect((released.json() as { data: { assigneeMembershipId: string | null } }).data.assigneeMembershipId).toBeNull();
    const queue = await send(api, agentA, 'GET', '/conversations/unassigned');
    expect((queue.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(card.id);
  });

  it('produces exactly one winner when two agents claim at the same version', async () => {
    await customerWrites(INBOX_A, '15557000011', 'من يرد أولاً', 'wamid.rt-11');
    const card = await cardFor(agentA, '15557000011');

    const [first, second] = await Promise.all([
      send(api, agentA, 'POST', `/conversations/${card.id}/claim`, { version: card.version }),
      send(api, secondAgentA, 'POST', `/conversations/${card.id}/claim`, { version: card.version }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    // Told, not silently overwritten: the loser's next step is to re-read.
    expect((loser.json() as { error: { code: string } }).error.code).toBe(
      'conversation_version_conflict',
    );
  });

  it('refuses a claim at a version the caller did not see', async () => {
    await customerWrites(INBOX_A, '15557000012', 'نسخة قديمة', 'wamid.rt-12');
    const card = await cardFor(agentA, '15557000012');
    const stale = await send(api, agentA, 'POST', `/conversations/${card.id}/claim`, {
      version: card.version - 1,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('refuses a claim with no version at all', async () => {
    await customerWrites(INBOX_A, '15557000013', 'بدون نسخة', 'wamid.rt-13');
    const card = await cardFor(agentA, '15557000013');
    const response = await send(api, agentA, 'POST', `/conversations/${card.id}/claim`, {});
    expect(response.statusCode).toBe(400);
    expect(
      (response.json() as { error: { details: { field: string }[] } }).error.details[0]?.field,
    ).toBe('version');
  });

  it('answers a claim on a conversation that does not exist with a 404', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect(
      (await send(api, agentA, 'POST', `/conversations/${missing}/claim`, { version: 1 }))
        .statusCode,
    ).toBe(404);
    expect((await send(api, agentA, 'GET', `/conversations/${missing}`)).statusCode).toBe(404);
  });

  it('takes a claimed conversation off everyone else’s queue and says so on the feed', async () => {
    await customerWrites(INBOX_A, '15557000014', 'سيُطالب به', 'wamid.rt-14');
    const card = await cardFor(agentA, '15557000014');
    const beforeForPeer = await feed(secondAgentA);
    const beforeForOwner = await feed(owner);

    expect(
      (await send(api, agentA, 'POST', `/conversations/${card.id}/claim`, { version: card.version }))
        .statusCode,
    ).toBe(200);

    const queue = await send(api, secondAgentA, 'GET', '/conversations/unassigned');
    expect((queue.json() as { data: { id: string }[] }).data.map((entry) => entry.id)).not.toContain(
      card.id,
    );

    // The other agent learns it is gone, and learns nothing else about it.
    const after = await feed(secondAgentA, beforeForPeer.cursor);
    const assignment = after.events.filter((event) => event.type === 'conversation.assigned');
    expect(assignment).toEqual([]);

    // Somebody who may read the conversation gets the assignment as written.
    const ownerView = await feed(owner, beforeForOwner.cursor);
    const assigned = ownerView.events.find((event) => event.type === 'conversation.assigned');
    expect(assigned?.payload['assigneeMembershipId']).toBe(agentAMembershipId);
  });
});

describe('team routing', () => {
  it('reaches a conversation through its team when the inbox was never granted', async () => {
    // The first message creates the conversation; the router then puts it on a
    // team. An event carries the scope it was emitted under, so only messages
    // after the routing carry the team — which is the correct behaviour, not a
    // limitation: an event is a statement about a moment.
    await customerWrites(INBOX_B, '15557000060', 'قبل التوجيه', 'wamid.rt-59');
    const team = await withTenant(api.pool, api.tenantId, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO teams (tenant_id, name) VALUES ($1, 'فريق التسجيل') RETURNING id::text`,
        [api.tenantId],
      );
      const teamId = created.rows[0]?.id as string;
      // Routing does not exist yet, so the column is set the way a router will
      // set it. The authorization term it feeds is what is under test.
      await client.query(
        `UPDATE conversations SET team_id = $1 WHERE peer_identity = $2`,
        [teamId, '15557000060'],
      );
      return teamId;
    });
    await customerWrites(INBOX_B, '15557000060', 'موجّه لفريق', 'wamid.rt-60');

    const membershipId = await addMember(api, 'team-lead@realtime.test', 'supervisor', [
      { type: 'team', id: team },
    ]);
    expect(membershipId).toMatch(/^[0-9a-f-]{36}$/);
    const lead = await login(api, 'team-lead@realtime.test', MEMBER_PASSWORD);

    // The conversation is on inbox B, which this supervisor was never granted.
    const page = await feed(lead);
    const routed = page.events.filter(
      (event) => event.payload['text'] === 'موجّه لفريق',
    );
    expect(routed).toHaveLength(1);

    const queue = await send(api, lead, 'GET', '/conversations/unassigned');
    expect((queue.json() as { data: { id: string }[] }).data).toHaveLength(1);

    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        '15557000060',
      ]),
    );
    const read = await send(api, lead, 'GET', `/conversations/${conversation.rows[0]?.id}`);
    expect(read.statusCode).toBe(200);
    const detail = (read.json() as { data: { teamId: string; version: number } }).data;
    expect(detail.teamId).toBe(team);

    // And claiming is decided against the same team term.
    const claimed = await send(
      api,
      lead,
      'POST',
      `/conversations/${conversation.rows[0]?.id}/claim`,
      { version: detail.version },
    );
    expect(claimed.statusCode).toBe(200);
  });

  it('refuses a claim to someone who holds no claim grant', async () => {
    const analyst = await login(api, 'analyst@realtime.test', MEMBER_PASSWORD);
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        `SELECT id::text, version FROM conversations WHERE assignee_membership_id IS NULL LIMIT 1`,
      ),
    );
    const row = conversation.rows[0] as { id: string; version: number };
    const response = await send(api, analyst, 'POST', `/conversations/${row.id}/claim`, {
      version: row.version,
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a claim whose body is not an object at all', async () => {
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT id::text FROM conversations WHERE assignee_membership_id IS NULL LIMIT 1`,
      ),
    );
    const id = conversation.rows[0]?.id as string;
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/conversations/${id}/claim`,
      headers: {
        cookie: agentA.cookie,
        'x-csrf-token': agentA.csrf,
        'content-type': 'application/json',
      },
      payload: '"three"',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('a conversation that is already somebody’s', () => {
  it('does not go back in the queue when the customer writes again', async () => {
    const peer = '15557000070';
    await customerWrites(INBOX_A, peer, 'أول رسالة', 'wamid.rt-70');
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    const row = conversation.rows[0] as { id: string; version: number };
    expect(
      (await send(api, agentA, 'POST', `/conversations/${row.id}/claim`, { version: row.version }))
        .statusCode,
    ).toBe(200);

    await customerWrites(INBOX_A, peer, 'رسالة ثانية', 'wamid.rt-71');

    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ waiting_since: Date | null; assignee_membership_id: string | null }>(
        'SELECT waiting_since, assignee_membership_id FROM conversations WHERE id = $1',
        [row.id],
      ),
    );
    // Still theirs, and still not waiting: a reply from the customer is not a
    // new arrival in the Unassigned queue.
    expect(after.rows[0]?.assignee_membership_id).toBe(agentAMembershipId);
    expect(after.rows[0]?.waiting_since).toBeNull();

    const queue = await send(api, secondAgentA, 'GET', '/conversations/unassigned');
    expect((queue.json() as { data: { id: string }[] }).data.map((card) => card.id)).not.toContain(
      row.id,
    );
  });

  it('shows a conversation nobody has written to yet with no waiting time', async () => {
    // A template send opens a conversation from our side: the customer has not
    // written, so nobody is waiting, and the card has to say so rather than
    // inventing a start time.
    const peer = '15557000080';
    const template = await withTenant(api.pool, api.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_templates
           (tenant_id,connection_id,provider_template_id,template_name,language,category,status,components,variables,last_synced_at)
         VALUES($1,$2,$3,'order_update','ar','utility','approved','[{"type":"BODY","text":"تحديث الطلب"}]'::jsonb,'[]'::jsonb,now())
         RETURNING id::text`,
        [api.tenantId, inboxA, `ptid-${randomUUID()}`],
      );
      return result.rows[0]!.id;
    });
    const queued = await send(api, owner, 'POST', `/channels/${inboxA}/messages`, {
      peerIdentity: peer,
      messageType: 'template',
      text: '',
      template: { id: template, parameters: {} },
      clientMessageId: 'realtime-template-1',
    });
    expect(queued.statusCode).toBe(202);
    await dispatcher.dispatch(api.tenantId);
    await deliver(
      api,
      statusDelivery(INBOX_A, providerIdFor(peer), 'delivered', String(providerClock + 30), peer),
    );
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);

    const queue = await send(api, agentA, 'GET', '/conversations/unassigned');
    const card = (queue.json() as { data: { maskedLabel: string; waitingSinceAt: string | null }[] })
      .data.find((entry) => entry.maskedLabel === '••••080');
    expect(card).toBeDefined();
    expect(card?.waitingSinceAt).toBeNull();
  });
});

describe('the inbox surface', () => {
  const peer = '15557000090';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'الرسالة الأولى', 'wamid.rt-90');
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    const row = conversation.rows[0] as { id: string; version: number };
    conversationId = row.id;
    expect(
      (await send(api, agentA, 'POST', `/conversations/${row.id}/claim`, { version: row.version }))
        .statusCode,
    ).toBe(200);
  }, 120_000);

  it('lists only what the caller may actually read', async () => {
    const mine = await send(api, agentA, 'GET', '/conversations?queue=mine');
    expect(mine.statusCode).toBe(200);
    const rows = (mine.json() as { data: { id: string; assigneeMembershipId: string }[] }).data;
    expect(rows.map((row) => row.id)).toContain(conversationId);
    for (const row of rows) {
      // `queue=mine` means mine: an agent's `own` grant reaches nothing else,
      // so a row here that belonged to somebody else would be a leak.
      expect(row.assigneeMembershipId).toBe(agentAMembershipId);
    }

    // The same request from an agent on another inbox returns nothing at all
    // rather than a denial: they are allowed to ask, and the answer is empty.
    const theirs = await send(api, agentB, 'GET', '/conversations?queue=mine');
    expect(theirs.statusCode).toBe(200);
    expect((theirs.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('reads the timeline of a conversation the caller holds', async () => {
    const response = await send(api, agentA, 'GET', `/conversations/${conversationId}/messages`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { direction: string; text: string; delivery_state: string | null }[];
      page: { next_cursor: string | null; has_more: boolean };
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ direction: 'in', text: 'الرسالة الأولى' });
    expect(body.page.has_more).toBe(false);
  });

  it('refuses the timeline to somebody who may not read the conversation', async () => {
    expect(
      (await send(api, agentB, 'GET', `/conversations/${conversationId}/messages`)).statusCode,
    ).toBe(403);
    // The record and its contents are decided by the same rule, so they cannot
    // disagree about who may see what.
    expect((await send(api, agentB, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(
      403,
    );
  });

  it('replies to the conversation, and the reply appears on its timeline', async () => {
    const reply = await send(api, agentA, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'شكرًا لتواصلك',
      clientMessageId: 'inbox-reply-1',
    });
    expect(reply.statusCode).toBe(202);
    expect((reply.json() as { data: { command_state: string } }).data.command_state).toBe('queued');

    const timeline = await send(api, agentA, 'GET', `/conversations/${conversationId}/messages`);
    const rows = (timeline.json() as { data: { direction: string; text: string }[] }).data;
    // Oldest first: the customer's message, then ours.
    expect(rows.map((row) => row.direction)).toEqual(['in', 'out']);
    expect(rows[1]?.text).toBe('شكرًا لتواصلك');

    await dispatcher.dispatch(api.tenantId);
    const dispatched = await send(api, agentA, 'GET', `/conversations/${conversationId}/messages`);
    const sent = (dispatched.json() as { data: { command_state: string | null }[] }).data;
    expect(sent[1]?.command_state).toBe('provider_accepted');
  });

  it('ignores a recipient supplied in the body', async () => {
    const before = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbound_messages WHERE peer_identity = $1`,
        ['15550000000'],
      ),
    );
    const reply = await send(api, agentA, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'إلى شخص آخر',
      clientMessageId: 'inbox-reply-2',
      // An agent permitted to reply here must not be able to reach anyone else.
      peerIdentity: '15550000000',
    });
    expect(reply.statusCode).toBe(202);
    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbound_messages WHERE peer_identity = $1`,
        ['15550000000'],
      ),
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect((reply.json() as { data: { peer_identity: string } }).data.peer_identity).toBe(peer);
  });

  it('refuses a reply from somebody who may not reply here', async () => {
    const response = await send(api, agentB, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'لا ينبغي',
      clientMessageId: 'inbox-reply-3',
    });
    expect(response.statusCode).toBe(403);
  });

  it('pages backwards through a long conversation with an opaque cursor', async () => {
    const busy = '15557000091';
    await deliver(
      api,
      messageDelivery(
        INBOX_A,
        Array.from({ length: 60 }, (_unused, index) =>
          textMessage(`wamid.rt-page-${index}`, `رسالة ${String(index)}`, busy),
        ),
      ),
    );
    await normalizer.drain(api.tenantId);
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [busy],
      ),
    );
    const row = conversation.rows[0] as { id: string; version: number };
    expect(
      (await send(api, agentA, 'POST', `/conversations/${row.id}/claim`, { version: row.version }))
        .statusCode,
    ).toBe(200);

    const first = await send(api, agentA, 'GET', `/conversations/${row.id}/messages`);
    const firstBody = first.json() as {
      data: { id: string }[];
      page: { next_cursor: string | null; has_more: boolean };
    };
    expect(firstBody.data).toHaveLength(50);
    expect(firstBody.page.has_more).toBe(true);

    const cursor = firstBody.page.next_cursor as string;
    const second = await send(
      api,
      agentA,
      'GET',
      `/conversations/${row.id}/messages?cursor=${encodeURIComponent(cursor)}`,
    );
    const secondBody = second.json() as { data: { id: string }[]; page: { has_more: boolean } };
    expect(secondBody.data).toHaveLength(10);
    expect(secondBody.page.has_more).toBe(false);
    // No overlap: the second page continues where the first stopped rather than
    // repeating its oldest row.
    const seen = new Set(firstBody.data.map((entry) => entry.id));
    expect(secondBody.data.some((entry) => seen.has(entry.id))).toBe(false);
  });

  it('lists everything an owner may read, and filters by status', async () => {
    const status = encodeURIComponent(JSON.stringify({ key: 'status', operator: 'eq', value: 'open' }));
    const all = await send(api, owner, 'GET', `/conversations?queue=all&filter=${status}`);
    expect(all.statusCode).toBe(200);
    const rows = (all.json() as { data: { id: string; status: string }[] }).data;
    // An owner reads at tenant level, so `queue=all` is genuinely everything —
    // including conversations assigned to other people.
    expect(rows.map((row) => row.id)).toContain(conversationId);
    expect(rows.every((row) => row.status === 'open')).toBe(true);

    // The structured query is strict: unknown enums must not silently widen a
    // saved or shareable Inbox query into an unfiltered list.
    const odd = encodeURIComponent(JSON.stringify({ key: 'status', operator: 'eq', value: 'flurble' }));
    expect((await send(api, owner, 'GET', `/conversations?queue=all&filter=${odd}`)).statusCode).toBe(400);
  });

  it('reaches a team-routed conversation through the list, the timeline and a reply', async () => {
    const lead = await login(api, 'team-lead@realtime.test', MEMBER_PASSWORD);
    const list = await send(api, lead, 'GET', '/conversations?queue=all');
    const routed = (list.json() as { data: { id: string; teamId: string | null }[] }).data.find(
      (row) => row.teamId !== null,
    );
    expect(routed).toBeDefined();

    const timeline = await send(api, lead, 'GET', `/conversations/${routed?.id}/messages`);
    expect(timeline.statusCode).toBe(200);

    const reply = await send(api, lead, 'POST', `/conversations/${routed?.id}/messages`, {
      messageType: 'text',
      text: 'رد الفريق',
      clientMessageId: 'inbox-team-reply-1',
    });
    // The team term carries through every one of the three decisions.
    expect(reply.statusCode).toBe(202);
  });

  it('answers a conversation that does not exist with the same 404 everywhere', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await send(api, agentA, 'GET', `/conversations/${missing}/messages`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await send(api, agentA, 'POST', `/conversations/${missing}/messages`, {
          messageType: 'text',
          text: 'إلى العدم',
          clientMessageId: 'inbox-reply-missing',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a reply whose body is not an object', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/conversations/${conversationId}/messages`,
      headers: {
        cookie: agentA.cookie,
        'x-csrf-token': agentA.csrf,
        'content-type': 'application/json',
      },
      payload: '"just a string"',
    });
    // It reaches the send parser as an empty object and is refused there, by
    // the same rules a malformed object would be.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a cursor from another conversation', async () => {
    const other = await send(api, agentA, 'GET', `/conversations/${conversationId}/messages`);
    expect(other.statusCode).toBe(200);
    const forged = 'not.a.cursor';
    const response = await send(
      api,
      agentA,
      'GET',
      `/conversations/${conversationId}/messages?cursor=${forged}`,
    );
    // Bound to the conversation as well as the company, so a position from one
    // is not a position in another.
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('cursor_invalid');
  });
});

describe('contacts', () => {
  const peer = '15557000100';
  let contactId: string;
  let metadataLabelId: string;
  let metadataFieldId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'أول اتصال', 'wamid.rt-100');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ contact_id: string }>(
        'SELECT contact_id::text FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    contactId = row.rows[0]?.contact_id as string;
  }, 120_000);

  it('creates a contact from the first message, scoped to the channel it arrived on', async () => {
    expect(contactId).toMatch(/^[0-9a-f-]{36}$/);
    const response = await send(api, owner, 'GET', `/contacts/${contactId}`);
    expect(response.statusCode).toBe(200);
    const contact = (response.json() as { data: Record<string, unknown> }).data;
    expect(contact['displayName']).toBe(peer);

    const identities = contact['identities'] as { kind: string; externalId: string; validTo: null }[];
    // One identity, scoped to the connection it arrived on, and open-ended.
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ kind: 'whatsapp', externalId: peer, validTo: null });
  });

  it('reuses the contact for the same identity, and never guesses a link', async () => {
    await customerWrites(INBOX_A, peer, 'رسالة ثانية', 'wamid.rt-101');
    const again = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ contact_id: string }>(
        'SELECT contact_id::text FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    expect(again.rows[0]?.contact_id).toBe(contactId);

    // The same number on a *different* connection is a different identity. It
    // may well be the same person; proving that is a human's job, and guessing
    // it here is exactly what CT-03 forbids.
    await customerWrites(INBOX_B, peer, 'نفس الرقم، قناة أخرى', 'wamid.rt-102');
    const other = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ contact_id: string; connection_id: string }>(
        `SELECT contact_id::text, connection_id::text FROM conversations
          WHERE peer_identity = $1 AND connection_id = $2`,
        [peer, inboxB],
      ),
    );
    expect(other.rows[0]?.contact_id).not.toBe(contactId);
  });

  it('lists contacts and searches them by name', async () => {
    const all = await send(api, owner, 'GET', '/contacts');
    expect(all.statusCode).toBe(200);
    expect((all.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(
      contactId,
    );

    const found = await send(api, owner, 'GET', `/contacts?q=${peer.slice(-4)}`);
    expect((found.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(
      contactId,
    );
    const missing = await send(api, owner, 'GET', '/contacts?q=nobody-by-that-name');
    expect((missing.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('corrects the display name and retires the untyped attributes input', async () => {
    const response = await send(api, owner, 'PATCH', `/contacts/${contactId}`, {
      displayName: 'سارة عبد الله',
      attributes: { grade: 'الصف السادس', branch: 'المعادي' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed', details: [{ code: 'retired_input' }] } });

    const renamed = await send(api, owner, 'PATCH', `/contacts/${contactId}`, {
      displayName: 'سارة عبد الله',
    });
    expect(renamed.statusCode).toBe(200);
    const contact = (renamed.json() as { data: Record<string, unknown> }).data;
    expect(contact['displayName']).toBe('سارة عبد الله');
    expect((contact['identities'] as { externalId: string }[])[0]?.externalId).toBe(peer);
  });

  it('refuses an edit that changes nothing, or that is not valid', async () => {
    expect((await send(api, owner, 'PATCH', `/contacts/${contactId}`, {})).statusCode).toBe(400);
    expect(
      (await send(api, owner, 'PATCH', `/contacts/${contactId}`, { displayName: '' })).statusCode,
    ).toBe(400);
    expect(
      (await send(api, owner, 'PATCH', `/contacts/${contactId}`, { attributes: 'not an object' }))
        .statusCode,
    ).toBe(400);
  });

  it('records consent as evidence, and withdrawal as another record', async () => {
    const granted = await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'whatsapp',
      purpose: 'marketing',
      state: 'granted',
      source: 'agent_recorded',
      proofRef: 'call-2026-09-10',
    });
    expect(granted.statusCode).toBe(201);

    const withdrawn = await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'whatsapp',
      purpose: 'marketing',
      state: 'withdrawn',
      source: 'customer_message',
      proofRef: null,
    });
    expect(withdrawn.statusCode).toBe(201);

    const history = (withdrawn.json() as { data: { consent: { state: string; source: string }[] } })
      .data.consent;
    // Newest first, and both rows survive: withdrawing is a new fact, not an
    // edit to the old one.
    expect(history.slice(0, 2).map((entry) => entry.state)).toEqual(['withdrawn', 'granted']);
    expect(history[1]?.source).toBe('agent_recorded');

    // And the evidence cannot be edited away: the runtime role holds no UPDATE
    // or DELETE on the table at all. Both, because rewriting a withdrawal into
    // a grant and deleting it outright are the same lie told two ways.
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query('DELETE FROM consents WHERE contact_id = $1', [contactId]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query(`UPDATE consents SET state = 'granted' WHERE contact_id = $1`, [contactId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to treat an import as consent', async () => {
    const response = await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'whatsapp',
      purpose: 'marketing',
      state: 'granted',
      source: 'import',
      proofRef: null,
    });
    // A row in a spreadsheet is not somebody agreeing to be messaged (CT-07).
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'import_is_not_consent',
    );
  });

  it('refuses a grant that would paper over a suppression', async () => {
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO channel_suppressions (tenant_id, kind, peer_identity, reason)
         VALUES ($1, 'whatsapp', $2, 'opt_out')`,
        [api.tenantId, peer],
      ),
    );

    const read = await send(api, owner, 'GET', `/contacts/${contactId}`);
    // The suppression is shown beside the consent, because it is the one in
    // force and an operator reading a granted consent needs to see it.
    expect((read.json() as { data: { suppressed: string[] } }).data.suppressed).toEqual([
      'whatsapp',
    ]);

    const response = await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'whatsapp',
      purpose: 'marketing',
      state: 'granted',
      source: 'agent_recorded',
      proofRef: null,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'suppression_outranks_consent',
    );

    // Withdrawing is still allowed: agreeing with a suppression is never the
    // thing to block.
    expect(
      (
        await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
          channel: 'whatsapp',
          purpose: 'service',
          state: 'withdrawn',
          source: 'customer_message',
          proofRef: null,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('refuses a consent record that is not one', async () => {
    const response = await send(api, owner, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'telepathy',
      purpose: 'whatever',
      state: 'maybe',
      source: 'a dream',
    });
    expect(response.statusCode).toBe(400);
    const fields = (response.json() as { error: { details: { field: string }[] } }).error.details.map(
      (detail) => detail.field,
    );
    expect(fields).toEqual(['channel', 'purpose', 'state', 'source']);
  });

  it('lets an agent edit the contact of a conversation they hold, and no other', async () => {
    // agentA holds a conversation with this peer on inbox A.
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1 AND connection_id = $2',
        [peer, inboxA],
      ),
    );
    const row = conversation.rows[0] as { id: string; version: number };
    expect(
      (await send(api, agentA, 'POST', `/conversations/${row.id}/claim`, { version: row.version }))
        .statusCode,
    ).toBe(200);

    expect(
      (await send(api, agentA, 'PATCH', `/contacts/${contactId}`, { displayName: 'سارة ع.' }))
        .statusCode,
    ).toBe(200);

    // agentB holds nothing with this person, so the same edit is refused.
    expect(
      (await send(api, agentB, 'PATCH', `/contacts/${contactId}`, { displayName: 'لا' })).statusCode,
    ).toBe(403);
  });

  it('reads a contact whose identity was closed, and one with none at all', async () => {
    // Both shapes a future merge or rotation can leave behind. Neither is
    // reachable through the API today, and both have to render.
    const made = await withTenant(api.pool, api.tenantId, async (client) => {
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'بلا هوية') RETURNING id::text`,
        [api.tenantId],
      );
      const bare = contact.rows[0]?.id as string;
      const closed = await client.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'هوية منتهية') RETURNING id::text`,
        [api.tenantId],
      );
      const rotated = closed.rows[0]?.id as string;
      await client.query(
        `INSERT INTO contact_identities
           (tenant_id, contact_id, kind, scope_id, external_id, valid_from, valid_to)
         VALUES ($1, $2, 'whatsapp', $3, '15550009999', now() - interval '2 days', now() - interval '1 day')`,
        [api.tenantId, rotated, inboxA],
      );
      return { bare, rotated };
    });

    const bare = await send(api, owner, 'GET', `/contacts/${made.bare}`);
    expect(bare.statusCode).toBe(200);
    const bareBody = (bare.json() as { data: { identities: unknown[]; suppressed: unknown[] } }).data;
    expect(bareBody.identities).toEqual([]);
    // No live identity means no channel a suppression could be about.
    expect(bareBody.suppressed).toEqual([]);

    const rotated = await send(api, owner, 'GET', `/contacts/${made.rotated}`);
    const identities = (rotated.json() as { data: { identities: { validTo: string | null }[] } }).data
      .identities;
    // A closed interval is returned, not hidden: messages sent while it was
    // live belong to whoever held it then.
    expect(identities[0]?.validTo).not.toBeNull();

    // And both are in the directory. Dropping a contact from the list because
    // no identity row survived would lose the consent history attached to it.
    const listed = await send(api, owner, 'GET', '/contacts');
    const rows = (listed.json() as { data: { id: string; identities: unknown[] }[] }).data;
    expect(rows.find((row) => row.id === made.bare)?.identities).toEqual([]);
    expect(rows.find((row) => row.id === made.rotated)?.identities).toHaveLength(1);
  });

  it('refuses the retired untyped attributes input', async () => {
    const response = await send(api, owner, 'PATCH', `/contacts/${contactId}`, {
      attributes: { plan: 'سنوي' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed', details: [{ code: 'retired_input' }] } });
  });

  it('refuses a body that is not an object at all', async () => {
    const response = await api.server.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${api.tenantId}/contacts/${contactId}`,
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'content-type': 'application/json',
      },
      payload: '"a string"',
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates a versioned label and typed contact field catalogue', async () => {
    const label = await send(api, owner, 'POST', '/labels', {
      name: 'مهتم بالدورات',
      color: '#5865f2',
    });
    expect(label.statusCode).toBe(201);
    metadataLabelId = (label.json() as { data: { id: string; color: string } }).data.id;
    expect((label.json() as { data: { color: string } }).data.color).toBe('#5865F2');

    const field = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact',
      key: 'course_interest',
      name: 'الدورة المطلوبة',
      type: 'single_select',
      options: ['Data Analysis', 'Digital Marketing'],
    });
    expect(field.statusCode).toBe(201);
    metadataFieldId = (field.json() as { data: { id: string } }).data.id;

    expect((await send(api, owner, 'GET', '/labels')).statusCode).toBe(200);
    expect((await send(api, owner, 'GET', '/custom-fields?target=contact')).statusCode).toBe(200);
    expect((await send(api, agentA, 'POST', '/labels', { name: 'مرفوض', color: '#112233' })).statusCode).toBe(403);
  });

  it('assigns contact metadata atomically and filters on stored typed values', async () => {
    const before = await send(api, owner, 'GET', `/contacts/${contactId}`);
    const version = (before.json() as { data: { version: number } }).data.version;
    const changed = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version,
      addLabels: [metadataLabelId],
      fields: [{ fieldId: metadataFieldId, value: 'Data Analysis' }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ data: { version: version + 1 } });

    const byLabel = await send(api, owner, 'GET', `/contacts?label=${metadataLabelId}`);
    expect((byLabel.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(contactId);
    const byField = await send(api, owner, 'GET', `/contacts?fieldId=${metadataFieldId}&fieldValue=Data%20Analysis`);
    expect((byField.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(contactId);

    const stale = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version,
      removeLabels: [metadataLabelId],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'entity_version_conflict' } });
  });

  it('protects definitions in use and lets retired metadata be removed', async () => {
    const fieldRows = await send(api, owner, 'GET', '/custom-fields?target=contact');
    const field = (fieldRows.json() as { data: { id: string; version: number }[] }).data.find((row) => row.id === metadataFieldId);
    const unsafe = await send(api, owner, 'PATCH', `/custom-fields/${metadataFieldId}`, {
      version: field?.version,
      options: ['Digital Marketing'],
    });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json()).toMatchObject({ error: { code: 'field_options_in_use' } });

    const labels = await send(api, owner, 'GET', '/labels');
    const label = (labels.json() as { data: { id: string; version: number }[] }).data.find((row) => row.id === metadataLabelId);
    const renamed = await send(api, owner, 'PATCH', `/labels/${metadataLabelId}`, {
      version: label?.version,
      name: 'مهتم بالتسجيل',
    });
    const retired = await send(api, owner, 'DELETE', `/labels/${metadataLabelId}`, {
      version: (renamed.json() as { data: { version: number } }).data.version,
    });
    expect(retired.statusCode).toBe(200);

    const current = await send(api, owner, 'GET', `/contacts/${contactId}`);
    const removed = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version: (current.json() as { data: { version: number } }).data.version,
      removeLabels: [metadataLabelId],
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { data: { metadata: { labels: unknown[] } } }).data.metadata.labels).toEqual([]);

    const all = await send(api, owner, 'GET', '/labels?includeRetired=true');
    expect((all.json() as { data: { id: string; state: string }[] }).data).toContainEqual(expect.objectContaining({ id: metadataLabelId, state: 'retired' }));
  });

  it('writes conversation metadata and append-only evidence without false no-op events', async () => {
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE contact_id = $1 LIMIT 1', [contactId]),
    );
    const conversationIdForContact = conversation.rows[0]?.id as string;
    const definition = await send(api, owner, 'POST', '/custom-fields', {
      target: 'conversation', key: 'lead_temperature', name: 'Lead temperature',
      type: 'text', options: [],
    });
    const fieldId = (definition.json() as { data: { id: string } }).data.id;
    const record = await send(api, owner, 'GET', `/conversations/${conversationIdForContact}`);
    const version = (record.json() as { data: { version: number } }).data.version;
    const changed = await send(api, owner, 'PATCH', `/conversations/${conversationIdForContact}/metadata`, {
      version, fields: [{ fieldId, value: 'Hot lead' }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const afterVersion = (changed.json() as { data: { version: number } }).data.version;
    const noOp = await send(api, owner, 'PATCH', `/conversations/${conversationIdForContact}/metadata`, {
      version: afterVersion, fields: [{ fieldId, value: 'Hot lead' }],
    });
    expect(noOp.statusCode).toBe(200);
    expect((noOp.json() as { data: { version: number } }).data.version).toBe(afterVersion);

    const evidence = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM metadata_audit
          WHERE entity_id = $1 AND act = 'field_value_set'`,
        [conversationIdForContact],
      ),
    );
    expect(evidence.rows[0]?.count).toBe('1');
  });

  it('enforces catalogue uniqueness, versions, option safety and retirement', async () => {
    const firstLabel = await send(api, owner, 'POST', '/labels', {
      name: 'Catalogue conflict', color: '#123456',
    });
    expect(firstLabel.statusCode).toBe(201);
    const label = (firstLabel.json() as { data: { id: string; version: number } }).data;
    expect((await send(api, owner, 'POST', '/labels', {
      name: 'catalogue conflict', color: '#654321',
    })).json()).toMatchObject({ error: { code: 'label_exists' } });
    expect((await send(api, owner, 'PATCH', `/labels/${label.id}`, {
      version: label.version + 1, name: 'Stale name',
    })).json()).toMatchObject({ error: { code: 'label_version_conflict' } });
    expect((await send(api, owner, 'PATCH', '/labels/99999999-9999-4999-8999-999999999999', {
      version: 1, name: 'Missing',
    })).statusCode).toBe(404);
    const recolored = await send(api, owner, 'PATCH', `/labels/${label.id}`, {
      version: label.version, color: '#FEDCBA',
    });
    expect(recolored.statusCode, recolored.body).toBe(200);

    const textResponse = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'catalogue_notes', name: 'Catalogue notes', type: 'text', options: [],
    });
    const textField = (textResponse.json() as { data: { id: string; version: number } }).data;
    expect((await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'catalogue_notes', name: 'Duplicate', type: 'text', options: [],
    })).json()).toMatchObject({ error: { code: 'custom_field_exists' } });
    expect((await send(api, owner, 'PATCH', `/custom-fields/${textField.id}`, {
      version: textField.version, options: ['not valid for text'],
    })).json()).toMatchObject({ error: { code: 'validation_failed' } });

    const optionsConfirmed = await send(api, owner, 'PATCH', `/custom-fields/${textField.id}`, {
      version: textField.version, options: [],
    });
    expect(optionsConfirmed.statusCode, optionsConfirmed.body).toBe(200);
    const optionsVersion = (optionsConfirmed.json() as { data: { version: number } }).data.version;
    const renamed = await send(api, owner, 'PATCH', `/custom-fields/${textField.id}`, {
      version: optionsVersion, name: 'Notes renamed',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const renamedField = (renamed.json() as { data: { version: number } }).data;
    expect((await send(api, owner, 'PATCH', `/custom-fields/${textField.id}`, {
      version: optionsVersion, name: 'Stale',
    })).json()).toMatchObject({ error: { code: 'field_version_conflict' } });
    const retired = await send(api, owner, 'DELETE', `/custom-fields/${textField.id}`, {
      version: renamedField.version,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const retiredField = (retired.json() as { data: { version: number; state: string } }).data;
    expect(retiredField.state).toBe('retired');
    expect((await send(api, owner, 'PATCH', `/custom-fields/${textField.id}`, {
      version: retiredField.version, name: 'Cannot revive',
    })).json()).toMatchObject({ error: { code: 'field_version_conflict' } });
    expect((await send(api, owner, 'DELETE', `/custom-fields/${textField.id}`, {
      version: retiredField.version,
    })).json()).toMatchObject({ error: { code: 'field_version_conflict' } });
    expect((await send(api, owner, 'PATCH', '/custom-fields/99999999-9999-4999-8999-999999999999', {
      version: 1, name: 'Missing',
    })).statusCode).toBe(404);

    const conversationSelect = await send(api, owner, 'POST', '/custom-fields', {
      target: 'conversation', key: 'catalogue_stage', name: 'Stage', type: 'single_select',
      options: ['New', 'Qualified'],
    });
    const select = (conversationSelect.json() as { data: { id: string; version: number } }).data;
    const safe = await send(api, owner, 'PATCH', `/custom-fields/${select.id}`, {
      version: select.version, options: ['New', 'Qualified', 'Won'],
    });
    expect(safe.statusCode, safe.body).toBe(200);
    expect((await send(api, owner, 'GET', '/custom-fields?includeRetired=true')).statusCode).toBe(200);
  });

  it('validates every metadata mutation and supports explicit clears', async () => {
    const labelResponse = await send(api, owner, 'POST', '/labels', {
      name: 'Mutation coverage', color: '#ABCDEF',
    });
    const labelId = (labelResponse.json() as { data: { id: string } }).data.id;
    const wrongTargetResponse = await send(api, owner, 'POST', '/custom-fields', {
      target: 'conversation', key: 'wrong_contact_target', name: 'Wrong target', type: 'text', options: [],
    });
    const wrongTargetId = (wrongTargetResponse.json() as { data: { id: string } }).data.id;

    const readVersion = async (): Promise<number> => {
      const response = await send(api, owner, 'GET', `/contacts/${contactId}`);
      return (response.json() as { data: { version: number } }).data.version;
    };
    let version = await readVersion();
    const assigned = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, addLabels: [labelId, labelId], fields: [{ fieldId: metadataFieldId, value: 'Digital Marketing' }],
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    version = (assigned.json() as { data: { version: number } }).data.version;

    const noOp = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, addLabels: [labelId], removeLabels: [],
    });
    expect((noOp.json() as { data: { version: number } }).data.version).toBe(version);
    const absentRemoval = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, removeLabels: [metadataLabelId],
    });
    expect((absentRemoval.json() as { data: { version: number } }).data.version).toBe(version);

    for (const body of [
      { version, fields: [{ fieldId: metadataFieldId, value: 'Unknown course' }] },
      { version, fields: [{ fieldId: wrongTargetId, value: 'wrong' }] },
      { version, fields: [{ fieldId: '99999999-9999-4999-8999-999999999999', value: 'missing' }] },
    ]) {
      const refused = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, body);
      expect(refused.statusCode).toBe(422);
    }
    expect((await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, addLabels: [metadataLabelId],
    })).json()).toMatchObject({ error: { code: 'label_unavailable' } });

    const cleared = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, fields: [{ fieldId: metadataFieldId, value: null }],
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    version = (cleared.json() as { data: { version: number } }).data.version;
    const clearedAgain = await send(api, owner, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, fields: [{ fieldId: metadataFieldId, value: null }],
    });
    expect((clearedAgain.json() as { data: { version: number } }).data.version).toBe(version);

    const conversationRows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE contact_id = $1 LIMIT 1', [contactId]),
    );
    const conversationId = conversationRows.rows[0]?.id as string;
    const record = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    let conversationVersion = (record.json() as { data: { version: number } }).data.version;
    const added = await send(api, owner, 'PATCH', `/conversations/${conversationId}/metadata`, {
      version: conversationVersion, addLabels: [labelId],
    });
    conversationVersion = (added.json() as { data: { version: number } }).data.version;
    const removed = await send(api, owner, 'PATCH', `/conversations/${conversationId}/metadata`, {
      version: conversationVersion, removeLabels: [labelId],
    });
    expect(removed.statusCode, removed.body).toBe(200);

    expect((await send(api, agentB, 'PATCH', `/contacts/${contactId}/metadata`, {
      version, addLabels: [labelId],
    })).statusCode).toBe(403);
    expect((await send(api, owner, 'PATCH', '/contacts/99999999-9999-4999-8999-999999999999/metadata', {
      version: 1, addLabels: [labelId],
    })).statusCode).toBe(404);
    expect((await send(api, agentB, 'PATCH', `/conversations/${conversationId}/metadata`, {
      version: conversationVersion + 1, addLabels: [labelId],
    })).statusCode).toBe(403);
    expect((await send(api, owner, 'PATCH', '/conversations/99999999-9999-4999-8999-999999999999/metadata', {
      version: 1, addLabels: [labelId],
    })).statusCode).toBe(404);
  });

  it('validates and applies contact and inbox filters without filtering after pagination', async () => {
    const numberField = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'filter_number', name: 'Number filter', type: 'number', options: [],
    });
    const booleanField = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'filter_boolean', name: 'Boolean filter', type: 'boolean', options: [],
    });
    const multiField = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'filter_multi', name: 'Multi filter', type: 'multi_select', options: ['A', 'B'],
    });
    const textField = await send(api, owner, 'POST', '/custom-fields', {
      target: 'contact', key: 'filter_text', name: 'Text filter', type: 'text', options: [],
    });
    const ids = [numberField, booleanField, multiField, textField].map((response) =>
      (response.json() as { data: { id: string } }).data.id,
    );

    for (const path of [
      `/contacts?fieldId=${ids[0]}&fieldValue=4`,
      `/contacts?fieldId=${ids[1]}&fieldValue=true`,
      `/contacts?fieldId=${ids[1]}&fieldValue=false`,
      `/contacts?fieldId=${ids[2]}&fieldValue=A%2CB`,
      `/contacts?fieldId=${ids[3]}&fieldValue=%D8%B3%D8%A7%D8%B1%D8%A9`,
    ]) expect((await send(api, owner, 'GET', path)).statusCode).toBe(200);

    for (const path of [
      '/contacts?fieldId=bad&fieldValue=x',
      '/contacts?label=bad',
      `/contacts?fieldId=${ids[0]}`,
      '/contacts?fieldValue=x',
      '/contacts?fieldId=99999999-9999-4999-8999-999999999999&fieldValue=x',
      `/contacts?fieldId=${ids[0]}&fieldValue=not-a-number`,
      `/contacts?fieldId=${ids[1]}&fieldValue=not-a-boolean`,
      `/contacts?fieldId=${ids[2]}&fieldValue=unknown`,
    ]) expect((await send(api, owner, 'GET', path)).statusCode).toBeGreaterThanOrEqual(400);

    const repeatedLabels = new URLSearchParams();
    for (let index = 0; index < 21; index += 1) repeatedLabels.append('label', '99999999-9999-4999-8999-999999999999');
    expect((await send(api, owner, 'GET', `/contacts?${repeatedLabels.toString()}`)).statusCode).toBe(400);

    const validId = '99999999-9999-4999-8999-999999999999';
    const inboxFilter = (filter: unknown): string => `filter=${encodeURIComponent(JSON.stringify(filter))}`;
    expect((await send(api, owner, 'GET', `/conversations?queue=all&${inboxFilter({ key: 'status', operator: 'eq', value: 'open' })}`)).statusCode).toBe(200);
    expect((await send(api, owner, 'GET', `/conversations?${inboxFilter({ key: 'unread', operator: 'eq', value: false })}`)).statusCode).toBe(200);
    expect((await send(api, owner, 'GET', `/conversations/unassigned?priority=urgent&channel=instagram&inboxId=${validId}`)).statusCode).toBe(200);
    for (const path of [
      '/conversations?unread=maybe',
      '/conversations?priority=critical',
      '/conversations?channel=telegram',
      '/conversations?inboxId=bad',
      '/conversations?teamId=bad',
      '/conversations?assigneeId=bad',
      '/conversations?label=bad',
    ]) expect((await send(api, owner, 'GET', path)).statusCode).toBe(400);
    expect((await send(api, owner, 'GET', `/conversations?${repeatedLabels.toString()}`)).statusCode).toBe(400);

    const noContactReaderId = await addMember(api, 'integration-filter@realtime.test', 'integration_developer', [
      { type: 'tenant', id: null },
    ]);
    expect(noContactReaderId).toBeTruthy();
    const noContactReader = await login(api, 'integration-filter@realtime.test', MEMBER_PASSWORD);
    expect((await send(api, noContactReader, 'GET', '/contacts')).statusCode).toBe(403);
    expect((await send(api, noContactReader, 'PATCH', `/contacts/${contactId}/metadata`, {
      version: 1, addLabels: ['99999999-9999-4999-8999-999999999999'],
    })).statusCode).toBe(403);
    const teamScopedId = await addMember(api, 'team-filter@realtime.test', 'supervisor', [
      { type: 'team', id: validId },
    ]);
    expect(teamScopedId).toBeTruthy();
    const teamScoped = await login(api, 'team-filter@realtime.test', MEMBER_PASSWORD);
    expect((await send(api, teamScoped, 'GET', '/contacts')).statusCode).toBe(200);
    expect((await send(api, teamScoped, 'GET', `/contacts/${contactId}`)).statusCode).toBe(403);
    expect((await send(api, teamScoped, 'PATCH', `/contacts/${contactId}/metadata`, {
      version: 1, addLabels: ['99999999-9999-4999-8999-999999999999'],
    })).statusCode).toBe(403);
    expect((await send(api, agentA, 'GET', '/contacts')).statusCode).toBe(200);
    expect((await send(api, agentB, 'GET', `/contacts/${contactId}`)).statusCode).toBe(403);
  });

  it('refuses consent from somebody without the grant', async () => {
    const analyst = await login(api, 'analyst@realtime.test', MEMBER_PASSWORD);
    const response = await send(api, analyst, 'POST', `/contacts/${contactId}/consents`, {
      channel: 'whatsapp',
      purpose: 'service',
      state: 'withdrawn',
      source: 'agent_recorded',
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers a contact that does not exist with a 404', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await send(api, owner, 'GET', `/contacts/${missing}`)).statusCode).toBe(404);
    expect(
      (await send(api, owner, 'PATCH', `/contacts/${missing}`, { displayName: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (
        await send(api, owner, 'POST', `/contacts/${missing}/consents`, {
          channel: 'whatsapp',
          purpose: 'service',
          state: 'granted',
          source: 'agent_recorded',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('revocation', () => {
  it('stops the feed the moment an inbox is taken away', async () => {
    const membership = agentBMembershipId;
    // Give agent B access to inbox A, then take it away again, with a message
    // in between so the difference is visible rather than assumed.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, 'inbox', $3)`,
        [api.tenantId, membership, inboxA],
      ),
    );
    const granted = await feed(agentB);
    expect(granted.events.length).toBeGreaterThan(0);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `DELETE FROM membership_scopes
          WHERE membership_id = $1 AND scope_type = 'inbox' AND scope_id = $2`,
        [membership, inboxA],
      ),
    );
    await customerWrites(INBOX_A, '15557000020', 'بعد السحب', 'wamid.rt-20');

    // No reconnect and no new login: the next page simply stops carrying that
    // inbox. Their own inbox is untouched, which is what makes this a narrowing
    // rather than a logout.
    const after = await feed(agentB);
    expect(after.events.filter((event) => event.scope.inboxId === inboxA)).toEqual([]);
    expect(JSON.stringify(after.events)).not.toContain('بعد السحب');
  });

  it('answers a revoked membership the way it answers a stranger', async () => {
    await addMember(api, 'leaver@realtime.test', 'agent', [{ type: 'inbox', id: inboxA }]);
    const leaver = await login(api, 'leaver@realtime.test', MEMBER_PASSWORD);
    expect((await send(api, leaver, 'GET', '/realtime/events')).statusCode).toBe(200);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE memberships SET status = 'revoked'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        ['leaver@realtime.test'],
      ),
    );
    expect((await send(api, leaver, 'GET', '/realtime/events')).statusCode).toBe(404);
  });
});

describe('delivery receipts on the feed', () => {
  it('reports each receipt as its own event, in the order they moved the state', async () => {
    const peer = '15557000030';
    await customerWrites(INBOX_A, peer, 'افتح النافذة', 'wamid.rt-30');
    const before = await feed(owner);

    const queued = await send(api, owner, 'POST', `/channels/${inboxA}/messages`, {
      peerIdentity: peer,
      messageType: 'text',
      text: 'رد الفريق',
      clientMessageId: 'realtime-receipt-1',
    });
    expect(queued.statusCode).toBe(202);
    await dispatcher.dispatch(api.tenantId);

    for (const [state, stamp] of [
      ['delivered', String(providerClock + 10)],
      ['read', String(providerClock + 11)],
    ] as const) {
      await deliver(api, statusDelivery(INBOX_A, providerIdFor(peer), state, stamp, peer));
      await normalizer.drain(api.tenantId);
      await dispatcher.reconcileReceipts(api.tenantId);
    }

    const page = await feed(owner, before.cursor);
    const receipts = page.events.filter((event) => event.type === 'message.delivery');
    expect(receipts.map((event) => event.payload['deliveryState'])).toEqual(['delivered', 'read']);
    // The entity version is the delivery rank, so a receipt that arrives out of
    // order is recognisable as older without a separate counter.
    expect(receipts.map((event) => event.entity.version)).toEqual([2, 3]);
    expect(receipts[0]?.entity.type).toBe('message');
  });

  it('never rolls a read back to delivered, and says so once', async () => {
    const peer = '15557000031';
    await customerWrites(INBOX_A, peer, 'خارج الترتيب', 'wamid.rt-31');
    const queued = await send(api, owner, 'POST', `/channels/${inboxA}/messages`, {
      peerIdentity: peer,
      messageType: 'text',
      text: 'رد آخر',
      clientMessageId: 'realtime-receipt-2',
    });
    expect(queued.statusCode).toBe(202);
    await dispatcher.dispatch(api.tenantId);
    const before = await feed(owner);

    // Read first, then the delivered receipt that was overtaken.
    const readAt = providerClock + 21;
    await deliver(api, statusDelivery(INBOX_A, providerIdFor(peer), 'read', String(readAt), peer));
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);
    await deliver(
      api,
      statusDelivery(INBOX_A, providerIdFor(peer), 'delivered', String(readAt - 1), peer),
    );
    await normalizer.drain(api.tenantId);
    await dispatcher.reconcileReceipts(api.tenantId);

    const page = await feed(owner, before.cursor);
    const receipts = page.events.filter((event) => event.type === 'message.delivery');
    // One event, not two: the late `delivered` changed nothing except the
    // anomaly, and the state stayed where it was.
    expect(receipts.map((event) => event.payload['deliveryState'])).toEqual(['read', 'read']);
    expect(receipts.at(-1)?.payload['anomaly']).toBe('delivered_after_read');
  });
});

describe('feed ordering', () => {
  it('orders by number once the feed passes ten events', async () => {
    const page = await feed(owner);
    expect(page.events.length).toBeGreaterThan(10);
    const seqs = page.events.map((event) => event.seq);
    // The bug this guards is textual ordering, which is invisible below ten and
    // then puts event 10 immediately after event 1 — taking the cursor
    // backwards and re-delivering everything in between forever.
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(seqs.at(-1)).toBe(Math.max(...seqs));
  });
});

describe('the stream', () => {
  async function stream(
    browser: Browser,
    query = '',
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/realtime/stream${query}`,
      headers: { cookie: browser.cookie, ...headers },
    });
  }

  function framesOf(payload: string): { event: string; data: Record<string, unknown> }[] {
    return payload
      .split('\n\n')
      .filter((block) => block.includes('event: '))
      .map((block) => {
        const event = /event: (.+)/.exec(block)?.[1] ?? '';
        const data = /data: (.+)/.exec(block)?.[1] ?? '{}';
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      });
  }

  it('sends what happened, then closes on its own with a reason', async () => {
    const response = await stream(owner);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    // A reconnect floor, so a fleet does not all come back on the same tick.
    expect(response.payload).toContain('retry: ');

    const frames = framesOf(response.payload);
    expect(frames.some((entry) => entry.event === 'message.inbound')).toBe(true);
    const last = frames.at(-1);
    // A planned cycle, said out loud, so a client can tell it from a network
    // failure and reconnect without alarm.
    expect(last?.event).toBe('stream_cycled');
    expect(last?.data['reason']).toBe('max_stream_age');
  }, 20_000);

  it('resumes from Last-Event-ID and repeats nothing', async () => {
    const first = await stream(owner);
    const frames = framesOf(first.payload);
    const cursor = frames.find((entry) => entry.event === 'stream_cycled')?.data['reason'];
    expect(cursor).toBe('max_stream_age');
    const lastEventId = /id: (.+)/.exec(first.payload.split('\n\n').at(-2) ?? '')?.[1] ?? '';

    await customerWrites(INBOX_A, '15557000040', 'بعد إعادة الاتصال', 'wamid.rt-40');
    const second = await stream(owner, '', { 'last-event-id': lastEventId });
    const events = framesOf(second.payload).filter((entry) => entry.event === 'message.inbound');
    // Exactly the message that arrived while the client was away.
    expect(events).toHaveLength(1);
    expect(events[0]?.data['payload']).toMatchObject({ text: 'بعد إعادة الاتصال' });
  }, 20_000);

  it('does not skip later frames when a batch is interrupted after its first event', async () => {
    const before = await feed(owner);
    await customerWrites(INBOX_A, '15557000091', 'batch first', 'wamid.rt-batch-91');
    await customerWrites(INBOX_A, '15557000092', 'batch second', 'wamid.rt-batch-92');
    const first = await stream(owner, `?cursor=${encodeURIComponent(before.cursor)}`);
    const inbound = framesOf(first.payload).filter((frame) =>
      frame.event === 'message.inbound' &&
      (frame.data['payload'] as Record<string, unknown> | undefined)?.['text']?.toString().startsWith('batch '),
    );
    expect(inbound).toHaveLength(2);
    const firstCursor = inbound[0]?.data['cursor'];
    expect(typeof firstCursor).toBe('string');
    expect(firstCursor).not.toBe(inbound[1]?.data['cursor']);
    const resumed = await stream(owner, '', { 'last-event-id': firstCursor as string });
    const replayed = framesOf(resumed.payload).filter((frame) => frame.event === 'message.inbound');
    expect(replayed.some((frame) => (frame.data['payload'] as Record<string, unknown>)['text'] === 'batch second')).toBe(true);
    expect(replayed.some((frame) => (frame.data['payload'] as Record<string, unknown>)['text'] === 'batch first')).toBe(false);
  }, 20_000);

  it('projects for an agent on the stream exactly as it does on the page', async () => {
    await customerWrites(INBOX_A, '15557000050', 'قبل المطالبة', 'wamid.rt-50');
    const conversation = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        '15557000050',
      ]),
    );
    const unclaimed = conversation.rows[0]?.id;

    const response = await stream(agentA);
    const frames = framesOf(response.payload).filter((entry) => {
      const scope = entry.data['scope'] as { conversationId?: string } | undefined;
      return entry.event === 'message.inbound' && scope?.conversationId === unclaimed;
    });
    expect(frames.length).toBeGreaterThan(0);
    for (const entry of frames) {
      const payload = entry.data['payload'] as Record<string, unknown>;
      // The socket is not a way around the endpoint: the same agent, the same
      // conversation, the same projection as the JSON page gives.
      expect(payload['projected']).toBe(true);
      expect(payload['text']).toBeUndefined();
      expect(payload['maskedLabel']).toBe('••••050');
    }
  }, 20_000);

  it('refuses to open for a caller with no membership, before any bytes are written', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/99999999-9999-4999-8999-999999999999/realtime/stream`,
      headers: { cookie: owner.cookie },
    });
    // A 200 stream that closed immediately would be indistinguishable from a
    // working subscription with nothing to say.
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('refuses to open without a session', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/realtime/stream`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('tells a client whose cursor is unusable to start again', async () => {
    const response = await stream(owner, '?cursor=not-a-cursor');
    const frames = framesOf(response.payload);
    expect(frames[0]).toMatchObject({ event: 'reset_required' });
    expect(frames[0]?.data['reason']).toBe('malformed');
  }, 20_000);

  it('closes a stream whose membership is revoked while it is open', async () => {
    await addMember(api, 'streamer@realtime.test', 'agent', [{ type: 'inbox', id: inboxA }]);
    const streamer = await login(api, 'streamer@realtime.test', MEMBER_PASSWORD);
    const revoke = withTenant(api.pool, api.tenantId, async (client) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query(
        `UPDATE memberships SET status = 'revoked'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        ['streamer@realtime.test'],
      );
    });
    const [response] = await Promise.all([stream(streamer), revoke]);

    const last = framesOf(response.payload).at(-1);
    // Not a silent stop: the client is told this is not worth reconnecting for.
    expect(last?.event).toBe('stream_closed');
    expect(last?.data['reason']).toBe('access_revoked');
  }, 20_000);
});

describe('durable member notifications', () => {
  it('paginates a member-owned history and marks all unread records without affecting another member', async () => {
    const memberId = await addMember(api, 'notification-pager@realtime.test', 'agent', [{ type: 'inbox', id: inboxA }]);
    const browser = await login(api, 'notification-pager@realtime.test', MEMBER_PASSWORD);
    const service = api.app.get(NotificationService);
    const targets = [randomUUID(), randomUUID(), randomUUID()];
    for (const targetId of targets) {
      await withTenant(api.pool, api.tenantId, (client) => service.create(asExecutor(client), api.tenantId, {
        recipientMembershipId: memberId, kind: 'assignment', targetType: 'conversation', targetId,
        dedupeKey: `pagination:${targetId}`,
      }));
    }
    const first = await send(api, browser, 'GET', '/notifications?limit=2');
    expect(first.statusCode, first.payload).toBe(200);
    const firstPage = first.json() as { data: { id: string }[]; page: { next_cursor: string | null } };
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.page.next_cursor).not.toBeNull();
    const second = await send(api, browser, 'GET', `/notifications?limit=2&cursor=${encodeURIComponent(firstPage.page.next_cursor!)}`);
    expect(second.statusCode, second.payload).toBe(200);
    const secondPage = second.json() as { data: { id: string }[]; page: { next_cursor: string | null } };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.page.next_cursor).toBeNull();
    expect(new Set([...firstPage.data, ...secondPage.data].map((row) => row.id)).size).toBe(3);
    expect((await send(api, browser, 'GET', '/notifications/unread-count')).json()).toMatchObject({ data: { count: 3 } });
    expect((await send(api, browser, 'POST', '/notifications/read-all')).json()).toMatchObject({ data: { changed: 3 } });
    expect((await send(api, browser, 'GET', '/notifications/unread-count')).json()).toMatchObject({ data: { count: 0 } });
    expect((await send(api, owner, 'GET', '/notifications/unread-count')).statusCode).toBe(200);
    expect((await send(api, owner, 'POST', `/notifications/${firstPage.data[0]?.id}/read`)).statusCode).toBe(404);
    expect((await send(api, browser, 'GET', '/notifications?unexpected=1')).statusCode).toBe(400);
  });

  it('shows an authorized in-app message preview only to its recipient', async () => {
    const peer = '15557000990';
    await customerWrites(INBOX_A, peer, 'opening message', 'wamid.rt-notify-open');
    const row = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string; version: number }>(
      'SELECT id::text,version FROM conversations WHERE peer_identity=$1', [peer],
    ));
    const conversation = row.rows[0]!;
    const assigned = await send(api, owner, 'POST', `/conversations/${conversation.id}/assignments`, {
      version: conversation.version, assigneeMembershipId: agentAMembershipId,
    });
    expect(assigned.statusCode, assigned.payload).toBe(200);
    await customerWrites(INBOX_A, peer, 'private customer words', 'wamid.rt-notify-reply');
    const list = await send(api, agentA, 'GET', '/notifications?limit=25');
    expect(list.statusCode).toBe(200);
    const matching = (list.json() as { data: { kind: string; targetId: string; messagePreview: string | null }[] }).data
      .filter((entry) => entry.targetId === conversation.id);
    expect(matching.map((entry) => entry.kind).sort()).toEqual(['assignment', 'new_message']);
    expect(matching.find((entry) => entry.kind === 'new_message')?.messagePreview).toBe('private customer words');
    const ownerList = await send(api, owner, 'GET', '/notifications?limit=25');
    expect(ownerList.payload).not.toContain(conversation.id);
  });

  it('dedupes records, isolates recipients, and synchronizes read state over SSE', async () => {
    const service = api.app.get(NotificationService);
    const targetId = randomUUID();
    const deviceId = randomUUID();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription-opaque';
    const registered = await send(api, agentA, 'POST', `/notifications/devices/${deviceId}`, {
      subscription: { endpoint, keys: {
        p256dh: Buffer.alloc(65, 5).toString('base64url'),
        auth: Buffer.alloc(16, 6).toString('base64url'),
      } },
    });
    expect(registered.statusCode, registered.payload).toBe(200);
    const secondDeviceId = randomUUID();
    const secondEndpoint = 'https://updates.push.services.mozilla.com/wpush/v2/another-opaque-subscription';
    const secondRegistered = await send(api, agentA, 'POST', `/notifications/devices/${secondDeviceId}`, {
      subscription: { endpoint: secondEndpoint, keys: {
        p256dh: Buffer.alloc(65, 7).toString('base64url'),
        auth: Buffer.alloc(16, 8).toString('base64url'),
      } },
    });
    expect(secondRegistered.statusCode, secondRegistered.payload).toBe(200);
    const devices = await send(api, agentA, 'GET', '/notifications/devices');
    expect(devices.statusCode).toBe(200);
    expect(devices.payload).not.toContain(endpoint);
    expect(devices.payload).not.toContain(secondEndpoint);
    expect((devices.json() as { data: unknown[] }).data).toHaveLength(2);
    const beforeAgent = await feed(agentA);
    const beforeOwner = await feed(owner);
    const create = () => withTenant(api.pool, api.tenantId, async (client) =>
      service.create(asExecutor(client), api.tenantId, {
        recipientMembershipId: agentAMembershipId,
        kind: 'assignment', targetType: 'conversation', targetId,
        dedupeKey: `integration:${targetId}`,
      }));
    await create();
    await create();

    const own = await send(api, agentA, 'GET', '/notifications?limit=25');
    expect(own.statusCode).toBe(200);
    const records = (own.json() as { data: { id: string; targetId: string; readAt: string | null }[] }).data
      .filter((row) => row.targetId === targetId);
    expect(records).toHaveLength(1);
    expect(records[0]?.readAt).toBeNull();
    const queued = await api.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notification_push_queue WHERE notification_id=$1', [records[0]?.id],
    );
    expect(Number(queued.rows[0]?.count)).toBe(2);
    const other = await send(api, owner, 'GET', '/notifications?limit=25');
    expect((other.json() as { data: { targetId: string }[] }).data.some((row) => row.targetId === targetId)).toBe(false);
    expect((await feed(agentA, beforeAgent.cursor)).events.some((event) => event.type === 'notification.changed')).toBe(true);
    expect((await feed(owner, beforeOwner.cursor)).events.some((event) => event.type === 'notification.changed')).toBe(false);

    const id = records[0]?.id as string;
    expect((await send(api, owner, 'POST', `/notifications/${id}/read`)).statusCode).toBe(404);
    expect((await send(api, agentA, 'POST', `/notifications/${id}/read`)).statusCode).toBe(200);
    const reread = await send(api, agentA, 'GET', '/notifications?limit=25');
    expect((reread.json() as { data: { id: string; readAt: string | null }[] }).data.find((row) => row.id === id)?.readAt).not.toBeNull();

    // Account switching on the same browser subscription must retire the old
    // member's registration before the new member can receive OS pushes.
    const ownerDevice = randomUUID();
    const switched = await send(api, owner, 'POST', `/notifications/devices/${ownerDevice}`, {
      subscription: { endpoint, keys: {
        p256dh: Buffer.alloc(65, 5).toString('base64url'),
        auth: Buffer.alloc(16, 6).toString('base64url'),
      } },
    });
    expect(switched.statusCode, switched.payload).toBe(200);
    const oldDevices = (await send(api, agentA, 'GET', '/notifications/devices')).json() as
      { data: { deviceId: string; enabled: boolean }[] };
    expect(oldDevices.data.find((entry) => entry.deviceId === deviceId)?.enabled).toBe(false);
    expect(oldDevices.data.find((entry) => entry.deviceId === secondDeviceId)?.enabled).toBe(true);
    const newDevices = (await send(api, owner, 'GET', '/notifications/devices')).json() as
      { data: { deviceId: string; enabled: boolean }[] };
    expect(newDevices.data.find((entry) => entry.deviceId === ownerDevice)?.enabled).toBe(true);
  });

  it('drains generic Web Push delivery, retries temporary failures, and revokes expired subscriptions', async () => {
    // This is a scratch database, never a provider call. The mock captures the
    // exact lock-screen payload without contacting a real customer device.
    await api.pool.query("UPDATE notification_push_queue SET state='skipped' WHERE state='pending'");
    const sendPush = vi.fn();
    const membershipId = await addMember(api, 'push-worker@realtime.test', 'agent', [{ type: 'inbox', id: inboxA }]);
    const browser = await login(api, 'push-worker@realtime.test', MEMBER_PASSWORD);
    const deviceId = randomUUID();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/push-worker-opaque';
    const registered = await send(api, browser, 'POST', `/notifications/devices/${deviceId}`, {
      subscription: { endpoint, keys: {
        p256dh: Buffer.alloc(65, 11).toString('base64url'),
        auth: Buffer.alloc(16, 12).toString('base64url'),
      } },
    });
    expect(registered.statusCode, registered.payload).toBe(200);
    const worker = new PushOutboxService(api.pool, parseApiConfig(envFor(api.names, {
      CONVO_PROCESS_ROLE: 'worker-integration',
      CONVO_WEB_PUSH_PRIVATE_KEY: Buffer.alloc(32, 13).toString('base64url'),
      CONVO_WEB_PUSH_SUBJECT: 'mailto:ops@example.test',
    })), sendPush as PushSender);
    const notifications = api.app.get(NotificationService);
    const queueFor = async (targetId: string) => {
      const rows = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string; state: string; attempt_count: number }>(
        `SELECT q.id::text,q.state,q.attempt_count FROM notification_push_queue q
           JOIN notifications n ON n.tenant_id=q.tenant_id AND n.id=q.notification_id
          WHERE n.target_id=$1`, [targetId],
      ));
      return rows.rows[0]!;
    };
    const create = async () => {
      const targetId = randomUUID();
      await withTenant(api.pool, api.tenantId, (client) => notifications.create(asExecutor(client), api.tenantId, {
        recipientMembershipId: membershipId, kind: 'new_message', targetType: 'conversation', targetId,
        dedupeKey: `push-worker:${targetId}`,
      }));
      return targetId;
    };

    const acceptedTarget = await create();
    sendPush.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(acceptedTarget)).state).toBe('sent');
    const payload = JSON.parse(String(sendPush.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: 'new_message', targetType: 'conversation', targetId: acceptedTarget });
    expect(JSON.stringify(payload)).not.toContain(endpoint);
    expect(JSON.stringify(payload)).not.toContain('customer');

    const retryTarget = await create();
    sendPush.mockRejectedValueOnce({ statusCode: 503 });
    expect(await worker.drain(1)).toBe(1);
    expect(await queueFor(retryTarget)).toMatchObject({ state: 'pending', attempt_count: 1 });
    await api.pool.query('UPDATE notification_push_queue SET next_attempt_at=now() WHERE id=$1', [(await queueFor(retryTarget)).id]);
    sendPush.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    expect(await worker.drain(1)).toBe(1);
    expect(await queueFor(retryTarget)).toMatchObject({ state: 'sent', attempt_count: 2 });

    const readTarget = await create();
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      'UPDATE notifications SET read_at=now() WHERE target_id=$1', [readTarget],
    ));
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(readTarget)).state).toBe('skipped');
    expect(sendPush).toHaveBeenCalledTimes(3);

    const permanentTarget = await create();
    sendPush.mockRejectedValueOnce({ statusCode: 401 });
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(permanentTarget)).state).toBe('failed');

    const networkTarget = await create();
    sendPush.mockRejectedValueOnce(new Error('connection reset: private provider detail'));
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(networkTarget)).state).toBe('pending');

    const expiredTarget = await create();
    sendPush.mockRejectedValueOnce({ statusCode: 410 });
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(expiredTarget)).state).toBe('failed');
    const device = (await send(api, browser, 'GET', '/notifications/devices')).json() as
      { data: { deviceId: string; enabled: boolean }[] };
    expect(device.data.find((entry) => entry.deviceId === deviceId)?.enabled).toBe(false);

    const reenabled = await send(api, browser, 'POST', `/notifications/devices/${deviceId}`, {
      subscription: { endpoint, keys: {
        p256dh: Buffer.alloc(65, 11).toString('base64url'),
        auth: Buffer.alloc(16, 12).toString('base64url'),
      } },
    });
    expect(reenabled.statusCode).toBe(200);
    const invalidTarget = await create();
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      'UPDATE notification_devices SET ciphertext=$1 WHERE device_id=$2', [Buffer.from('invalid'), deviceId],
    ));
    expect(await worker.drain(1)).toBe(1);
    expect((await queueFor(invalidTarget)).state).toBe('failed');
  });
});

describe('a stream that ends badly', () => {
  it('stops the loop when the client goes away', async () => {
    // A real socket, because a client hanging up is a socket event and cannot
    // be simulated by an in-process injection.
    const pool = scratchRuntimePool(api.names, 2);
    const app = await createApiApplication(parseApiConfig(envFor(api.names)), pool, {
      channelTransport: transport,
    });
    await app.listen(0, '127.0.0.1');
    try {
      const base = await app.getUrl();
      const controller = new AbortController();
      const response = await fetch(
        `${base.replace('[::1]', '127.0.0.1')}/api/v1/tenants/${api.tenantId}/realtime/stream`,
        { headers: { cookie: owner.cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      await reader?.read();
      controller.abort();

      // The server survives the hang-up and keeps serving: a stream loop that
      // ran on after its client left would hold a database connection per
      // abandoned browser tab.
      const after = await fetch(
        `${base.replace('[::1]', '127.0.0.1')}/api/v1/tenants/${api.tenantId}/realtime/events`,
        { headers: { cookie: owner.cookie } },
      );
      expect(after.status).toBe(200);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('tells a client to reconnect when the server itself fails', async () => {
    const pool = scratchRuntimePool(api.names, 2);
    const app = await createApiApplication(parseApiConfig(envFor(api.names)), pool, {
      channelTransport: transport,
    });
    const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    try {
      const streaming = server.inject({
        method: 'GET',
        url: `/api/v1/tenants/${api.tenantId}/realtime/stream`,
        headers: { cookie: owner.cookie },
      });
      // The database goes away underneath an open stream. The first page has
      // already been sent, so this cannot become a status code.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await pool.end();
      const response = await streaming;

      const frames = response.payload
        .split('\n\n')
        .filter((block) => block.includes('event: '))
        .map((block) => ({
          event: /event: (.+)/.exec(block)?.[1] ?? '',
          data: JSON.parse(/data: (.+)/.exec(block)?.[1] ?? '{}') as Record<string, unknown>,
        }));
      const last = frames.at(-1);
      expect(last?.event).toBe('stream_closed');
      // Not `access_revoked`: calling a database outage a revocation would log
      // people out of a working session.
      expect(last?.data['reason']).toBe('server_error');
    } finally {
      // The pool is already ended; closing the app must not be the thing that
      // decides whether this test passes.
      await app.close().catch(() => undefined);
    }
  }, 20_000);
});

/** Reads the authority digest back out of a cursor this build issued. */
describe('supervisor inbox lens', () => {
  const peer = '15557000910';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'متابعة للمشرف', 'wamid.rt-supervisor-1');
    conversationId = (await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity=$1', [peer]),
    )).rows[0]!.id;
    const current = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
      version: (current.json() as { data: { version: number } }).data.version,
      assigneeMembershipId: agentAMembershipId,
    })).statusCode).toBe(200);
  });

  it('shows a scoped supervisor zero-work agents in the same readable inbox', async () => {
    const directory = await send(api, supervisor, 'GET', '/supervisor/agents');
    expect(directory.statusCode, directory.payload).toBe(200);
    const agents = (directory.json() as { data: { membershipId: string; name: string; email: string; teams: string[] }[] }).data;
    expect(agents).toEqual(expect.arrayContaining([expect.objectContaining({ membershipId: agentAMembershipId, email: 'agent-a@realtime.test' })]));
    expect(agents).toEqual(expect.arrayContaining([expect.objectContaining({ membershipId: secondAgentAMembershipId, email: 'agent-a2@realtime.test' })]));
    expect(agents.some((agent) => agent.membershipId === agentBMembershipId)).toBe(false);
  });

  it('keeps the supervisor principal and applies the chosen-agent filter server-side', async () => {
    const response = await send(api, supervisor, 'GET', `/supervisor/conversations?agent=${agentAMembershipId}&queue=mine`);
    expect(response.statusCode, response.payload).toBe(200);
    const rows = (response.json() as { data: { id: string; assigneeMembershipId: string }[] }).data;
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversationId, assigneeMembershipId: agentAMembershipId })]));
    const denied = await send(api, agentA, 'GET', '/supervisor/agents');
    expect(denied.statusCode).toBe(403);
  });

  it('reports current selected-agent workload through the supervisor scope only', async () => {
    const workload = await send(api, supervisor, 'GET', `/supervisor/workload?agent=${agentAMembershipId}`);
    expect(workload.statusCode, workload.payload).toBe(200);
    const data = (workload.json() as { data: { agent: { membershipId: string }; current: { assigned: number; open: number }; byStatus: { status: string; count: number }[] } }).data;
    expect(data.agent.membershipId).toBe(agentAMembershipId);
    expect(data.current.assigned).toBeGreaterThanOrEqual(1);
    expect(data.current.open).toBeGreaterThanOrEqual(1);
    expect(data.byStatus).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'open' })]));
    const outsideScope = await send(api, supervisor, 'GET', `/supervisor/workload?agent=${agentBMembershipId}`);
    expect(outsideScope.statusCode).toBe(404);
  });

  it('aggregates operational timing from durable episodes and actor evidence', async () => {
    expect((await send(api, agentA, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text', text: 'سأتابع الطلب', trafficClass: 'interactive', clientMessageId: 'supervisor-report-reply',
    })).statusCode).toBe(202);
    const current = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
      version: (current.json() as { data: { version: number } }).data.version, command: 'resolve', resolution: 'تمت المتابعة',
    })).statusCode).toBe(200);
    const report = await send(api, owner, 'GET', '/reports/operations');
    expect(report.statusCode, report.payload).toBe(200);
    const data = (report.json() as { data: { timing: { firstResponseMeasured: number; resolutionMeasured: number }; agents: { membershipId: string; name: string; firstResponses: number; resolutions: number }[] } }).data;
    expect(data.timing.firstResponseMeasured).toBeGreaterThan(0);
    expect(data.timing.resolutionMeasured).toBeGreaterThan(0);
    expect(data.agents.some((agent) => agent.firstResponses > 0)).toBe(true);
    // The report directory is identity-first: a visible active agent with no
    // qualifying event remains a real zero row, never an absent name bucket.
    expect(data.agents).toEqual(expect.arrayContaining([expect.objectContaining({ membershipId: secondAgentAMembershipId, firstResponses: 0, resolutions: 0 })]));
  });

  it('keeps report endpoint aggregates inside Owner, scoped Agent, and report permission boundaries', async () => {
    const surfaces = ['/reports/operations', '/reports/responses', '/reports/resolutions', '/reports/assignments', '/reports/teams'];
    for (const path of surfaces) {
      const ownerResponse = await send(api, owner, 'GET', path);
      expect(ownerResponse.statusCode, `${path}: ${ownerResponse.payload}`).toBe(200);
      const ownResponse = await send(api, agentA, 'GET', path);
      expect(ownResponse.statusCode, `${path}: ${ownResponse.payload}`).toBe(200);
    }
    const ownOperations = (await send(api, agentA, 'GET', '/reports/operations')).json() as {
      data: { agents: { membershipId: string }[]; agentOptions: { membershipId: string }[] };
    };
    expect(ownOperations.data.agents.map((row) => row.membershipId)).toEqual([agentAMembershipId]);
    expect(ownOperations.data.agentOptions.map((row) => row.membershipId)).toEqual([agentAMembershipId]);

    const zeroAgentMembership = await addMember(api, 'zero-activity-report-agent@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      `UPDATE memberships duplicate SET display_name=source.display_name
         FROM memberships source WHERE duplicate.id=$1 AND source.id=$2`, [zeroAgentMembership, agentAMembershipId],
    ));
    const duplicateRowsResponse = await send(api, owner, 'GET', '/reports/operations');
    const identityReport = (duplicateRowsResponse.json() as { data: { agents: { membershipId: string; name: string; currentAssigned: number; humanMessages: number; firstResponses: number; resolutions: number }[] } }).data.agents;
    expect(duplicateRowsResponse.statusCode).toBe(200);
    const sameNameRows = identityReport.filter((agent) => agent.membershipId === agentAMembershipId || agent.membershipId === zeroAgentMembership);
    expect(sameNameRows).toHaveLength(2);
    expect(new Set(sameNameRows.map((agent) => agent.membershipId)).size).toBe(2);
    expect(sameNameRows.find((agent) => agent.membershipId === zeroAgentMembership)).toMatchObject({ currentAssigned: 0, humanMessages: 0, firstResponses: 0, resolutions: 0 });
    expect(new Set(sameNameRows.map((agent) => agent.name)).size).toBe(1);
    await withTenant(api.pool, api.tenantId, (client) => client.query(`UPDATE memberships SET status='revoked' WHERE id=$1`, [zeroAgentMembership]));

    const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
    const user = await api.pool.query<{ id: string }>(
      `INSERT INTO users (email,password_hash,status) VALUES ('no-report-reader@realtime.test',$1,'active') RETURNING id::text`, [hash],
    );
    const noReportMembershipId = await withTenant(api.pool, api.tenantId, async (client) => {
      const role = await client.query<{ id: string }>(
        `INSERT INTO roles (tenant_id,key,name,is_builtin) VALUES ($1,'no_report_reader','No report reader',false) RETURNING id::text`, [api.tenantId],
      );
      const membership = await client.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id,user_id,role_id,status) VALUES ($1,$2,$3,'active') RETURNING id::text`,
        [api.tenantId,user.rows[0]?.id,role.rows[0]?.id],
      );
      return membership.rows[0]!.id;
    });
    void noReportMembershipId;
    const noReportReader = await login(api, 'no-report-reader@realtime.test', MEMBER_PASSWORD);
    for (const path of surfaces) expect((await send(api, noReportReader, 'GET', path)).statusCode, path).toBe(403);

    const admin = superuserPool(api.names.database);
    let foreignTeamId = '';
    try {
      const foreignTenant = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name,slug,status) VALUES ('Foreign reporting tenant','foreign-reporting-tenant','active') RETURNING id::text`,
      );
      const foreignTeam = await admin.query<{ id: string }>(
        `INSERT INTO teams (tenant_id,name) VALUES ($1,'Private team') RETURNING id::text`, [foreignTenant.rows[0]?.id],
      );
      foreignTeamId = foreignTeam.rows[0]!.id;
    } finally {
      await admin.end();
    }
    expect((await send(api, owner, 'GET', `/reports/teams?teamId=${foreignTeamId}`)).statusCode).toBe(404);

    // Team identity can be valid in the tenant yet absent from the reportable
    // directory once it is archived. Keep this indistinguishable from missing
    // or out-of-scope teams at the team-report boundary.
    const archivedTeam = await withTenant(api.pool, api.tenantId, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO teams (tenant_id,name,archived_at) VALUES ($1,'Archived reporting team',now()) RETURNING id::text`,
        [api.tenantId],
      );
      return created.rows[0]!.id;
    });
    expect((await send(api, owner, 'GET', `/reports/teams?teamId=${archivedTeam}`)).statusCode).toBe(404);
    expect((await send(api, owner, 'GET', '/reports/teams')).statusCode).toBe(200);
  });

  it('reports response and resolution episodes using event timestamps and proven actors', async () => {
    const peer = '15557000945';
    await customerWrites(INBOX_A, peer, 'قياس زمن الاستجابة والحل', 'wamid.rt-lifecycle-report');
    const conversation = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2', [inboxA, peer],
    ))).rows[0]!;
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query(`UPDATE conversation_episodes
        SET opened_at='2026-09-01T09:00:00Z',first_inbound_at='2026-09-01T09:01:00Z',
            first_response_at='2026-09-01T09:08:00Z',first_response_by_membership_id=$3,
            closed_at='2026-09-02T09:00:00Z',closed_by_membership_id=NULL
        WHERE conversation_id=$1 AND tenant_id=$2 AND seq=1`, [conversation.id, api.tenantId, agentAMembershipId]);
      await client.query(`INSERT INTO conversation_episodes
        (tenant_id,conversation_id,seq,opened_at,opened_by,first_inbound_at,first_response_at,closed_at,closed_by_membership_id)
        VALUES ($1,$2,2,'2026-09-02T10:00:00Z','agent_reopen','2026-09-02T10:01:00Z','2026-09-02T10:05:00Z','2026-09-03T10:00:00Z',NULL)`,
      [api.tenantId, conversation.id]);
    });

    const responses = await send(api, owner, 'GET', '/reports/responses?from=2026-09-01&to=2026-09-01');
    expect(responses.statusCode, responses.payload).toBe(200);
    const responseData = (responses.json() as { data: { measured: number; averageSeconds: number; medianSeconds: number; buckets: { bucket: string; count: number }[]; byAgent: { membershipId: string }[] } }).data;
    expect(responseData).toMatchObject({ measured: 1, averageSeconds: 420, medianSeconds: 420 });
    expect(responseData.buckets).toEqual([{ bucket: '5–15m', count: 1 }]);
    expect(responseData.byAgent).toEqual([expect.objectContaining({ membershipId: agentAMembershipId, measured: 1 })]);
    const outOfScopeAgentResponse = await send(api, supervisor, 'GET', `/reports/responses?agentId=${agentBMembershipId}`);
    expect(outOfScopeAgentResponse.statusCode).toBe(404);
    const unknownActorResponse = await send(api, owner, 'GET', '/reports/responses?from=2026-09-02&to=2026-09-02');
    expect(unknownActorResponse.statusCode, unknownActorResponse.payload).toBe(200);
    expect((unknownActorResponse.json() as { data: { measured: number; byAgent: { membershipId: string | null; name: string }[] } }).data).toMatchObject({
      measured: 1, byAgent: [expect.objectContaining({ membershipId: null, name: 'Unattributed' })],
    });
    const filteredResponses = await send(api, owner, 'GET', `/reports/responses?from=2026-09-01&to=2026-09-01&agentId=${agentBMembershipId}`);
    expect((filteredResponses.json() as { data: { measured: number; byAgent: unknown[] } }).data).toEqual({
      measured: 0, averageSeconds: null, medianSeconds: null, buckets: [], byAgent: [], byChannel: [],
    });

    const resolutions = await send(api, owner, 'GET', '/reports/resolutions?from=2026-09-02&to=2026-09-03');
    expect(resolutions.statusCode, resolutions.payload).toBe(200);
    const resolutionData = (resolutions.json() as { data: { resolvedEpisodes: number; reopenedEpisodes: number; byAgent: { membershipId: string | null; name: string; measured: number }[] } }).data;
    expect(resolutionData.resolvedEpisodes).toBe(2);
    expect(resolutionData.reopenedEpisodes).toBe(1);
    expect(resolutionData.byAgent).toEqual([expect.objectContaining({ membershipId: null, name: 'Unattributed', measured: 2 })]);
    const outOfScopeAgentResolution = await send(api, supervisor, 'GET', `/reports/resolutions?agentId=${agentBMembershipId}`);
    expect(outOfScopeAgentResolution.statusCode).toBe(404);
  });

  it('pages assignment events by immutable ownership changes with filter-bound cursors', async () => {
    const peer = '15557000939';
    await customerWrites(INBOX_A, peer, 'تعيين للاختبار', 'wamid.rt-assignment-report');
    const id = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE peer_identity=$1', [peer],
    ))).rows[0]!.id;
    await withTenant(api.pool, api.tenantId, (client) => client.query(`
      INSERT INTO conversation_audit (tenant_id,conversation_id,actor_membership_id,act,from_value,to_value,at_version,at)
      VALUES ($1,$2,NULL,'claim',NULL,$3,2,'2026-09-01T10:00:00Z'),
             ($1,$2,NULL,'assign',$3,$4,3,'2026-09-01T11:00:00Z'),
             ($1,$2,NULL,'handoff',$3,$4,4,'2026-09-01T12:00:00Z'),
             ($1,$2,NULL,'handoff_requested',$4,$3,5,'2026-09-01T13:00:00Z'),
             ($1,$2,NULL,'handoff_declined',$4,$3,6,'2026-09-01T14:00:00Z')`,
    [api.tenantId, id, agentAMembershipId, agentBMembershipId]));

    const first = await send(api, owner, 'GET', `/reports/assignments?agentId=${agentBMembershipId}&limit=1`);
    expect(first.statusCode, first.payload).toBe(200);
    const firstPage = first.json() as { data: { id: string; conversationId: string; action: string; assignedTo: { membershipId: string } }[]; page: { next_cursor: string | null; has_more: boolean } };
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.data[0]).toMatchObject({ conversationId: id, action: 'handoff', assignedTo: { membershipId: agentBMembershipId } });
    expect(firstPage.page.has_more).toBe(true);
    expect(firstPage.page.next_cursor).toBeTruthy();

    const second = await send(api, owner, 'GET', `/reports/assignments?agentId=${agentBMembershipId}&limit=1&cursor=${encodeURIComponent(firstPage.page.next_cursor!)}`);
    expect(second.statusCode, second.payload).toBe(200);
    const secondPage = second.json() as { data: { id: string; action: string; assignedTo: { membershipId: string } }[]; page: { next_cursor: string | null; has_more: boolean } };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]).toMatchObject({ conversationId: id, action: 'assign', assignedTo: { membershipId: agentBMembershipId } });
    expect(secondPage.page.has_more).toBe(false);
    // The filter selects the target, so the preceding claim to Agent A is
    // excluded; ownership offer/decline rows are not assignment events.
    expect((await send(api, owner, 'GET', `/reports/assignments?agentId=${agentBMembershipId}&limit=1&cursor=bad`)).statusCode).toBe(400);
    expect((await send(api, owner, 'GET', `/reports/assignments?agentId=${agentAMembershipId}&limit=1&cursor=${encodeURIComponent(firstPage.page.next_cursor!)}`)).statusCode).toBe(400);
    expect((await send(api, owner, 'GET', '/reports/assignments?limit=101')).statusCode).toBe(400);
  });

  it('applies Inbox-readable scope before assignment keyset limits', async () => {
    const peerA = '15557000940';
    const peerB = '15557000941';
    await customerWrites(INBOX_A, peerA, 'داخل نطاق الصندوق', 'wamid.rt-assignment-scope-a');
    await customerWrites(INBOX_B, peerB, 'خارج نطاق الصندوق', 'wamid.rt-assignment-scope-b');
    const ids = await withTenant(api.pool, api.tenantId, async (client) => {
      const rows = await client.query<{ peer_identity: string; id: string }>(
        'SELECT peer_identity,id::text FROM conversations WHERE peer_identity=ANY($1::text[])', [[peerA, peerB]],
      );
      return new Map(rows.rows.map((row) => [row.peer_identity, row.id]));
    });
    const readableConversationId = ids.get(peerA)!;
    const unreadableConversationId = ids.get(peerB)!;
    await withTenant(api.pool, api.tenantId, (client) => client.query(`
      INSERT INTO conversation_audit (tenant_id,conversation_id,actor_membership_id,act,from_value,to_value,at_version,at)
      VALUES ($1,$2,NULL,'claim',NULL,$4,20,'2026-08-25T10:00:00Z'),
             ($1,$2,NULL,'assign',$4,$5,21,'2026-08-25T09:00:00Z'),
             ($1,$3,NULL,'claim',NULL,$5,20,'2026-08-25T15:00:00Z'),
             ($1,$3,NULL,'assign',$5,$4,21,'2026-08-25T14:00:00Z')`,
    [api.tenantId, readableConversationId, unreadableConversationId, agentAMembershipId, agentBMembershipId]));
    await addMember(api, 'assignment-inbox-reader@realtime.test', 'supervisor', [{ type: 'inbox', id: inboxA }]);
    const inboxReader = await login(api, 'assignment-inbox-reader@realtime.test', MEMBER_PASSWORD);
    const first = await send(api, inboxReader, 'GET', '/reports/assignments?from=2026-08-25&to=2026-08-25&limit=1');
    expect(first.statusCode, first.payload).toBe(200);
    const firstPage = first.json() as { data: { conversationId: string }[]; page: { next_cursor: string | null } };
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.data[0]?.conversationId).toBe(readableConversationId);
    expect(firstPage.page.next_cursor).toBeTruthy();
    const second = await send(api, inboxReader, 'GET', `/reports/assignments?from=2026-08-25&to=2026-08-25&limit=1&cursor=${encodeURIComponent(firstPage.page.next_cursor!)}`);
    expect(second.statusCode, second.payload).toBe(200);
    const secondPage = second.json() as { data: { conversationId: string }[]; page: { has_more: boolean } };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?.conversationId).toBe(readableConversationId);
    expect(secondPage.page.has_more).toBe(false);
  });

  it('keeps resolved and archived records out of the selected agent’s current workload', async () => {
    // A fresh, in-scope agent makes the projection deterministic even though
    // the wider realtime suite has already exercised agent A's live queue.
    const isolatedAgentId = await addMember(api, 'workload-isolated@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    const workloadPeers = [
      ['15557000921', 'open'], ['15557000922', 'open'], ['15557000923', 'pending'], ['15557000924', 'snoozed'],
      ['15557000925', 'resolved'], ['15557000926', 'resolved'], ['15557000927', 'resolved'], ['15557000928', 'archived'],
    ] as const;
    for (const [peer, status] of workloadPeers) {
      await customerWrites(INBOX_A, peer, `حمل ${status}`, `wamid.rt-supervisor-workload-${peer}`);
      const id = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
        'SELECT id::text FROM conversations WHERE peer_identity=$1', [peer],
      ))).rows[0]!.id;
      const current = await send(api, owner, 'GET', `/conversations/${id}`);
      expect((await send(api, owner, 'POST', `/conversations/${id}/assignments`, {
        version: (current.json() as { data: { version: number } }).data.version,
        assigneeMembershipId: isolatedAgentId,
      })).statusCode).toBe(200);
      if (status !== 'open') {
        const afterAssignment = await send(api, owner, 'GET', `/conversations/${id}`);
        const version = (afterAssignment.json() as { data: { version: number } }).data.version;
        const command = status === 'pending'
          ? { command: 'wait', reason: 'اختبار الحمل' }
          : status === 'snoozed'
            ? { command: 'snooze', wakeAt: '2027-01-01T12:00:00.000Z', timezone: 'UTC' }
            : { command: 'resolve', resolution: 'اختبار الحمل' };
        expect((await send(api, owner, 'POST', `/conversations/${id}/transitions`, { version, ...command })).statusCode).toBe(200);
        if (status === 'archived') {
          const resolved = await send(api, owner, 'GET', `/conversations/${id}`);
          expect((await send(api, owner, 'POST', `/conversations/${id}/transitions`, {
            version: (resolved.json() as { data: { version: number } }).data.version, command: 'archive',
          })).statusCode).toBe(200);
        }
      }
    }
    const workload = await send(api, supervisor, 'GET', `/supervisor/workload?agent=${isolatedAgentId}`);
    expect(workload.statusCode, workload.payload).toBe(200);
    const current = (workload.json() as { data: { current: { assigned: number; open: number; pending: number; snoozed: number } } }).data.current;
    expect(current).toEqual(expect.objectContaining({ assigned: 4, open: 2, pending: 1, snoozed: 1 }));
  });

  it('binds delayed inbound and human replies to one conversation across an archive boundary', async () => {
    const peer = '15557000929';
    const workloadBefore = await send(api, supervisor, 'GET', `/supervisor/workload?agent=${agentAMembershipId}`);
    expect(workloadBefore.statusCode, workloadBefore.payload).toBe(200);
    const unrepliedBefore = (workloadBefore.json() as { data: { current: { unreplied: number } } }).data.current.unreplied;
    const before = await send(api, owner, 'GET', '/reports/operations');
    expect(before.statusCode, before.payload).toBe(200);
    const beforeAgent = (before.json() as { data: { agents: { membershipId: string; humanMessages: number; handledConversations: number }[] } }).data.agents
      .find((row) => row.membershipId === agentAMembershipId)!;
    const filteredBefore = await send(api, owner, 'GET', `/reports/operations?agentId=${agentAMembershipId}&connectionId=${inboxA}&channel=whatsapp&status=open`);
    expect(filteredBefore.statusCode, filteredBefore.payload).toBe(200);

    await customerWrites(INBOX_A, peer, 'المحادثة الأولى', 'wamid.rt-bound-a-in');
    const conversationA = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2 AND status <> \'archived\'', [inboxA, peer],
    ))).rows[0]!.id;
    let current = await send(api, owner, 'GET', `/conversations/${conversationA}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationA}/assignments`, {
      version: (current.json() as { data: { version: number } }).data.version, assigneeMembershipId: agentAMembershipId,
    })).statusCode).toBe(200);
    expect((await send(api, agentA, 'POST', `/conversations/${conversationA}/messages`, {
      messageType: 'text', text: 'رد المحادثة الأولى', trafficClass: 'interactive', clientMessageId: 'supervisor-bound-a-out',
    })).statusCode).toBe(202);
    const outboundA = await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string; created_at: Date }>(
      'SELECT id::text,created_at FROM outbound_messages WHERE client_message_id=$1', ['supervisor-bound-a-out'],
    ));
    current = await send(api, owner, 'GET', `/conversations/${conversationA}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationA}/transitions`, {
      version: (current.json() as { data: { version: number } }).data.version,
      command: 'resolve', resolution: 'انتهى الاختبار الأول',
    })).statusCode).toBe(200);
    current = await send(api, owner, 'GET', `/conversations/${conversationA}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationA}/transitions`, {
      version: (current.json() as { data: { version: number } }).data.version, command: 'archive',
    })).statusCode).toBe(200);

    await customerWrites(INBOX_A, peer, 'رسالة متأخرة زمنيًا للمحادثة الجديدة', 'wamid.rt-bound-b-in');
    const conversationB = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE connection_id=$1 AND peer_identity=$2 AND status <> \'archived\'', [inboxA, peer],
    ))).rows[0]!.id;
    expect(conversationB).not.toBe(conversationA);
    const inboundB = await withTenant(api.pool, api.tenantId, (client) => client.query<{ occurred_at: Date; conversation_id: string | null }>(
      'SELECT occurred_at,conversation_id::text FROM inbound_events WHERE provider_message_id=$1', ['wamid.rt-bound-b-in'],
    ));
    expect(inboundB.rows[0]!.occurred_at.getTime()).toBeLessThan(outboundA.rows[0]!.created_at.getTime());
    expect(inboundB.rows[0]!.conversation_id).toBe(conversationB);
    current = await send(api, owner, 'GET', `/conversations/${conversationB}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationB}/assignments`, {
      version: (current.json() as { data: { version: number } }).data.version, assigneeMembershipId: agentAMembershipId,
    })).statusCode).toBe(200);

    // Revert only the test rows to the legacy NULL state to exercise the
    // deterministic temporal fallback used for data created before migration
    // 0036. Production history is deliberately not backfilled by identity.
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query('UPDATE inbound_events SET conversation_id=NULL WHERE provider_message_id=$1', ['wamid.rt-bound-b-in']);
    });

    // The fixture's provider clock intentionally trails processing time by an
    // hour. B is normalized after A's reply/archive, while its provider event
    // timestamp precedes that reply. The durable binding must win over global
    // peer chronology without rewriting the immutable inbound journal.
    const filter = encodeURIComponent(JSON.stringify({ key: 'unreplied', operator: 'eq', value: true }));
    const unrepliedInbox = await send(api, owner, 'GET', `/conversations?queue=all&filter=${filter}`);
    expect(unrepliedInbox.statusCode, unrepliedInbox.payload).toBe(200);
    const unrepliedIds = (unrepliedInbox.json() as { data: { id: string }[] }).data.map((row) => row.id);
    expect(unrepliedIds).toContain(conversationB);

    const workload = await send(api, supervisor, 'GET', `/supervisor/workload?agent=${agentAMembershipId}`);
    expect(workload.statusCode, workload.payload).toBe(200);
    expect((workload.json() as { data: { current: { unreplied: number } } }).data.current.unreplied).toBe(unrepliedBefore + 1);

    expect((await send(api, agentA, 'POST', `/conversations/${conversationB}/messages`, {
      messageType: 'text', text: 'رد المحادثة الثانية', trafficClass: 'interactive', clientMessageId: 'supervisor-bound-b-out',
    })).statusCode).toBe(202);
    const boundMessages = await withTenant(api.pool, api.tenantId, (client) => client.query<{ conversation_id: string | null }>(
      `SELECT conversation_id::text FROM outbound_messages WHERE client_message_id = ANY($1::text[]) ORDER BY client_message_id`,
      [['supervisor-bound-a-out', 'supervisor-bound-b-out']],
    ));
    expect(boundMessages.rows.map((row) => row.conversation_id)).toEqual(expect.arrayContaining([conversationA, conversationB]));
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query('UPDATE outbound_messages SET conversation_id=NULL WHERE client_message_id = ANY($1::text[])', [
        ['supervisor-bound-a-out', 'supervisor-bound-b-out'],
      ]);
    });
    const after = await send(api, owner, 'GET', '/reports/operations');
    expect(after.statusCode, after.payload).toBe(200);
    const afterAgent = (after.json() as { data: { agents: { membershipId: string; humanMessages: number; handledConversations: number }[] } }).data.agents
      .find((row) => row.membershipId === agentAMembershipId)!;
    expect(afterAgent.humanMessages - beforeAgent.humanMessages).toBe(2);
    expect(afterAgent.handledConversations - beforeAgent.handledConversations).toBe(2);
    const filteredAfter = await send(api, owner, 'GET', `/reports/operations?agentId=${agentAMembershipId}&connectionId=${inboxA}&channel=whatsapp&status=open`);
    expect(filteredAfter.statusCode, filteredAfter.payload).toBe(200);
    const filteredData = (filteredAfter.json() as { data: { agents: { membershipId: string; humanMessages: number; handledConversations: number }[] } }).data;
    expect(filteredData.agents).toHaveLength(1);
    expect(filteredData.agents[0]).toMatchObject({
      membershipId: agentAMembershipId,
      humanMessages: ((filteredBefore.json() as { data: { agents: { humanMessages: number }[] } }).data.agents[0]?.humanMessages ?? 0) + 1,
    });
    expect((await send(api, owner, 'GET', '/reports/operations?priority=critical')).statusCode).toBe(400);
    expect((await send(api, owner, 'GET', '/reports/operations?agentId=not-a-uuid')).statusCode).toBe(400);
    expect((await send(api, owner, 'GET', '/reports/operations?unknown=value')).statusCode).toBe(400);

    const teams = await withTenant(api.pool, api.tenantId, async (client) => {
      const rows = await client.query<{ id: string }>(
        `INSERT INTO teams (tenant_id,name) VALUES ($1,'Boundary Team A'),($1,'Boundary Team B') RETURNING id::text`, [api.tenantId],
      );
      return rows.rows.map((row) => row.id);
    });
    const [teamA, teamB] = teams;
    expect(teamA).toBeDefined(); expect(teamB).toBeDefined();
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query('INSERT INTO team_members (tenant_id,team_id,membership_id) VALUES ($1,$2,$3),($1,$4,$5)', [api.tenantId, teamA, agentAMembershipId, teamB, agentBMembershipId]);
      await client.query('UPDATE conversations SET team_id=$2 WHERE id=$1', [conversationA, teamA]);
      await client.query('UPDATE conversations SET team_id=$2 WHERE id=$1', [conversationB, teamB]);
    });
    const teamManagerAId = await addMember(api, 'boundary-team-a@realtime.test', 'supervisor', [{ type: 'team', id: teamA! }]);
    const teamManagerBId = await addMember(api, 'boundary-team-b@realtime.test', 'supervisor', [{ type: 'team', id: teamB! }]);
    void teamManagerAId; void teamManagerBId;
    const teamManagerA = await login(api, 'boundary-team-a@realtime.test', MEMBER_PASSWORD);
    const teamManagerB = await login(api, 'boundary-team-b@realtime.test', MEMBER_PASSWORD);
    const readableA = await send(api, teamManagerA, 'GET', '/reports/operations');
    const readableB = await send(api, teamManagerB, 'GET', '/reports/operations');
    const teamReportA = await send(api, teamManagerA, 'GET', '/reports/teams');
    const teamReportB = await send(api, teamManagerB, 'GET', '/reports/teams');
    expect(readableA.statusCode, readableA.payload).toBe(200);
    expect(readableB.statusCode, readableB.payload).toBe(200);
    expect(teamReportA.statusCode, teamReportA.payload).toBe(200);
    expect(teamReportB.statusCode, teamReportB.payload).toBe(200);
    expect((readableA.json() as { data: { conversations: { humanMessages: number } } }).data.conversations.humanMessages).toBe(1);
    expect((readableB.json() as { data: { conversations: { humanMessages: number } } }).data.conversations.humanMessages).toBe(1);
    expect((readableA.json() as { data: { agentOptions: { membershipId: string }[] } }).data.agentOptions.map((row) => row.membershipId)).toContain(agentAMembershipId);
    expect((readableA.json() as { data: { agentOptions: { membershipId: string }[] } }).data.agentOptions.map((row) => row.membershipId)).not.toContain(agentBMembershipId);
    const scopedTeamIdsA = (teamReportA.json() as { data: { teamId: string }[] }).data.map((row) => row.teamId);
    const scopedTeamIdsB = (teamReportB.json() as { data: { teamId: string }[] }).data.map((row) => row.teamId);
    expect(scopedTeamIdsA).toEqual([teamA]);
    expect(scopedTeamIdsB).toEqual([teamB]);
    expect((await send(api, teamManagerA, 'GET', `/reports/teams?teamId=${teamB}`)).statusCode).toBe(404);
    for (const surface of ['/reports/responses', '/reports/resolutions', '/reports/assignments']) {
      expect((await send(api, teamManagerA, 'GET', surface)).statusCode, surface).toBe(200);
      expect((await send(api, teamManagerB, 'GET', surface)).statusCode, surface).toBe(200);
    }
    for (const surface of ['/reports/operations', '/reports/responses', '/reports/resolutions', '/reports/assignments']) {
      expect((await send(api, teamManagerA, 'GET', `${surface}?agentId=${agentBMembershipId}`)).statusCode, surface).toBe(404);
    }
  });

  it('scopes operational aggregates through the supervisor readable inbox scope', async () => {
    const peerB = '15557000911';
    await customerWrites(INBOX_B, peerB, 'هذا العمل خارج نطاق المشرف', 'wamid.rt-supervisor-scope-b');
    const conversationB = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE peer_identity=$1', [peerB],
    ))).rows[0]!.id;
    const currentB = await send(api, owner, 'GET', `/conversations/${conversationB}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationB}/assignments`, {
      version: (currentB.json() as { data: { version: number } }).data.version, assigneeMembershipId: agentBMembershipId,
    })).statusCode).toBe(200);
    expect((await send(api, agentB, 'POST', `/conversations/${conversationB}/messages`, {
      messageType: 'text', text: 'متابعة المحاسبة', trafficClass: 'interactive', clientMessageId: 'supervisor-scope-b-reply',
    })).statusCode).toBe(202);

    const scoped = await send(api, supervisor, 'GET', '/reports/operations');
    const ownerReport = await send(api, owner, 'GET', '/reports/operations');
    expect(scoped.statusCode, scoped.payload).toBe(200);
    expect(ownerReport.statusCode, ownerReport.payload).toBe(200);
    const scopedAgents = (scoped.json() as { data: { agents: { membershipId: string }[] } }).data.agents;
    const ownerAgents = (ownerReport.json() as { data: { agents: { membershipId: string }[] } }).data.agents;
    expect(scopedAgents.some((agent) => agent.membershipId === agentBMembershipId)).toBe(false);
    expect(ownerAgents.some((agent) => agent.membershipId === agentBMembershipId)).toBe(true);
    expect((await send(api, supervisor, 'GET', `/reports/operations?agentId=${agentBMembershipId}`)).statusCode).toBe(404);
    expect((await send(api, supervisor, 'GET', `/reports/operations?connectionId=${inboxB}`)).statusCode).toBe(404);
  });

  it('keeps an archived conversation in its historical creation volume but out of backlog', async () => {
    const peer = '15557000912';
    const before = await send(api, owner, 'GET', '/reports/operations');
    expect(before.statusCode, before.payload).toBe(200);
    const baselineOpen = (before.json() as { data: { conversations: { open: number } } }).data.conversations.open;
    await customerWrites(INBOX_A, peer, 'أرشفة بعد الإنشاء', 'wamid.rt-supervisor-archived');
    const conversationId = (await withTenant(api.pool, api.tenantId, (client) => client.query<{ id: string }>(
      'SELECT id::text FROM conversations WHERE peer_identity=$1', [peer],
    ))).rows[0]!.id;
    const current = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
      version: (current.json() as { data: { version: number } }).data.version, command: 'resolve', resolution: 'انتهى الاختبار',
    })).statusCode).toBe(200);
    const resolved = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect((await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
      version: (resolved.json() as { data: { version: number } }).data.version, command: 'archive',
    })).statusCode).toBe(200);
    await withTenant(api.pool, api.tenantId, (client) => client.query(
      "UPDATE conversations SET created_at='2026-09-01T12:00:00.000Z' WHERE id=$1", [conversationId],
    ));
    const report = await send(api, owner, 'GET', '/reports/operations?from=2026-09-01&to=2026-09-01');
    expect(report.statusCode, report.payload).toBe(200);
    const data = (report.json() as { data: { conversations: { new: number; open: number } } }).data;
    expect(data.conversations.new).toBe(1);
    expect(data.conversations.open).toBe(baselineOpen);
  });
});

describe('the conversation lifecycle', () => {
  const peer = '15557000500';
  let conversationId: string;
  let lifecycle: LifecycleService;

  async function current(): Promise<{ id: string; status: string; version: number }> {
    const response = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: { id: string; status: string; version: number } }).data;
  }

  async function move(
    browser: Browser,
    command: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    const { version } = await current();
    return send(api, browser, 'POST', `/conversations/${conversationId}/transitions`, {
      version,
      ...command,
    });
  }

  beforeAll(async () => {
    lifecycle = api.app.get(LifecycleService);
    await customerWrites(INBOX_A, peer, 'أحتاج مساعدة', 'wamid.rt-500');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  it('opens a first episode with the conversation, and dates it from the first message', async () => {
    const response = await send(api, owner, 'GET', `/conversations/${conversationId}/episodes`);
    expect(response.statusCode).toBe(200);
    const episodes = (response.json() as { data: { seq: number; openedBy: string; firstInboundAt: string | null }[] }).data;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ seq: 1, openedBy: 'customer_inbound' });
    // A thread with no episode is a thread the first report cannot measure.
    expect(episodes[0]?.firstInboundAt).not.toBeNull();
  });

  it('waits on a customer with a reason, and the customer answering clears it', async () => {
    expect((await move(owner, { command: 'wait', reason: 'في انتظار رقم الطلب' })).statusCode).toBe(200);
    const waiting = await current();
    expect(waiting.status).toBe('pending');
    expect((waiting as unknown as { pendingReason: string }).pendingReason).toBe('في انتظار رقم الطلب');

    await customerWrites(INBOX_A, peer, '12345', 'wamid.rt-501');
    const answered = await current();
    expect(answered.status).toBe('open');
    expect((answered as unknown as { pendingReason: string | null }).pendingReason).toBeNull();
  });

  it('refuses to wait on a conversation that is not open', async () => {
    expect((await move(owner, { command: 'wait', reason: 'مرة أخرى' })).statusCode).toBe(200);
    const again = await move(owner, { command: 'wait', reason: 'ومرة ثالثة' });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('not_waiting_on_a_customer');
    // Put it back, so the rest of the suite starts from `open`.
    await customerWrites(INBOX_A, peer, 'رجعت', 'wamid.rt-502');
  });

  it('snoozes with a durable versioned job, and re-snoozing replaces it', async () => {
    const first = new Date(Date.now() + 60 * 60 * 1000);
    expect(
      (await move(owner, { command: 'snooze', wakeAt: first.toISOString(), timezone: 'Asia/Riyadh' }))
        .statusCode,
    ).toBe(200);

    const snoozed = await current();
    expect(snoozed.status).toBe('snoozed');
    // The zone is stored beside the instant: the instant cannot say what the
    // operator meant by "tomorrow morning".
    expect((snoozed as unknown as { snoozeTimezone: string }).snoozeTimezone).toBe('Asia/Riyadh');

    const jobsAfterFirst = await wakeJobs();
    expect(jobsAfterFirst).toHaveLength(1);

    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
    expect(
      (await move(owner, { command: 'snooze', wakeAt: later.toISOString(), timezone: 'Asia/Riyadh' }))
        .statusCode,
    ).toBe(200);

    const jobsAfterSecond = await wakeJobs();
    // One job, not two: the earlier one stops existing rather than racing the
    // new one and waking the conversation at the time the operator moved away
    // from.
    expect(jobsAfterSecond).toHaveLength(1);
    expect(jobsAfterSecond[0]?.wake_version).toBeGreaterThan(
      jobsAfterFirst[0]?.wake_version as number,
    );
    expect(jobsAfterSecond[0]?.wake_at.toISOString()).toBe(later.toISOString());
  });

  it('refuses a snooze into the past, too far ahead, or into a zone it does not know', async () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ wakeAt: new Date(Date.now() - 1000).toISOString(), timezone: 'UTC' }, 'wake_time_in_the_past'],
      [
        { wakeAt: new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString(), timezone: 'UTC' },
        'wake_time_too_far_ahead',
      ],
      [
        { wakeAt: new Date(Date.now() + 3600 * 1000).toISOString(), timezone: 'Mars/Olympus' },
        'unknown_timezone',
      ],
    ];
    for (const [payload, code] of cases) {
      const response = await move(owner, { command: 'snooze', ...payload });
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('wakes a due conversation from the sweeper, without anybody acting', async () => {
    // Bring the job forward rather than waiting an hour. The row is the job, so
    // moving it is exactly what the passage of time does.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query('UPDATE conversation_wakes SET wake_at = now() - interval \'1 minute\' WHERE conversation_id = $1', [
        conversationId,
      ]),
    );
    const before = (await current()).version;
    const woken = await lifecycle.sweepDueWakes(new Date(), 10);
    expect(woken).toBeGreaterThanOrEqual(1);

    const after = await current();
    expect(after.status).toBe('open');
    expect(after.version).toBeGreaterThan(before);
    // The job is spent, so a second sweep is a no-op rather than a loop.
    expect(await wakeJobs()).toHaveLength(0);
    expect(await lifecycle.sweepDueWakes(new Date(), 10)).toBe(0);
  });

  it('announces the wake on the feed with no actor, because nobody woke it', async () => {
    const events = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM realtime_events
          WHERE conversation_id = $1 AND type = 'conversation.state'
          ORDER BY seq DESC LIMIT 1`,
        [conversationId],
      ),
    );
    const payload = events.rows[0]?.payload as Record<string, unknown>;
    expect(payload['status']).toBe('open');
    expect(payload['previousStatus']).toBe('snoozed');
    expect(payload['actorMembershipId']).toBeNull();
    expect(payload['effects']).toContain('notify_team');
  });

  it('refuses a command against a conversation that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const response = await send(api, owner, 'POST', `/conversations/${missing}/transitions`, {
      version: 1,
      command: 'reopen',
    });
    // 404, not 403: the API conceals the difference between "not yours" and
    // "not there", so probing for ids tells a caller nothing.
    expect(response.statusCode).toBe(404);
    const episodes = await send(api, owner, 'GET', `/conversations/${missing}/episodes`);
    expect(episodes.statusCode).toBe(404);
  });

  it('refuses a command it does not have, and a wake time that is not a time', async () => {
    const unknown = await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
      version: 1,
      command: 'demolish',
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('validation_failed');

    for (const wakeAt of ['next tuesday', 42, null]) {
      const bad = await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
        version: 1,
        command: 'snooze',
        wakeAt,
        timezone: 'Asia/Riyadh',
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('clears a wake job when the customer answers before it fires', async () => {
    const wakeAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    expect(
      (await move(owner, { command: 'snooze', wakeAt: wakeAt.toISOString(), timezone: 'Asia/Riyadh' }))
        .statusCode,
    ).toBe(200);
    const scheduled = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM conversation_wakes WHERE conversation_id = $1', [conversationId]),
    );
    expect(scheduled.rowCount).toBe(1);

    await customerWrites(INBOX_A, peer, 'عدت قبل الموعد', 'wamid.rt-505');

    const woken = await current();
    expect(woken.status).toBe('open');
    // The job is spent, not left to fire into an open conversation later. A
    // wake that arrives after the customer already came back would move a
    // thread somebody is working on.
    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM conversation_wakes WHERE conversation_id = $1', [conversationId]),
    );
    expect(after.rowCount).toBe(0);
    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ snoozed_until: Date | null; snooze_timezone: string | null }>(
        'SELECT snoozed_until, snooze_timezone FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    expect(record.rows[0]?.snoozed_until).toBeNull();
    expect(record.rows[0]?.snooze_timezone).toBeNull();
  });

  it('starts the first-response clock when the agent replies, and never moves it again', async () => {
    const before = await send(api, owner, 'GET', `/conversations/${conversationId}/episodes`);
    const openEpisode = (before.json() as { data: { closedAt: string | null; firstResponseAt: string | null }[] })
      .data.at(-1);
    expect(openEpisode?.firstResponseAt).toBeNull();

    const first = await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'أهلًا، سأساعدك',
      trafficClass: 'interactive',
      clientMessageId: 'reply-first-response-1',
    });
    expect(first.statusCode).toBe(202);

    const after = await send(api, owner, 'GET', `/conversations/${conversationId}/episodes`);
    const stamped = (after.json() as { data: { firstResponseAt: string | null; firstResponseByMembershipId: string | null }[] }).data.at(-1);
    expect(stamped?.firstResponseAt).not.toBeNull();
    expect(stamped?.firstResponseByMembershipId).not.toBeNull();

    await send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'وأيضًا…',
      trafficClass: 'interactive',
      clientMessageId: 'reply-first-response-2',
    });
    const again = await send(api, owner, 'GET', `/conversations/${conversationId}/episodes`);
    // The first response is the first. A second reply that moved it would make
    // every first-response report a measure of the last message instead.
    expect((again.json() as { data: { firstResponseAt: string | null }[] }).data.at(-1)?.firstResponseAt).toBe(
      stamped?.firstResponseAt,
    );
    expect((again.json() as { data: { firstResponseByMembershipId: string | null }[] }).data.at(-1)?.firstResponseByMembershipId).toBe(
      stamped?.firstResponseByMembershipId,
    );
  });

  it('leaves a wake job for a conversation that has already moved as a no-op', async () => {
    // The race the sweeper is written for: the job was read, and by the time it
    // ran the conversation was no longer snoozed. The guarded UPDATE matches no
    // row, and the sweep must drop the job rather than force the transition.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO conversation_wakes (tenant_id, conversation_id, wake_at, wake_version)
         SELECT tenant_id, id, now() - interval '1 minute', wake_version
           FROM conversations WHERE id = $1`,
        [conversationId],
      ),
    );
    const status = await current();
    expect(status.status).not.toBe('snoozed');

    expect(await lifecycle.sweepDueWakes(new Date(), 10)).toBe(0);

    expect((await current()).status).toBe(status.status);
    const left = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM conversation_wakes WHERE conversation_id = $1', [conversationId]),
    );
    expect(left.rowCount).toBe(0);
  });

  it('resolves with a disposition, closes the episode, and does not mark anything read', async () => {
    expect((await move(owner, { command: 'resolve', resolution: 'تم التسجيل' })).statusCode).toBe(200);
    const resolved = await current();
    expect(resolved.status).toBe('resolved');
    expect((resolved as unknown as { resolution: string }).resolution).toBe('تم التسجيل');

    const episodes = await episodesOf();
    expect(episodes[0]?.closedAt).not.toBeNull();
    expect(episodes[0]?.resolution).toBe('تم التسجيل');
    expect((episodes[0] as unknown as { closedByMembershipId: string | null }).closedByMembershipId).not.toBeNull();

    // Resolving is not reading. The cursor is untouched, so an unread customer
    // message is still unread.
    const reads = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM conversation_reads WHERE conversation_id = $1', [conversationId]),
    );
    expect(reads.rows).toHaveLength(0);
  });

  it('refuses to resolve without a disposition', async () => {
    const response = await move(owner, { command: 'resolve' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a transition to a role that may read the conversation but not close it', async () => {
    await addMember(api, 'lifecycle-analyst@realtime.test', 'analyst', [
      { type: 'tenant', id: null },
    ]);
    const analyst = await login(api, 'lifecycle-analyst@realtime.test', MEMBER_PASSWORD);
    const { version } = await current();
    const response = await send(api, analyst, 'POST', `/conversations/${conversationId}/transitions`, {
      version,
      command: 'resolve',
      resolution: 'أُغلقت',
    });
    // Reading a conversation for reporting is not permission to end it.
    expect(response.statusCode).toBe(403);
  });

  it('reopens on a new inbound and starts a second episode, keeping the first', async () => {
    await customerWrites(INBOX_A, peer, 'عندي سؤال آخر', 'wamid.rt-510');
    expect((await current()).status).toBe('open');

    const episodes = await episodesOf();
    expect(episodes).toHaveLength(2);
    // The first episode's metrics survive: reusing it would date the second
    // issue's clock from the first issue's first message.
    expect(episodes[0]?.closedAt).not.toBeNull();
    expect(episodes[0]?.resolution).toBe('تم التسجيل');
    expect(episodes[1]).toMatchObject({ seq: 2, openedBy: 'customer_inbound', closedAt: null });
    expect(episodes[1]?.firstInboundAt).not.toBeNull();
  });

  it('refuses to reopen what is already open, and to archive what is not resolved', async () => {
    const reopen = await move(owner, { command: 'reopen' });
    expect(reopen.statusCode).toBe(409);
    expect((reopen.json() as { error: { code: string } }).error.code).toBe('already_open');

    const archive = await move(owner, { command: 'archive' });
    expect(archive.statusCode).toBe(409);
    expect((archive.json() as { error: { code: string } }).error.code).toBe('not_resolved');
  });

  it('refuses a transition carrying a version somebody else has already moved past', async () => {
    const { version } = await current();
    expect(
      (
        await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
          version: version - 1,
          command: 'resolve',
          resolution: 'قديم',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('resolving a snoozed thread spends its wake job too', async () => {
    const wakeAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    expect(
      (await move(owner, { command: 'snooze', wakeAt: wakeAt.toISOString(), timezone: 'Asia/Riyadh' }))
        .statusCode,
    ).toBe(200);
    expect((await move(owner, { command: 'resolve', resolution: 'ردّ متأخر' })).statusCode).toBe(200);

    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ status: string; snoozed_until: Date | null }>(
        'SELECT status, snoozed_until FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    expect(record.rows[0]?.status).toBe('resolved');
    // Otherwise the wake fires later and reopens a conversation somebody has
    // already closed, with no customer behind it.
    expect(record.rows[0]?.snoozed_until).toBeNull();
  });

  it('reopens on the agent’s word, in a new episode, with the old resolution cleared', async () => {
    const before = await episodesOf();
    expect((await move(owner, { command: 'reopen' })).statusCode).toBe(200);

    const reopened = await current();
    expect(reopened.status).toBe('open');
    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ resolution: string | null; resolved_at: Date | null }>(
        'SELECT resolution, resolved_at FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    // A reopened conversation carrying its old disposition would report as
    // resolved-with-an-answer while somebody is still working on it.
    expect(record.rows[0]?.resolution).toBeNull();
    expect(record.rows[0]?.resolved_at).toBeNull();

    const after = await episodesOf();
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ openedBy: 'agent_reopen', closedAt: null });
    // The earlier episode keeps its own numbers (CON-04).
    expect(after.at(-2)?.closedAt).not.toBeNull();
  });

  it('archives a resolved thread, and the next message opens a new one', async () => {
    expect((await move(owner, { command: 'resolve', resolution: 'انتهى' })).statusCode).toBe(200);
    expect((await move(owner, { command: 'archive' })).statusCode).toBe(200);
    const archived = await current();
    expect(archived.status).toBe('archived');

    await customerWrites(INBOX_A, peer, 'مرحبا من جديد', 'wamid.rt-520');
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; status: string }>(
        `SELECT id::text, status FROM conversations WHERE peer_identity = $1 ORDER BY created_at`,
        [peer],
      ),
    );
    // Two threads: the archived one is untouched history, and the customer's
    // new message opened a thread of its own.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: conversationId, status: 'archived' });
    expect(rows.rows[1]?.status).toBe('open');
    expect(rows.rows[1]?.id).not.toBe(conversationId);
  });

  it('refuses every command on an archived thread', async () => {
    for (const command of [
      { command: 'wait', reason: 'لا' },
      { command: 'resolve', resolution: 'لا' },
      { command: 'reopen' },
      { command: 'archive' },
    ]) {
      const response = await move(owner, command);
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'archived_conversation_is_immutable',
      );
    }
  });

  it('keeps the archived thread out of the working list but reachable by id', async () => {
    const list = await send(api, owner, 'GET', '/conversations?queue=all');
    const ids = (list.json() as { data: { id: string }[] }).data.map((row) => row.id);
    expect(ids).not.toContain(conversationId);
    expect((await send(api, owner, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(200);
  });

  it('clears the waiting reason when a claimed thread is resolved out of pending', async () => {
    // Its own conversation: the sequence above ends archived, and this needs a
    // live one that somebody actually holds.
    const held = '15557000550';
    await customerWrites(INBOX_A, held, 'سؤال ثانٍ', 'wamid.rt-550');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [held],
      ),
    );
    const id = row.rows[0]?.id as string;
    expect(
      (await send(api, owner, 'POST', `/conversations/${id}/claim`, { version: row.rows[0]?.version }))
        .statusCode,
    ).toBe(200);

    const claimed = await send(api, owner, 'GET', `/conversations/${id}`);
    const version = (claimed.json() as { data: { version: number } }).data.version;
    expect(
      (await send(api, owner, 'POST', `/conversations/${id}/transitions`, {
        version,
        command: 'wait',
        reason: 'في انتظار صورة الإيصال',
      })).statusCode,
    ).toBe(200);

    const pending = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ pending_reason: string | null; waiting_since: Date | null }>(
        'SELECT pending_reason, waiting_since FROM conversations WHERE id = $1',
        [id],
      ),
    );
    expect(pending.rows[0]?.pending_reason).toBe('في انتظار صورة الإيصال');
    // Held by somebody, so it is not waiting in the queue for anybody to pick up.
    expect(pending.rows[0]?.waiting_since).toBeNull();

    const afterWait = await send(api, owner, 'GET', `/conversations/${id}`);
    expect(
      (await send(api, owner, 'POST', `/conversations/${id}/transitions`, {
        version: (afterWait.json() as { data: { version: number } }).data.version,
        command: 'resolve',
        resolution: 'وصلت الصورة',
      })).statusCode,
    ).toBe(200);

    const resolved = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ pending_reason: string | null; pending_since: Date | null; status: string }>(
        'SELECT pending_reason, pending_since, status FROM conversations WHERE id = $1',
        [id],
      ),
    );
    expect(resolved.rows[0]?.status).toBe('resolved');
    // A resolved conversation still claiming to be waiting on the customer
    // would show in every "waiting on them" report forever.
    expect(resolved.rows[0]?.pending_reason).toBeNull();
    expect(resolved.rows[0]?.pending_since).toBeNull();
  });

  async function wakeJobs(): Promise<readonly { wake_at: Date; wake_version: number }[]> {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ wake_at: Date; wake_version: number }>(
        'SELECT wake_at, wake_version FROM conversation_wakes WHERE conversation_id = $1',
        [conversationId],
      ),
    );
    return rows.rows;
  }

  async function episodesOf(): Promise<
    readonly { seq: number; openedBy: string; closedAt: string | null; closedByMembershipId: string | null; resolution: string | null; firstInboundAt: string | null }[]
  > {
    const response = await send(api, owner, 'GET', `/conversations/${conversationId}/episodes`);
    return (
      response.json() as {
        data: {
          seq: number;
          openedBy: string;
          closedAt: string | null;
          closedByMembershipId: string | null;
          resolution: string | null;
          firstInboundAt: string | null;
        }[];
      }
    ).data;
  }
});

describe('private notes and the read cursor', () => {
  const peer = '15557000600';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'سؤال', 'wamid.rt-600');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  it('writes a note that never becomes a message and never reopens anything', async () => {
    const before = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text FROM outbound_messages'),
    );
    const created = await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, {
      body: 'العميل اتصل هاتفيًا أمس',
    });
    expect(created.statusCode).toBe(201);

    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text FROM outbound_messages'),
    );
    // Nothing was queued to send. A note has nowhere to become a message.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('does not reopen a resolved conversation', async () => {
    const { data } = (await send(api, owner, 'GET', `/conversations/${conversationId}`)).json() as {
      data: { version: number };
    };
    const version = data.version;
    expect(
      (
        await send(api, owner, 'POST', `/conversations/${conversationId}/transitions`, {
          version,
          command: 'resolve',
          resolution: 'مغلق',
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, { body: 'ملاحظة بعد الإغلاق' }))
        .statusCode,
    ).toBe(201);

    const after = (await send(api, owner, 'GET', `/conversations/${conversationId}`)).json() as {
      data: { status: string };
    };
    // §18.1's last row, tested rather than assumed.
    expect(after.data.status).toBe('resolved');
  });

  it('lets only the author edit or delete, and keeps the row when they do', async () => {
    const created = await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, {
      body: 'نص أصلي',
    });
    const noteId = (created.json() as { data: { id: string } }).data.id;

    const byAnother = await send(api, agentA, 'PATCH', `/notes/${noteId}`, { body: 'نص آخر' });
    expect([403, 404]).toContain(byAnother.statusCode);

    const edited = await send(api, owner, 'PATCH', `/notes/${noteId}`, { body: 'نص مصحّح' });
    expect(edited.statusCode).toBe(200);
    const editedNote = (edited.json() as { data: { body: string; editedAt: string | null } }).data;
    expect(editedNote.body).toBe('نص مصحّح');
    // Marked, not silent: a colleague who acted on the old text can see it moved.
    expect(editedNote.editedAt).not.toBeNull();

    const removed = await send(api, owner, 'DELETE', `/notes/${noteId}`);
    expect(removed.statusCode).toBe(200);
    const removedNote = (removed.json() as { data: { body: string; deletedAt: string | null; authorMembershipId: string | null } }).data;
    expect(removedNote.deletedAt).not.toBeNull();
    // The row and its attribution stay; only the text goes.
    expect(removedNote.body).toBe('');
    expect(removedNote.authorMembershipId).not.toBeNull();

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query('SELECT 1 FROM conversation_notes WHERE id = $1', [noteId]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('lists the notes on a conversation, with a deleted one stripped of its text', async () => {
    const written = await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, {
      body: 'ملاحظة ستُحذف',
    });
    expect(written.statusCode).toBe(201);
    const noteId = (written.json() as { data: { id: string } }).data.id;

    const before = await send(api, owner, 'GET', `/conversations/${conversationId}/notes`);
    expect(before.statusCode).toBe(200);
    const listed = (before.json() as { data: { id: string; body: string }[] }).data;
    expect(listed.some((entry) => entry.id === noteId && entry.body === 'ملاحظة ستُحذف')).toBe(true);

    expect((await send(api, owner, 'DELETE', `/notes/${noteId}`)).statusCode).toBe(200);

    const after = await send(api, owner, 'GET', `/conversations/${conversationId}/notes`);
    const deleted = (after.json() as { data: { id: string; body: string; deletedAt: string | null }[] }).data.find(
      (entry) => entry.id === noteId,
    );
    // The row stays and keeps its attribution; it loses only its text. A thread
    // that quietly dropped an internal remark could not be reconstructed, and
    // one that kept the text after a deletion would not honour the deletion.
    expect(deleted?.deletedAt).not.toBeNull();
    expect(deleted?.body).not.toBe('ملاحظة ستُحذف');
  });

  it('answers 404 for notes on a conversation that does not exist, and for an unknown note', async () => {
    const missing = '00000000-0000-4000-8000-0000000000fe';
    expect((await send(api, owner, 'GET', `/conversations/${missing}/notes`)).statusCode).toBe(404);
    expect(
      (await send(api, owner, 'POST', `/conversations/${missing}/notes`, { body: 'مرحبا' }))
        .statusCode,
    ).toBe(404);
    const unknownNote = '00000000-0000-4000-8000-0000000000fd';
    expect(
      (await send(api, owner, 'PATCH', `/notes/${unknownNote}`, { body: 'تصحيح' })).statusCode,
    ).toBe(404);
    expect((await send(api, owner, 'DELETE', `/notes/${unknownNote}`)).statusCode).toBe(404);
  });

  it('refuses to edit a note that is already deleted', async () => {
    const created = await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, {
      body: 'سيُحذف',
    });
    const noteId = (created.json() as { data: { id: string } }).data.id;
    await send(api, owner, 'DELETE', `/notes/${noteId}`);
    const response = await send(api, owner, 'PATCH', `/notes/${noteId}`, { body: 'محاولة' });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('note_already_deleted');
  });

  it('lets a colleague read a note but not rewrite it', async () => {
    const written = await send(api, owner, 'POST', `/conversations/${conversationId}/notes`, {
      body: 'ملاحظة صاحبها معروف',
    });
    const noteId = (written.json() as { data: { id: string } }).data.id;

    const connection = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string }>(
        'SELECT connection_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    // A supervisor scoped to this inbox: they may note on the conversation, so
    // the refusal under test is the authorship one and not a permission one.
    await addMember(api, 'note-colleague@realtime.test', 'supervisor', [
      { type: 'inbox', id: connection.rows[0]?.connection_id ?? null },
    ]);
    const colleague = await login(api, 'note-colleague@realtime.test', MEMBER_PASSWORD);

    const edited = await send(api, colleague, 'PATCH', `/notes/${noteId}`, { body: 'ليست لي' });
    // 403 and not 404: this caller may read the note, so pretending it does not
    // exist would be a worse answer than the true one.
    expect(edited.statusCode).toBe(403);
    expect((edited.json() as { error: { code: string } }).error.code).toBe('not_the_author');
    expect((await send(api, colleague, 'DELETE', `/notes/${noteId}`)).statusCode).toBe(403);
  });

  it('keeps notes away from a role that may read conversations but not note on them', async () => {
    await addMember(api, 'note-analyst@realtime.test', 'analyst', [{ type: 'tenant', id: null }]);
    const analyst = await login(api, 'note-analyst@realtime.test', MEMBER_PASSWORD);
    const response = await send(api, analyst, 'GET', `/conversations/${conversationId}/notes`);
    // Reading a conversation for reporting is not permission to read what
    // colleagues said to each other about the customer.
    expect(response.statusCode).toBe(403);
  });

  it('moves only this person’s read cursor, and never backwards', async () => {
    const marked = await send(api, owner, 'POST', `/conversations/${conversationId}/read`, {});
    expect(marked.statusCode).toBe(200);
    const first = (marked.json() as { data: { readThrough: string } }).data.readThrough;

    const backwards = await send(api, owner, 'POST', `/conversations/${conversationId}/read`, {
      readThrough: new Date(Date.now() - 3_600_000).toISOString(),
    });
    // Opening an old conversation must not un-read the newer part of it.
    expect((backwards.json() as { data: { readThrough: string } }).data.readThrough).toBe(first);

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text FROM conversation_reads WHERE conversation_id = $1',
        [conversationId],
      ),
    );
    // One row: the cursor belongs to a person, not to the conversation.
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('refuses to record a read of the future', async () => {
    const response = await send(api, owner, 'POST', `/conversations/${conversationId}/read`, {
      readThrough: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const stored = new Date((response.json() as { data: { readThrough: string } }).data.readThrough);
    expect(stored.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('answers unread per person on the list', async () => {
    await send(api, owner, 'POST', `/conversations/${conversationId}/read`, {});
    const mine = await send(api, owner, 'GET', '/conversations?queue=all');
    const row = (mine.json() as { data: { id: string; unread: boolean }[] }).data.find(
      (entry) => entry.id === conversationId,
    );
    expect(row?.unread).toBe(false);

    // A colleague who has not opened it sees it as unread, from the same row.
    const theirs = await send(api, owner, 'GET', '/conversations?queue=all');
    expect(theirs.statusCode).toBe(200);

    await customerWrites(INBOX_A, peer, 'رسالة جديدة', 'wamid.rt-610');
    const afterNews = await send(api, owner, 'GET', '/conversations?queue=all');
    const again = (afterNews.json() as { data: { id: string; unread: boolean }[] }).data.find(
      (entry) => entry.id === conversationId,
    );
    // New activity past the cursor makes it unread again.
    expect(again?.unread).toBe(true);
  });
});

/* ========================================================== work routing == */

/**
 * Assignment, handoff, priority and collaborators, against real PostgreSQL.
 *
 * Three acts move a conversation between people and this suite exists to prove
 * they stay apart (ADR-0017): a **claim** takes work nobody holds, an
 * **assignment** puts work on a named desk, and a **handoff** asks a colleague
 * who may decline. The claims worth the transactions are the ones about what
 * cannot happen — an Agent reassigning somebody else's work, a stale version
 * silently taking a conversation, a pending offer quietly moving it, an audit
 * row that can be rewritten, a directory that leaks the People screen.
 */
describe('direct assignment', () => {
  const peer = '15557000700';
  let conversationId: string;
  async function current(): Promise<{
    version: number;
    assigneeMembershipId: string | null;
    priority: string;
    ownerState: string;
    ownerVersion: number;
  }> {
    const response = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    expect(response.statusCode, response.payload).toBe(200);
    return (
      response.json() as {
        data: {
          version: number;
          assigneeMembershipId: string | null;
          priority: string;
          ownerState: string;
          ownerVersion: number;
        };
      }
    ).data;
  }

  async function assignTo(
    browser: Browser,
    target: string | null,
    version?: number,
  ): Promise<LightMyRequestResponse> {
    const at = version ?? (await current()).version;
    return send(api, browser, 'POST', `/conversations/${conversationId}/assignments`, {
      version: at,
      assigneeMembershipId: target,
    });
  }

  async function auditOf(): Promise<readonly { act: string; from_value: string | null; to_value: string | null }[]> {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ act: string; from_value: string | null; to_value: string | null }>(
        `SELECT act, from_value::text, to_value::text FROM conversation_audit
          WHERE conversation_id = $1 ORDER BY at, act`,
        [conversationId],
      ),
    );
    return rows.rows;
  }

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'من فضلكم', 'wamid.rt-700');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  it('starts owned by people, at ownership version one', async () => {
    const record = await current();
    // ADR-0008's dimension, backfilled truthfully: no bot exists, so every
    // conversation in this build is worked by humans.
    expect(record.ownerState).toBe('human_active');
    expect(record.ownerVersion).toBe(1);
    expect(record.assigneeMembershipId).toBeNull();
  });

  it('lets an Owner put a conversation on a named desk', async () => {
    const response = await assignTo(owner, agentAMembershipId);
    expect(response.statusCode, response.payload).toBe(200);
    const record = await current();
    expect(record.assigneeMembershipId).toBe(agentAMembershipId);
    // Being given a conversation is an ownership transition, which is the
    // mechanism behind ADR-0008's "the bot resumes only by an explicit resume
    // or reassignment".
    expect(record.ownerVersion).toBe(2);

    const audit = await auditOf();
    expect(audit.at(-1)).toMatchObject({ act: 'assign', from_value: null, to_value: agentAMembershipId });
  });

  it('refuses an Agent the authority to reassign anybody', async () => {
    // business-rules.md §7: "Assign others / override routing" is `No` for an
    // Agent, even on a conversation they hold.
    const response = await assignTo(agentA, agentAMembershipId);
    expect(response.statusCode).toBe(403);
  });

  it('lets a Supervisor assign inside their scope and nowhere else', async () => {
    expect((await assignTo(supervisor, supervisorMembershipId)).statusCode).toBe(200);
    expect((await current()).assigneeMembershipId).toBe(supervisorMembershipId);

    // A conversation on the inbox they were never granted.
    const elsewhere = '15557000701';
    await customerWrites(INBOX_B, elsewhere, 'سؤال آخر', 'wamid.rt-701');
    const other = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [elsewhere],
      ),
    );
    const denied = await send(
      api,
      supervisor,
      'POST',
      `/conversations/${other.rows[0]?.id as string}/assignments`,
      { version: other.rows[0]?.version, assigneeMembershipId: agentBMembershipId },
    );
    expect(denied.statusCode).toBe(403);
  });

  it('refuses a target who could not work the conversation', async () => {
    // Same answer for every kind of unusable target: a caller with routing
    // authority may learn that a person is not eligible, and must not be able
    // to tell "wrong inbox" from "no such membership" and enumerate the company.
    for (const target of [
      agentBMembershipId, // real, active, wrong inbox
      '00000000-0000-4000-8000-0000000000aa', // no such membership
      'not-a-uuid',
    ]) {
      const response = await assignTo(owner, target);
      expect(response.statusCode, `${target}: ${response.payload}`).toBe(422);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'assignee_not_eligible',
      );
    }
  });

  it('refuses a revoked membership, re-derived inside the write', async () => {
    const membershipId = await addMember(api, 'agent-leaving@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    // Eligible at first — the directory would have listed them a moment ago.
    expect((await assignTo(owner, membershipId)).statusCode).toBe(200);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(`UPDATE memberships SET status = 'revoked' WHERE id = $1`, [membershipId]),
    );
    const response = await assignTo(owner, membershipId);
    expect(response.statusCode).toBe(422);
  });

  it('produces exactly one winner when two people assign at one version', async () => {
    const { version } = await current();
    const [first, second] = await Promise.all([
      assignTo(owner, agentAMembershipId, version),
      assignTo(owner, supervisorMembershipId, version),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect((loser.json() as { error: { code: string } }).error.code).toBe(
      'conversation_version_conflict',
    );
  });

  it('produces exactly one winner between a claim and an assignment', async () => {
    // Unassign first, so a claim is possible at all.
    expect((await assignTo(owner, null)).statusCode).toBe(200);
    const { version } = await current();

    const [claimed, assigned] = await Promise.all([
      send(api, agentA, 'POST', `/conversations/${conversationId}/claim`, { version }),
      assignTo(owner, supervisorMembershipId, version),
    ]);
    expect([claimed.statusCode, assigned.statusCode].sort()).toEqual([200, 409]);
    // Whoever lost, nobody was quietly overwritten: the record names exactly one.
    const record = await current();
    expect(record.assigneeMembershipId).not.toBeNull();
  });

  it('takes a conversation off every desk without erasing who worked it', async () => {
    expect((await assignTo(owner, agentAMembershipId)).statusCode).toBe(200);
    expect((await assignTo(owner, null)).statusCode).toBe(200);

    const record = await current();
    expect(record.assigneeMembershipId).toBeNull();

    const participants = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ membership_id: string }>(
        'SELECT membership_id::text FROM conversation_participants WHERE conversation_id = $1',
        [conversationId],
      ),
    );
    // Participation outlives assignment. Deleting it to make the queue look
    // tidy would erase the authorship of whatever those people wrote.
    expect(participants.rows.map((r) => r.membership_id)).toContain(agentAMembershipId);
    expect((await auditOf()).at(-1)).toMatchObject({ act: 'unassign', to_value: null });
  });

  it('treats re-assigning to the same person as no change at all', async () => {
    expect((await assignTo(owner, agentAMembershipId)).statusCode).toBe(200);
    const before = await current();
    const auditBefore = (await auditOf()).length;

    expect((await assignTo(owner, agentAMembershipId)).statusCode).toBe(200);
    const after = await current();
    // No version bump and no audit row: a re-pressed button must not produce
    // evidence that the conversation moved when it did not.
    expect(after.version).toBe(before.version);
    expect((await auditOf()).length).toBe(auditBefore);
  });

  it('keeps the audit append-only, even for the runtime role', async () => {
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query('UPDATE conversation_audit SET act = $1 WHERE conversation_id = $2', [
          'claim',
          conversationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query('DELETE FROM conversation_audit WHERE conversation_id = $1', [conversationId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('answers 404 for a conversation in another company, however it is guessed', async () => {
    const foreign = '00000000-0000-4000-8000-0000000000bb';
    const response = await send(api, owner, 'POST', `/conversations/${foreign}/assignments`, {
      version: 1,
      assigneeMembershipId: agentAMembershipId,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the assignee directory', () => {
  const peer = '15557000710';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'مرحبا', 'wamid.rt-710');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  async function directory(browser: Browser): Promise<LightMyRequestResponse> {
    return send(api, browser, 'GET', `/directory/agents?conversation_id=${conversationId}`);
  }

  it('lists only people who could actually work this conversation', async () => {
    const response = await directory(supervisor);
    expect(response.statusCode, response.payload).toBe(200);
    const ids = (response.json() as { data: { membershipId: string }[] }).data.map(
      (entry) => entry.membershipId,
    );
    // On this inbox.
    expect(ids).toContain(agentAMembershipId);
    // On the other one. Listing them would offer an assignment the write would
    // then refuse, which reads as the software being unreliable.
    expect(ids).not.toContain(agentBMembershipId);
  });

  it('exposes an allowlist and nothing the People screen would show', async () => {
    const response = await directory(supervisor);
    const entries = (response.json() as { data: Record<string, unknown>[] }).data;
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['assigned', 'label', 'membershipId']);
    }
    // No role, no scopes, no status, and above all no login address: a
    // Supervisor may route work and may not administer memberships. (The
    // labels themselves come from the email local part in this fixture, so the
    // check is on the field names and on the address, not on a substring that
    // a legitimate name could contain.)
    expect(response.payload).not.toContain('@realtime.test');
    for (const field of ['"role"', '"scopes"', '"status"', '"email"', '"mfa']) {
      expect(response.payload).not.toContain(field);
    }
  });

  it('names people rather than showing internal identifiers', async () => {
    const response = await directory(supervisor);
    const entries = (response.json() as { data: { label: string; membershipId: string }[] }).data;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label).not.toBe(entry.membershipId);
    }
  });

  it('omits a membership that is no longer active', async () => {
    const membershipId = await addMember(api, 'agent-suspended@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    expect(
      (await directory(supervisor)).payload.includes(membershipId),
      'active member should be listed',
    ).toBe(true);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [membershipId]),
    );
    expect((await directory(supervisor)).payload.includes(membershipId)).toBe(false);
  });

  it('answers an Agent only about a conversation that is theirs', async () => {
    // Unassigned, so an Agent has nothing to offer and no reason for the names.
    expect((await directory(agentA)).statusCode).toBe(403);

    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    expect(
      (await send(api, agentA, 'POST', `/conversations/${conversationId}/claim`, {
        version: record.rows[0]?.version,
      })).statusCode,
    ).toBe(200);

    // Now it is theirs. An Agent cannot assign, but ADR-0017 lets them ask —
    // and refusing them the list would make the one request they are allowed to
    // make unusable.
    expect((await directory(agentA)).statusCode).toBe(200);
  });

  it('refuses somebody with no reason to be near the conversation', async () => {
    await addMember(api, 'analyst-directory@realtime.test', 'analyst', [
      { type: 'tenant', id: null },
    ]);
    const analyst = await login(api, 'analyst-directory@realtime.test', MEMBER_PASSWORD);
    expect((await directory(analyst)).statusCode).toBe(403);
    // An agent on another inbox learns nothing about this conversation at all.
    expect((await directory(agentB)).statusCode).toBe(403);
  });

  it('requires a conversation to be about', async () => {
    const response = await send(api, supervisor, 'GET', '/directory/agents');
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('validation_failed');
  });
});

describe('person-to-person handoff', () => {
  const peer = '15557000720';
  let conversationId: string;

  async function assigneeOf(): Promise<string | null> {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ assignee_membership_id: string | null }>(
        'SELECT assignee_membership_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    return rows.rows[0]?.assignee_membership_id ?? null;
  }

  async function stateOf(handoffId: string): Promise<string> {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ state: string }>('SELECT state FROM conversation_handoffs WHERE id = $1', [
        handoffId,
      ]),
    );
    return rows.rows[0]?.state as string;
  }

  /** Puts the conversation on agentA's desk and clears any live offer. */
  async function giveToAgentA(): Promise<void> {
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE conversation_handoffs SET state = 'cancelled', settled_at = now()
          WHERE conversation_id = $1 AND state = 'pending'`,
        [conversationId],
      ),
    );
    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    const response = await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
      version: record.rows[0]?.version,
      assigneeMembershipId: agentAMembershipId,
    });
    expect(response.statusCode, response.payload).toBe(200);
  }

  async function offer(
    browser: Browser,
    to: string,
    body: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    return send(api, browser, 'POST', `/conversations/${conversationId}/handoffs`, {
      version: record.rows[0]?.version,
      toMembershipId: to,
      ...body,
    });
  }

  async function settle(
    browser: Browser,
    handoffId: string,
    action: string,
  ): Promise<LightMyRequestResponse> {
    return send(api, browser, 'POST', `/handoffs/${handoffId}/${action}`);
  }

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'أحتاج متابعة', 'wamid.rt-720');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
    await giveToAgentA();
  }, 120_000);

  it('lets an Agent offer their own conversation without moving it', async () => {
    const response = await offer(agentA, secondAgentAMembershipId, { note: 'لديك خبرة بالحالة' });
    expect(response.statusCode, response.payload).toBe(201);
    const created = (response.json() as { data: { id: string; state: string } }).data;
    expect(created.state).toBe('pending');

    // The whole point: an unanswered request is not limbo. Somebody is still
    // responsible for the customer, and it is whoever was responsible before.
    expect(await assigneeOf()).toBe(agentAMembershipId);
    expect(await settle(agentA, created.id, 'cancel')).toMatchObject({ statusCode: 200 });
  });

  it('refuses to create an offer from a stale screen', async () => {
    const version = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    const response = await offer(agentA, secondAgentAMembershipId, {
      version: (version.rows[0]?.version ?? 1) - 1,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'conversation_version_conflict',
    );
  });

  it('refuses an Agent a handoff from somebody else’s conversation', async () => {
    const response = await offer(secondAgentA, agentAMembershipId);
    // `own` scope. An Agent may offer what they are holding and nothing else.
    expect(response.statusCode).toBe(403);
  });

  it('refuses a handoff addressed to yourself', async () => {
    const response = await offer(agentA, agentAMembershipId);
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('handoff_to_self');
  });

  it('refuses a recipient who could never take it', async () => {
    const response = await offer(agentA, agentBMembershipId);
    // Offering a conversation to somebody on another inbox produces a request
    // that can only ever expire, and an audit row saying they ignored you.
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'assignee_not_eligible',
    );
  });

  it('refuses an expiry that is not a real window', async () => {
    const soon = await offer(agentA, secondAgentAMembershipId, {
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(soon.statusCode).toBe(422);
    expect((soon.json() as { error: { code: string } }).error.code).toBe('handoff_expiry_too_soon');

    const far = await offer(agentA, secondAgentAMembershipId, {
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(far.statusCode).toBe(422);
    expect((far.json() as { error: { code: string } }).error.code).toBe('handoff_expiry_too_far');
  });

  it('allows only one live offer per conversation', async () => {
    const first = await offer(agentA, secondAgentAMembershipId);
    expect(first.statusCode).toBe(201);
    const second = await offer(agentA, supervisorMembershipId);
    // "Who is being asked" has to have one answer.
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'handoff_already_pending',
    );
    await settle(agentA, (first.json() as { data: { id: string } }).data.id, 'cancel');
  });

  it('lets only the named recipient answer', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;

    // The requester cannot answer on their colleague's behalf, and neither can
    // a supervisor: answering for somebody is not an answer.
    expect((await settle(agentA, created.id, 'accept')).statusCode).toBe(403);
    expect((await settle(supervisor, created.id, 'decline')).statusCode).toBe(403);
    expect(await stateOf(created.id)).toBe('pending');

    expect((await settle(secondAgentA, created.id, 'decline')).statusCode).toBe(200);
    expect(await stateOf(created.id)).toBe('declined');
    // A decline changes no assignment at all.
    expect(await assigneeOf()).toBe(agentAMembershipId);
  });

  it('lets the requester or an assigner withdraw, and nobody else', async () => {
    const mine = ((await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } })
      .data;
    expect((await settle(secondAgentA, mine.id, 'cancel')).statusCode).toBe(403);
    expect((await settle(agentA, mine.id, 'cancel')).statusCode).toBe(200);
    expect(await assigneeOf()).toBe(agentAMembershipId);

    const again = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;
    // Tidying up a stale offer is a routing act, so somebody who could have
    // made the assignment outright may withdraw it.
    expect((await settle(supervisor, again.id, 'cancel')).statusCode).toBe(200);
  });

  it('applies the reassignment exactly once on acceptance', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;
    expect((await settle(secondAgentA, created.id, 'accept')).statusCode).toBe(200);
    expect(await assigneeOf()).toBe(secondAgentAMembershipId);
    expect(await stateOf(created.id)).toBe('accepted');

    // A retry cannot apply the transfer twice or reopen the offer.
    const retry = await settle(secondAgentA, created.id, 'accept');
    expect(retry.statusCode).toBe(409);
    expect((retry.json() as { error: { code: string } }).error.code).toBe('handoff_not_pending');

    const accepted = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM conversation_audit
          WHERE conversation_id = $1 AND act = 'handoff_accepted'`,
        [conversationId],
      ),
    );
    expect(accepted.rows[0]?.count).toBe('1');
    await giveToAgentA();
  });

  it('records the settlement as evidence, not only as a state', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId, { note: 'خذها من فضلك' }))
        .json() as { data: { id: string } }
    ).data;
    await settle(secondAgentA, created.id, 'decline');

    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ act: string; actor_membership_id: string | null }>(
        `SELECT act, actor_membership_id::text FROM conversation_audit
          WHERE conversation_id = $1 AND act LIKE 'handoff%' ORDER BY at`,
        [conversationId],
      ),
    );
    const acts = rows.rows.map((r) => r.act);
    expect(acts).toContain('handoff_requested');
    expect(acts).toContain('handoff_declined');
    // Every state change is audited in the same transaction as its effect, so
    // the trail survives even though the offer row itself carries only the
    // terminal state.
    expect(rows.rows.at(-1)?.actor_membership_id).toBe(secondAgentAMembershipId);
  });

  it('refuses an offer whose recipient has since lost the inbox', async () => {
    const membershipId = await addMember(api, 'agent-departing@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    const departing = await login(api, 'agent-departing@realtime.test', MEMBER_PASSWORD);
    const created = ((await offer(agentA, membershipId)).json() as { data: { id: string } }).data;

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query('DELETE FROM membership_scopes WHERE membership_id = $1', [membershipId]),
    );

    const response = await settle(departing, created.id, 'accept');
    // Eligibility is re-checked inside the write, not only when the offer was
    // made: an offer from last week must not let somebody back into an inbox
    // they no longer have.
    expect([403, 422]).toContain(response.statusCode);
    expect(await assigneeOf()).toBe(agentAMembershipId);
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE conversation_handoffs SET state = 'cancelled', settled_at = now()
          WHERE id = $1 AND state = 'pending'`,
        [created.id],
      ),
    );
  });

  it('expires an offer from a stored instant, and assigns nothing', async () => {
    const created = ((await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } })
      .data;
    // Backdated in the database rather than waited out: expiry is a fact about
    // a stored instant, so the sweep is what has to notice it. `created_at`
    // moves too, because the table refuses an offer that expires before it was
    // made — this is an offer from two hours ago with a one-hour window, not an
    // impossible row.
    await withTenant(api.pool, api.tenantId, async (client) => {
      await client.query(
        `UPDATE conversation_handoffs
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'
          WHERE id = $1`,
        [created.id],
      );
      // Replaced rather than edited: the schedule is written once and removed
      // when the offer is answered, and the runtime role holds no UPDATE on it
      // for exactly that reason.
      await client.query('DELETE FROM conversation_handoff_expiries WHERE handoff_id = $1', [
        created.id,
      ]);
      await client.query(
        `INSERT INTO conversation_handoff_expiries
           (handoff_id, tenant_id, conversation_id, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 hour')`,
        [created.id, api.tenantId, conversationId],
      );
    });

    // Past its instant, it is already unusable — before any worker has run.
    const early = await settle(secondAgentA, created.id, 'accept');
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: { code: string } }).error.code).toBe('handoff_expired');

    const worker = await tickFor('worker-inbound', { app: api.app, concurrency: 1 })();
    expect(worker.handled).toBeGreaterThanOrEqual(1);
    expect(await stateOf(created.id)).toBe('expired');
    expect(await assigneeOf()).toBe(agentAMembershipId);

    const expired = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ actor_membership_id: string | null }>(
        `SELECT actor_membership_id::text FROM conversation_audit
          WHERE conversation_id = $1 AND act = 'handoff_expired'`,
        [conversationId],
      ),
    );
    // Nobody caused it. The clock did, and the audit says so rather than
    // attributing the expiry to whoever happened to run the sweep.
    expect(expired.rows[0]?.actor_membership_id).toBeNull();
  });

  it('makes an offer unusable once the conversation has moved on', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;

    // A supervisor reassigns it outright while the offer stands.
    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    expect(
      (await send(api, supervisor, 'POST', `/conversations/${conversationId}/assignments`, {
        version: record.rows[0]?.version,
        assigneeMembershipId: supervisorMembershipId,
      })).statusCode,
    ).toBe(200);

    const late = await settle(secondAgentA, created.id, 'accept');
    // The acceptance is fenced on the version at the moment of acceptance, so
    // an offer made against an older one cannot take the conversation from
    // whoever holds it now.
    expect(late.statusCode).toBe(409);
    expect(await assigneeOf()).toBe(supervisorMembershipId);
    await giveToAgentA();
  });

  it('keeps a handoff off a preview-only agent’s feed', async () => {
    // The conversation is assigned, so an agent without `conversation.read` for
    // it sees nothing anyway — but the event type is what does the filtering,
    // before any payload is read.
    const before = await feed(agentB);
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;
    const after = await feed(agentB, before.cursor);
    expect(after.events.filter((event) => event.scope.conversationId === conversationId)).toEqual([]);
    await settle(agentA, created.id, 'cancel');
  });

  it('lists the offers on a conversation, settled ones included', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId, { note: 'راجعها من فضلك' }))
        .json() as { data: { id: string } }
    ).data;
    await settle(secondAgentA, created.id, 'decline');

    const response = await send(api, agentA, 'GET', `/conversations/${conversationId}/handoffs`);
    expect(response.statusCode, response.payload).toBe(200);
    const rows = (response.json() as { data: { id: string; state: string; toLabel: string }[] }).data;
    const mine = rows.find((row) => row.id === created.id);
    // Newest first, with the settled history behind it: "who was asked and what
    // did they say" is a question about the past as much as the present.
    expect(rows[0]?.id).toBe(created.id);
    expect(mine?.state).toBe('declined');
    // Named, not identified: the list carries the label a company shows.
    expect(mine?.toLabel.length).toBeGreaterThan(0);
  });

  it('refuses the offers to somebody with no part in them', async () => {
    // Neither named in an offer, nor holding routing authority here.
    const response = await send(api, agentB, 'GET', `/conversations/${conversationId}/handoffs`);
    expect(response.statusCode).toBe(403);
  });

  it('hides an offer from a bystander who could not have made it', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;
    // agentB is named in nothing and may not assign here: the offer is not
    // theirs to see, let alone to answer, and it is concealed rather than
    // refused with a reason that confirms it exists.
    expect((await settle(agentB, created.id, 'cancel')).statusCode).toBe(404);
    await settle(agentA, created.id, 'cancel');
  });

  it('answers 404 for an offer id from another company', async () => {
    const response = await settle(owner, '00000000-0000-4000-8000-0000000000cc', 'cancel');
    expect(response.statusCode).toBe(404);
  });

  it('knows only three answers to an offer', async () => {
    const created = (
      (await offer(agentA, secondAgentAMembershipId)).json() as { data: { id: string } }
    ).data;
    // A fourth verb is not a bad request, it is a route that does not exist.
    expect((await settle(agentA, created.id, 'ignore')).statusCode).toBe(404);
    await settle(agentA, created.id, 'cancel');
  });

  it('refuses an expiry that is not a timestamp', async () => {
    for (const expiresAt of ['next tuesday', 42, true]) {
      const response = await offer(agentA, secondAgentAMembershipId, { expiresAt });
      expect(response.statusCode, JSON.stringify(expiresAt)).toBe(400);
    }
  });
});

describe('priority and collaborators', () => {
  const peer = '15557000730';
  let conversationId: string;

  async function versionOf(): Promise<number> {
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    return rows.rows[0]?.version as number;
  }

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'عاجل', 'wamid.rt-730');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  it('changes priority, fenced and audited with the value it replaced', async () => {
    const response = await send(api, supervisor, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: await versionOf(),
      priority: 'urgent',
      reason: 'العميل ينتظر منذ الصباح',
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect((response.json() as { data: { priority: string } }).data.priority).toBe('urgent');

    const audit = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ from_value: string; to_value: string; detail: { reason?: string } }>(
        `SELECT from_value, to_value, detail FROM conversation_audit
          WHERE conversation_id = $1 AND act = 'priority_changed' ORDER BY at DESC LIMIT 1`,
        [conversationId],
      ),
    );
    // The previous value, not just the new one: a report that cannot say what a
    // conversation was raised *from* cannot say anything about escalation.
    expect(audit.rows[0]).toMatchObject({ from_value: 'normal', to_value: 'urgent' });
    expect(audit.rows[0]?.detail.reason).toBe('العميل ينتظر منذ الصباح');
  });

  it('refuses a stale version and a value outside the four', async () => {
    const stale = await send(api, supervisor, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: 1,
      priority: 'high',
    });
    expect(stale.statusCode).toBe(409);

    const invalid = await send(api, supervisor, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: await versionOf(),
      priority: 'catastrophic',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('treats setting the priority it already has as no change', async () => {
    const before = await versionOf();
    const current = await send(api, owner, 'GET', `/conversations/${conversationId}`);
    const priority = (current.json() as { data: { priority: string } }).data.priority;

    const response = await send(api, supervisor, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: before,
      priority,
    });
    expect(response.statusCode).toBe(200);
    // No version bump and no audit row: re-pressing a button that already
    // happened must not produce evidence that something changed.
    expect(await versionOf()).toBe(before);
  });

  it('refuses an Agent, because priority is routing', async () => {
    const response = await send(api, agentA, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: await versionOf(),
      priority: 'low',
    });
    // business-rules.md §7: "Assign others / override routing" is `No` for an
    // Agent, and priority is routing (ADR-0017).
    expect(response.statusCode).toBe(403);
  });

  it('gives a collaborator reach, and takes it away again without erasing them', async () => {
    // agentB is on another inbox and cannot read this conversation. 403 rather
    // than 404 is this repository's in-tenant rule: 404 conceals whether a
    // *company* exists, and is asserted for a cross-tenant id elsewhere in this
    // file; inside a company a member is told plainly that an action is denied.
    expect((await send(api, agentB, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(403);

    const added = await send(api, owner, 'POST', `/conversations/${conversationId}/collaborators`, {
      version: await versionOf(),
      membershipId: secondAgentAMembershipId,
    });
    expect(added.statusCode, added.payload).toBe(200);
    const listed = (added.json() as { data: { membershipId: string; participated: boolean }[] }).data;
    expect(listed.map((entry) => entry.membershipId)).toContain(secondAgentAMembershipId);
    // Invited, not yet acted.
    expect(listed[0]?.participated).toBe(false);

    // An invitation is reach: `own` grants now find them on this conversation.
    expect((await send(api, secondAgentA, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(
      200,
    );

    const removed = await send(
      api,
      owner,
      'DELETE',
      `/conversations/${conversationId}/collaborators/${secondAgentAMembershipId}?version=${String(await versionOf())}`,
    );
    expect(removed.statusCode, removed.payload).toBe(200);
    expect((removed.json() as { data: unknown[] }).data).toEqual([]);
    // Removal ends the invitation for the future.
    expect((await send(api, secondAgentA, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(
      403,
    );

    // And the row is still there, closed rather than deleted.
    const history = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ removed_at: Date | null }>(
        `SELECT removed_at FROM conversation_collaborators
          WHERE conversation_id = $1 AND membership_id = $2`,
        [conversationId, secondAgentAMembershipId],
      ),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]?.removed_at).not.toBeNull();
  });

  it('cannot erase somebody who actually did something', async () => {
    // Give it to agentA and have them write a note: that is participation, and
    // participation is not an invitation anybody can withdraw.
    const assigned = await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
      version: await versionOf(),
      assigneeMembershipId: agentAMembershipId,
    });
    expect(assigned.statusCode).toBe(200);
    expect(
      (await send(api, agentA, 'POST', `/conversations/${conversationId}/notes`, { body: 'راجعت' }))
        .statusCode,
    ).toBe(201);

    // There is no API that removes a participant, and the runtime role cannot
    // do it directly either.
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query('DELETE FROM conversation_participants WHERE conversation_id = $1', [
          conversationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    // Removing a collaboration they never had changes nothing about them.
    const removed = await send(
      api,
      owner,
      'DELETE',
      `/conversations/${conversationId}/collaborators/${agentAMembershipId}?version=${String(await versionOf())}`,
    );
    expect(removed.statusCode).toBe(200);
    expect((await send(api, agentA, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(200);
  });

  it('refuses to invite somebody who could not work the conversation', async () => {
    const response = await send(api, owner, 'POST', `/conversations/${conversationId}/collaborators`, {
      version: await versionOf(),
      membershipId: agentBMembershipId,
    });
    // Adding somebody grants them access, so the target is checked exactly as
    // an assignment target is.
    expect(response.statusCode).toBe(422);
  });

  it('lists the collaborators through the API, not only the database', async () => {
    const added = await send(api, owner, 'POST', `/conversations/${conversationId}/collaborators`, {
      version: await versionOf(),
      membershipId: secondAgentAMembershipId,
    });
    expect(added.statusCode).toBe(200);

    const listed = await send(api, owner, 'GET', `/conversations/${conversationId}/collaborators`);
    expect(listed.statusCode, listed.payload).toBe(200);
    const rows = (listed.json() as { data: { membershipId: string; label: string }[] }).data;
    expect(rows.map((row) => row.membershipId)).toContain(secondAgentAMembershipId);
    expect(rows[0]?.label.length).toBeGreaterThan(0);
    // No login address in a list a Supervisor may read.
    expect(listed.payload).not.toContain('@realtime.test');

    await send(
      api,
      owner,
      'DELETE',
      `/conversations/${conversationId}/collaborators/${secondAgentAMembershipId}?version=${String(await versionOf())}`,
    );
  });

  it('refuses a collaborator change against a version somebody moved past', async () => {
    const response = await send(api, owner, 'POST', `/conversations/${conversationId}/collaborators`, {
      version: 1,
      membershipId: secondAgentAMembershipId,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'conversation_version_conflict',
    );
  });

  it('records a priority change with no reason given', async () => {
    const response = await send(api, supervisor, 'PATCH', `/conversations/${conversationId}/priority`, {
      version: await versionOf(),
      priority: 'low',
    });
    expect(response.statusCode, response.payload).toBe(200);
    const audit = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM conversation_audit
          WHERE conversation_id = $1 AND act = 'priority_changed' ORDER BY at DESC LIMIT 1`,
        [conversationId],
      ),
    );
    // An absent reason is absent, not an empty string somebody has to interpret.
    expect(audit.rows[0]?.detail).toEqual({});
  });

  it('refuses an Agent the collaborator list they cannot change', async () => {
    const response = await send(api, agentA, 'POST', `/conversations/${conversationId}/collaborators`, {
      version: await versionOf(),
      membershipId: secondAgentAMembershipId,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the ownership barrier', () => {
  const peer = '15557000760';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'سؤال', 'wamid.rt-760');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  async function reply(id: string): Promise<LightMyRequestResponse> {
    return send(api, owner, 'POST', `/conversations/${conversationId}/messages`, {
      messageType: 'text',
      text: 'أهلًا',
      trafficClass: 'interactive',
      clientMessageId: id,
    });
  }

  async function setOwnership(state: string): Promise<void> {
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query('UPDATE conversations SET owner_state = $2 WHERE id = $1', [
        conversationId,
        state,
      ]),
    );
  }

  it('lets a person reply while people own the conversation', async () => {
    expect((await reply('ownership-human-1')).statusCode).toBe(202);
  });

  it('stops a human send while a bot request may be with the provider', async () => {
    // No bot exists in this build, so the state is set directly: the point of
    // the test is that the ENFORCEMENT POINT reads the stored state, and it is
    // the send permit rather than the browser that refuses.
    await setOwnership('handoff_pending');
    const response = await reply('ownership-barrier-1');
    expect(response.statusCode).toBe(409);
    const error = (response.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('handoff_barrier_pending');
    // ADR-0008: never a claim that the automated message was cancelled.
    expect(error.message).not.toMatch(/cancel/i);

    const written = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM outbound_messages WHERE client_message_id = $1`,
        ['ownership-barrier-1'],
      ),
    );
    // Refused at the permit, so no command exists to be dispatched later.
    expect(written.rows[0]?.count).toBe('0');
  });

  it('lets a person take over from a bot rather than refusing them', async () => {
    await setOwnership('bot_active');
    // A human replying IS the takeover. Refusing it would make taking over
    // impossible without a separate button nobody presses in a hurry.
    expect((await reply('ownership-takeover-1')).statusCode).toBe(202);
    await setOwnership('human_active');
  });

  it('records the ownership each accepted command was permitted under', async () => {
    expect((await reply('ownership-recorded-1')).statusCode).toBe(202);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ permitted_owner_version: number | null }>(
        'SELECT permitted_owner_version FROM outbound_messages WHERE client_message_id = $1',
        ['ownership-recorded-1'],
      ),
    );
    // ADR-0008 requires a dispatch-time re-check for an AI result; this is what
    // it will compare against.
    expect(rows.rows[0]?.permitted_owner_version).toBeGreaterThan(0);
  });

  it('refuses to send into a conversation that is not there', async () => {
    const outbound = api.app.get(OutboundService);
    const connection = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string }>(
        'SELECT connection_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    const session = await api.app
      .get(AuthService)
      .authenticate(owner.cookie);
    await expect(
      outbound.queue(
        session,
        api.tenantId,
        connection.rows[0]?.connection_id as string,
        {
          peerIdentity: peer,
          messageType: 'text',
          text: 'إلى العدم',
          trafficClass: 'interactive',
          clientMessageId: 'ownership-missing-1',
        },
        {},
        // A conversation id that does not name one. The permit reads ownership
        // from the row, so there is nothing to read and nothing to permit.
        '00000000-0000-4000-8000-0000000000dd',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records nothing to compare for a send with no conversation at all', async () => {
    const connection = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ connection_id: string }>(
        'SELECT connection_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    const direct = await send(
      api,
      owner,
      'POST',
      `/channels/${connection.rows[0]?.connection_id as string}/messages`,
      {
        peerIdentity: peer,
        messageType: 'text',
        text: 'رسالة مباشرة',
        trafficClass: 'interactive',
        clientMessageId: 'ownership-direct-1',
      },
    );
    expect(direct.statusCode, direct.payload).toBe(202);
    const rows = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ permitted_owner_version: number | null }>(
        'SELECT permitted_owner_version FROM outbound_messages WHERE client_message_id = $1',
        ['ownership-direct-1'],
      ),
    );
    // Nothing owns it, so there is no ownership the permit was granted under —
    // recorded as absent rather than as a zero somebody would compare against.
    expect(rows.rows[0]?.permitted_owner_version).toBeNull();
  });
});

describe('when a routing write fails late', () => {
  const peer = '15557000740';
  let conversationId: string;

  beforeAll(async () => {
    await customerWrites(INBOX_A, peer, 'تجربة', 'wamid.rt-740');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM conversations WHERE peer_identity = $1', [
        peer,
      ]),
    );
    conversationId = row.rows[0]?.id as string;
  }, 120_000);

  it('rolls the assignment, the audit and the event back together', async () => {
    const before = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number; assignee_membership_id: string | null }>(
        'SELECT version, assignee_membership_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    const version = before.rows[0]?.version as number;

    // The event is written last, so a failure there is the interesting one: it
    // is the shape that would otherwise leave an assignment nobody can explain.
    const admin = scratchMigrationPool(api.names);
    try {
      await admin.query(
        "CREATE FUNCTION fail_routing_event() RETURNS trigger LANGUAGE plpgsql AS $$ " +
          "BEGIN IF NEW.type = 'conversation.assigned' THEN " +
          "RAISE EXCEPTION 'forced realtime failure'; END IF; RETURN NEW; END; $$",
      );
      await admin.query(
        'CREATE TRIGGER fail_routing_event BEFORE INSERT ON realtime_events ' +
          'FOR EACH ROW EXECUTE FUNCTION fail_routing_event()',
      );

      const response = await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
        version,
        assigneeMembershipId: agentAMembershipId,
      });
      expect(response.statusCode).toBe(500);
      // The internal reason never reaches the caller.
      expect(response.body).not.toContain('forced realtime failure');
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS fail_routing_event ON realtime_events');
      await admin.query('DROP FUNCTION IF EXISTS fail_routing_event()');
      await admin.end();
    }

    const after = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number; assignee_membership_id: string | null }>(
        'SELECT version, assignee_membership_id::text FROM conversations WHERE id = $1',
        [conversationId],
      ),
    );
    // Nothing moved: not the assignee, not the version.
    expect(after.rows[0]).toEqual(before.rows[0]);

    const audit = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM conversation_audit WHERE conversation_id = $1`,
        [conversationId],
      ),
    );
    // And no audit row claiming it did.
    expect(audit.rows[0]?.count).toBe('0');

    // The same call succeeds once the injected failure is gone, which proves the
    // rollback was the trigger and not a permission the test lacked.
    const retry = await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
      version,
      assigneeMembershipId: agentAMembershipId,
    });
    expect(retry.statusCode, retry.payload).toBe(200);
  });
});

describe('what a reassigned agent keeps, and what they lose', () => {
  const peer = '15557000750';
  let conversationId: string;
  let leaving: Browser;
  let leavingMembershipId: string;

  beforeAll(async () => {
    leavingMembershipId = await addMember(api, 'agent-moved@realtime.test', 'agent', [
      { type: 'inbox', id: inboxA },
    ]);
    leaving = await login(api, 'agent-moved@realtime.test', MEMBER_PASSWORD);
    await customerWrites(INBOX_A, peer, 'مساء الخير', 'wamid.rt-750');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [peer],
      ),
    );
    conversationId = row.rows[0]?.id as string;
    expect(
      (await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
        version: row.rows[0]?.version,
        assigneeMembershipId: leavingMembershipId,
      })).statusCode,
    ).toBe(200);
  }, 120_000);

  it('keeps read access to work they actually did, after being reassigned away', async () => {
    expect(
      (await send(api, leaving, 'POST', `/conversations/${conversationId}/messages`, {
        messageType: 'text',
        text: 'سأتحقق من الطلب',
        trafficClass: 'interactive',
        clientMessageId: 'reply-before-reassignment',
      })).statusCode,
    ).toBe(202);

    const record = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ version: number }>('SELECT version FROM conversations WHERE id = $1', [
        conversationId,
      ]),
    );
    expect(
      (await send(api, owner, 'POST', `/conversations/${conversationId}/assignments`, {
        version: record.rows[0]?.version,
        assigneeMembershipId: agentAMembershipId,
      })).statusCode,
    ).toBe(200);

    // Participation outlives assignment: they wrote to this customer, and a
    // build that hid what they said would make their own work unreviewable.
    expect((await send(api, leaving, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(200);
    const timeline = await send(api, leaving, 'GET', `/conversations/${conversationId}/messages`);
    expect(timeline.statusCode).toBe(200);
    expect(timeline.payload).toContain('سأتحقق من الطلب');
  });

  it('loses it the moment the inbox scope goes, without logging out', async () => {
    const before = await feed(leaving);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query('DELETE FROM membership_scopes WHERE membership_id = $1', [leavingMembershipId]),
    );

    // Same session, same cookie. business-rules.md §4.1: losing inbox access
    // overrides assignment and participation, immediately.
    expect((await send(api, leaving, 'GET', `/conversations/${conversationId}`)).statusCode).toBe(403);
    expect(
      (await send(api, leaving, 'GET', `/conversations/${conversationId}/messages`)).statusCode,
    ).toBe(403);

    await customerWrites(INBOX_A, peer, 'هل من جديد؟', 'wamid.rt-751');
    const after = await feed(leaving, before.cursor);
    // And the socket stops too, at the next poll rather than the next login.
    expect(after.events.filter((event) => event.scope.conversationId === conversationId)).toEqual([]);
  });

  it('never names a conversation to somebody with no reach at all', async () => {
    // agentB has neither assignment, participation nor scope here.
    const list = await send(api, agentB, 'GET', '/conversations?queue=all');
    expect(list.statusCode).toBe(200);
    expect(list.payload).not.toContain(conversationId);

    const queue = await send(api, agentB, 'GET', '/conversations/unassigned');
    expect(queue.payload).not.toContain(conversationId);
  });

  it('moves a card between the queue and a person’s list as assignment changes', async () => {
    const spare = '15557000752';
    await customerWrites(INBOX_A, spare, 'سؤال سريع', 'wamid.rt-752');
    const row = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string; version: number }>(
        'SELECT id::text, version FROM conversations WHERE peer_identity = $1',
        [spare],
      ),
    );
    const id = row.rows[0]?.id as string;

    // Unassigned: a projected card, and nothing an agent could reconstruct a
    // transcript from.
    const queue = await send(api, agentA, 'GET', '/conversations/unassigned');
    const card = (queue.json() as { data: { id: string }[] }).data.find((entry) => entry.id === id);
    expect(card).toBeDefined();
    expect(queue.payload).not.toContain(spare);

    expect(
      (await send(api, owner, 'POST', `/conversations/${id}/assignments`, {
        version: row.rows[0]?.version,
        assigneeMembershipId: agentAMembershipId,
      })).statusCode,
    ).toBe(200);

    // Off the queue, onto their list, as a record this time.
    const after = await send(api, agentA, 'GET', '/conversations/unassigned');
    expect((after.json() as { data: { id: string }[] }).data.map((e) => e.id)).not.toContain(id);
    const mine = await send(api, agentA, 'GET', '/conversations?queue=mine');
    expect((mine.json() as { data: { id: string }[] }).data.map((e) => e.id)).toContain(id);
  });
});

function decodeAuthority(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8').split('|')[3] as string;
}
