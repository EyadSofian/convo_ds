import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../packages/domain/src/ports/sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import type { InvitationMessage } from '../../apps/api/src/people/invitation-delivery.js';
import { LoggingInvitationDelivery } from '../../apps/api/src/people/invitation-delivery.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The executor a logging adapter is handed.
 *
 * It rejects every query, which is the assertion: the adapter that is
 * supposed to send nothing must also write nothing.
 */
const NO_SQL: SqlExecutor = {
  query: () => Promise.reject(new Error("the logging adapter must not touch the database")),
};

/**
 * Invitations against a real PostgreSQL (IAM-06).
 *
 * The interesting properties here are negative: a token never appears in a
 * response, a delegation ceiling cannot be stepped over, an accept cannot
 * happen twice, and every failure mode answers identically.
 */

const BOOTSTRAP_TOKEN = 'invite-bootstrap-token-value-0000000001';
const OWNER_PASSWORD = 'owner password for invitation tests';
const MEMBER_PASSWORD = 'member password for invitation tests';
const NEW_PASSWORD = 'a brand new member password, long enough';

class CapturingDelivery {
  readonly sent: InvitationMessage[] = [];

  async deliver(_sql: SqlExecutor, message: InvitationMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  last(): InvitationMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error('nothing was delivered');
    return message;
  }
}

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly delivery: CapturingDelivery;
  readonly tenantId: string;
}

interface Browser {
  readonly cookie: string;
  readonly csrf: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Invite Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'invite-integration-hash-secret-000001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'invite-idempotency-secret-00000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(): Promise<Harness> {
  const names = await createScratchDatabase('convo_invite');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const delivery = new CapturingDelivery();
  const app = await createApiApplication(config, pool, { invitationDelivery: delivery });
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'invite-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@invite.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;
  return { app, pool, server, delivery, tenantId };
}

async function login(api: Harness, email: string, password: string): Promise<Browser> {
  const response = await api.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': 'CONVO invitation test' },
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

async function roleId(api: Harness, key: string): Promise<string> {
  return withTenant(api.pool, api.tenantId, async (client) => {
    const row = await client.query<{ id: string }>('SELECT id::text FROM roles WHERE key = $1', [key]);
    return row.rows[0]?.id as string;
  });
}

let keySeq = 0;
async function invite(
  api: Harness,
  browser: Browser,
  body: Record<string, unknown>,
  key = `invite-${String((keySeq += 1))}`,
) {
  return api.server.inject({
    method: 'POST',
    url: `/api/v1/tenants/${api.tenantId}/invitations`,
    headers: {
      cookie: browser.cookie,
      'x-csrf-token': browser.csrf,
      'idempotency-key': key,
    },
    payload: body,
  });
}

describe('creating an invitation', () => {
  let api: Harness;
  let owner: Browser;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@invite.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('creates one, and never puts the token in the response or the database', async () => {
    const agent = await roleId(api, 'agent');
    const response = await invite(api, owner, { email: 'Tarek@Invite.Test', roleId: agent });
    expect(response.statusCode).toBe(201);

    const body = response.json() as { data: { id: string; email: string; status: string } };
    expect(body.data.email).toBe('tarek@invite.test'); // normalised
    expect(body.data.status).toBe('pending');

    const token = api.delivery.last().token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The credential is not in the answer the inviter reads...
    expect(response.body).not.toContain(token);

    // ...and only its fingerprint is stored.
    const stored = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ token_hash: string }>('SELECT token_hash FROM invitations'),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toContain(token);
  });

  it('lists invitations without their tokens', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const listed = (response.json() as { data: readonly { email: string }[] }).data;
    expect(listed.length).toBeGreaterThan(0);
    for (const message of api.delivery.sent) {
      expect(response.body).not.toContain(message.token);
    }
  });

  it('supersedes a live invitation rather than leaving two ways in', async () => {
    const agent = await roleId(api, 'agent');
    const first = await invite(api, owner, { email: 'dup@invite.test', roleId: agent });
    expect(first.statusCode).toBe(201);
    const firstToken = api.delivery.last().token;

    const second = await invite(api, owner, { email: 'dup@invite.test', roleId: agent });
    expect(second.statusCode).toBe(201);
    const secondToken = api.delivery.last().token;
    expect(secondToken).not.toBe(firstToken);

    // The superseded one is revoked, so the older link is dead.
    const dead = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${firstToken}/accept`,
      payload: { password: NEW_PASSWORD },
    });
    expect(dead.statusCode).toBe(400);
  });

  it('replays a retried create instead of minting a second token', async () => {
    const agent = await roleId(api, 'agent');
    const key = 'invite-retry-key';
    const first = await invite(api, owner, { email: 'retry@invite.test', roleId: agent }, key);
    expect(first.statusCode).toBe(201);
    const deliveredAfterFirst = api.delivery.sent.length;

    const replay = await invite(api, owner, { email: 'retry@invite.test', roleId: agent }, key);
    expect(replay.statusCode).toBe(201);
    // `request_id` is per request by design, so the replay is compared on the
    // payload: the same invitation, not a second one.
    expect((replay.json() as { data: unknown }).data).toEqual((first.json() as { data: unknown }).data);
    // No second credential was minted or delivered.
    expect(api.delivery.sent).toHaveLength(deliveredAfterFirst);
  });

  it('refuses the same key with a different body', async () => {
    const agent = await roleId(api, 'agent');
    const key = 'invite-conflict-key';
    expect((await invite(api, owner, { email: 'a@invite.test', roleId: agent }, key)).statusCode).toBe(
      201,
    );
    const conflict = await invite(api, owner, { email: 'b@invite.test', roleId: agent }, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('requires CSRF and an idempotency key', async () => {
    const agent = await roleId(api, 'agent');
    const noCsrf = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie, 'idempotency-key': 'no-csrf-key' },
      payload: { email: 'nocsrf@invite.test', roleId: agent },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_invalid' } });

    const noKey = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: { email: 'nokey@invite.test', roleId: agent },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
  });

  it('rejects a malformed body before doing anything', async () => {
    const bad = await invite(api, owner, { email: 'not-an-email', roleId: 'not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    const details = (bad.json() as { error: { details: readonly { field: string }[] } }).error.details;
    expect(details.map((detail) => detail.field).sort()).toEqual(['email', 'roleId']);

    const agent = await roleId(api, 'agent');
    const badScope = await invite(api, owner, {
      email: 'scope@invite.test',
      roleId: agent,
      scopes: [{ type: 'inbox', id: null }],
    });
    expect(badScope.statusCode).toBe(400);

    const notAnObject = await api.server.inject({
      method: 'POST',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
        'idempotency-key': 'not-an-object-key',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(['nope']),
    });
    expect(notAnObject.statusCode).toBe(400);
  });

  it('refuses an unknown role and an already-present member', async () => {
    const unknownRole = await invite(api, owner, {
      email: 'unknown-role@invite.test',
      roleId: '99999999-9999-4999-8999-999999999999',
    });
    expect(unknownRole.statusCode).toBe(404);

    const agent = await roleId(api, 'agent');
    const alreadyIn = await invite(api, owner, { email: 'owner@invite.test', roleId: agent });
    expect(alreadyIn.statusCode).toBe(409);
    expect(alreadyIn.json()).toMatchObject({ error: { code: 'already_a_member' } });
  });

  it('requires member.manage', async () => {
    // Give an Agent a session, then try to invite with it.
    const agentRole = await roleId(api, 'agent');
    const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
    const user = await api.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, status) VALUES ('plain@invite.test', $1, 'active')
       RETURNING id::text`,
      [hash],
    );
    await withTenant(api.pool, api.tenantId, async (client) => {
      const membership = await client.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active') RETURNING id::text`,
        [api.tenantId, user.rows[0]?.id, agentRole],
      );
      await client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, 'tenant', NULL)`,
        [api.tenantId, membership.rows[0]?.id],
      );
    });
    const agent = await login(api, 'plain@invite.test', MEMBER_PASSWORD);
    const refused = await invite(api, agent, { email: 'nope@invite.test', roleId: agentRole });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'permission_denied' } });
  });
});

describe('the delegation ceiling on invitations', () => {
  let api: Harness;
  let adminBrowser: Browser;

  beforeAll(async () => {
    api = await createHarness();
    const owner = await login(api, 'owner@invite.test', OWNER_PASSWORD);
    const admin = await roleId(api, 'admin');
    const created = await invite(api, owner, { email: 'admin@invite.test', roleId: admin });
    expect(created.statusCode).toBe(201);
    const token = api.delivery.last().token;
    const accepted = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      payload: { password: MEMBER_PASSWORD },
    });
    expect(accepted.statusCode).toBe(201);
    // The accepted membership needs a tenant scope to grant scopes onward.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         SELECT $1, m.id, 'tenant', NULL FROM memberships m
           JOIN users u ON u.id = m.user_id WHERE u.email = 'admin@invite.test'`,
        [api.tenantId],
      ),
    );
    adminBrowser = await login(api, 'admin@invite.test', MEMBER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  /**
   * The rule that matters: an Admin holds everything except `tenant.delete`,
   * so the Owner role is out of reach — and no code anywhere names "Owner" to
   * make that true.
   */
  it('stops an Admin inviting an Owner', async () => {
    const ownerRole = await roleId(api, 'owner');
    const refused = await invite(api, adminBrowser, {
      email: 'escalate@invite.test',
      roleId: ownerRole,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: {
        code: 'delegation_ceiling',
        details: [{ field: 'tenant.delete', code: 'not_held' }],
      },
    });
  });

  it('lets an Admin invite every other built-in role', async () => {
    for (const key of ['admin', 'supervisor', 'agent', 'campaign_manager', 'analyst']) {
      const response = await invite(api, adminBrowser, {
        email: `${key}-invitee@invite.test`,
        roleId: await roleId(api, key),
      });
      expect(response.statusCode, key).toBe(201);
    }
  });

  it('stops a scoped inviter granting a scope they do not hold', async () => {
    // Narrow the Admin to a single inbox, then try to grant a different one.
    const inboxA = '11111111-1111-4111-8111-111111111111';
    const inboxB = '22222222-2222-4222-8222-222222222222';
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE membership_scopes SET scope_type = 'inbox', scope_id = $1
           WHERE membership_id = (
             SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE u.email = 'admin@invite.test')`,
        [inboxA],
      ),
    );

    const agent = await roleId(api, 'agent');
    const refused = await invite(api, adminBrowser, {
      email: 'wider-scope@invite.test',
      roleId: agent,
      scopes: [{ type: 'inbox', id: inboxB }],
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'delegation_ceiling' } });

    const allowed = await invite(api, adminBrowser, {
      email: 'same-scope@invite.test',
      roleId: agent,
      scopes: [{ type: 'inbox', id: inboxA }],
    });
    expect(allowed.statusCode).toBe(201);
  });
});

describe('accepting an invitation', () => {
  let api: Harness;
  let owner: Browser;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@invite.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('creates exactly one membership with exactly the invited role and scopes', async () => {
    const supervisor = await roleId(api, 'supervisor');
    const inbox = '33333333-3333-4333-8333-333333333333';
    const created = await invite(api, owner, {
      email: 'joiner@invite.test',
      roleId: supervisor,
      scopes: [{ type: 'inbox', id: inbox }],
    });
    expect(created.statusCode).toBe(201);
    const token = api.delivery.last().token;

    const accepted = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      remoteAddress: '203.0.113.51',
      payload: { password: NEW_PASSWORD },
    });
    expect(accepted.statusCode).toBe(201);
    const body = accepted.json() as { data: { tenant_id: string; membership_id: string } };
    expect(body.data.tenant_id).toBe(api.tenantId);

    const state = await withTenant(api.pool, api.tenantId, async (client) => {
      const membership = await client.query<{ count: string; role_key: string; status: string }>(
        `SELECT count(*) OVER ()::text AS count, r.key AS role_key, m.status
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
          WHERE u.email = 'joiner@invite.test'`,
      );
      const scopes = await client.query<{ scope_type: string; scope_id: string | null }>(
        `SELECT scope_type, scope_id::text AS scope_id FROM membership_scopes
          WHERE membership_id = $1`,
        [body.data.membership_id],
      );
      return { membership: membership.rows, scopes: scopes.rows };
    });
    // Exactly one membership, at exactly the invited role.
    expect(state.membership).toHaveLength(1);
    expect(state.membership[0]?.role_key).toBe('supervisor');
    expect(state.membership[0]?.status).toBe('active');
    // Exactly the invited scopes, taken from the invitation rather than the
    // request, so nothing could widen between the invite and the click.
    expect(state.scopes).toEqual([{ scope_type: 'inbox', scope_id: inbox }]);

    // And the new member can actually sign in.
    const session = await login(api, 'joiner@invite.test', NEW_PASSWORD);
    expect(session.cookie).toContain('convo_session=');
  });

  it('is single use', async () => {
    const agent = await roleId(api, 'agent');
    expect((await invite(api, owner, { email: 'once@invite.test', roleId: agent })).statusCode).toBe(
      201,
    );
    const token = api.delivery.last().token;

    const first = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      remoteAddress: '203.0.113.52',
      payload: { password: NEW_PASSWORD },
    });
    expect(first.statusCode).toBe(201);

    const second = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      remoteAddress: '203.0.113.53',
      payload: { password: NEW_PASSWORD },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({
      error: { details: [{ code: 'invalid_or_expired' }] },
    });
  });

  it('answers identically for unknown, expired, revoked and wrong-password', async () => {
    const agent = await roleId(api, 'agent');

    // Unknown.
    const unknown = await api.server.inject({
      method: 'POST',
      url: '/api/v1/invitations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/accept',
      remoteAddress: '203.0.113.61',
      payload: { password: NEW_PASSWORD },
    });

    // Expired.
    expect(
      (await invite(api, owner, { email: 'expired@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const expiredToken = api.delivery.last().token;
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE invitations SET created_at = now() - interval '30 days',
                                expires_at = now() - interval '1 minute'
          WHERE status = 'pending' AND email = 'expired@invite.test'`,
      ),
    );
    const expired = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${expiredToken}/accept`,
      remoteAddress: '203.0.113.62',
      payload: { password: NEW_PASSWORD },
    });

    // Revoked.
    expect(
      (await invite(api, owner, { email: 'revoked@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const revokedToken = api.delivery.last().token;
    const listed = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    const target = (listed.json() as { data: readonly { id: string; email: string }[] }).data.find(
      (row) => row.email === 'revoked@invite.test',
    );
    const revokeResponse = await api.server.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${api.tenantId}/invitations/${target?.id ?? ''}`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(revokeResponse.statusCode).toBe(204);
    const revoked = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${revokedToken}/accept`,
      remoteAddress: '203.0.113.63',
      payload: { password: NEW_PASSWORD },
    });

    // Wrong password for an address that already has an account.
    expect(
      (await invite(api, owner, { email: 'joiner2@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const liveToken = api.delivery.last().token;
    await api.pool.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ('joiner2@invite.test', $1, 'active')`,
      [await argon2.hash('the real password for joiner2', { type: argon2.argon2id })],
    );
    const wrongPassword = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${liveToken}/accept`,
      remoteAddress: '203.0.113.64',
      payload: { password: 'definitely not the right password' },
    });

    // All four are the same answer. Any difference tells a stranger holding a
    // link something about the person it was sent to.
    for (const response of [unknown, expired, revoked, wrongPassword]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { details: [{ code: 'invalid_or_expired' }] },
      });
    }
    // Byte for byte once the per-request id is removed: nothing else varies.
    const shape = (body: string): string => body.replace(/"request_id":"[^"]+"/, '"request_id":"*"');
    expect(shape(expired.body)).toBe(shape(unknown.body));
    expect(shape(revoked.body)).toBe(shape(unknown.body));
    expect(shape(wrongPassword.body)).toBe(shape(unknown.body));

    // The wrong password did not burn the invitation: it is still pending.
    const still = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM invitations WHERE email = 'joiner2@invite.test'",
      ),
    );
    expect(still.rows[0]?.status).toBe('pending');
  });

  it('attaches an established identity when the password proves it', async () => {
    // 'joiner2' already has an account from the previous test.
    const listed = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        "SELECT id::text FROM invitations WHERE email = 'joiner2@invite.test' AND status = 'pending'",
      ),
    );
    expect(listed.rows).toHaveLength(1);

    // Re-issue so we hold a fresh token for it.
    const agent = await roleId(api, 'agent');
    expect(
      (await invite(api, owner, { email: 'joiner2@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const token = api.delivery.last().token;

    const accepted = await api.server.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      remoteAddress: '203.0.113.70',
      payload: { password: 'the real password for joiner2' },
    });
    expect(accepted.statusCode).toBe(201);

    // One identity, not a duplicate.
    const users = await api.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE email = 'joiner2@invite.test'",
    );
    expect(users.rows[0]?.count).toBe('1');
  });

  it('refuses to admit anyone into a company that is not active', async () => {
    const agent = await roleId(api, 'agent');
    expect(
      (await invite(api, owner, { email: 'suspended@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const token = api.delivery.last().token;

    // RLS applies to this UPDATE too, so it has to run inside the tenant's own
    // context — a pool query with no context matches no rows at all.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query("UPDATE tenants SET status = 'suspended'"),
    );
    try {
      const refused = await api.server.inject({
        method: 'POST',
        url: `/api/v1/invitations/${token}/accept`,
        remoteAddress: '203.0.113.80',
        payload: { password: NEW_PASSWORD },
      });
      // A link issued while the company was healthy must not still let someone
      // in after it was suspended.
      expect(refused.statusCode).toBe(400);
    } finally {
      await withTenant(api.pool, api.tenantId, (client) =>
        client.query("UPDATE tenants SET status = 'active'"),
      );
    }
  });

  it('reports a revoked invitation with its revocation time', async () => {
    const agent = await roleId(api, 'agent');
    expect(
      (await invite(api, owner, { email: 'to-revoke@invite.test', roleId: agent })).statusCode,
    ).toBe(201);
    const before = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    const target = (
      before.json() as { data: readonly { id: string; email: string; revoked_at: string | null }[] }
    ).data.find((row) => row.email === 'to-revoke@invite.test');
    expect(target?.revoked_at).toBeNull();

    expect(
      (
        await api.server.inject({
          method: 'DELETE',
          url: `/api/v1/tenants/${api.tenantId}/invitations/${target?.id ?? ''}`,
          headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        })
      ).statusCode,
    ).toBe(204);

    const after = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    const revoked = (
      after.json() as {
        data: readonly { email: string; status: string; revoked_at: string | null }[];
      }
    ).data.find((row) => row.email === 'to-revoke@invite.test');
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revoked_at).not.toBeNull();
  });

  it('rejects a malformed token and a short password', async () => {
    const shortToken = await api.server.inject({
      method: 'POST',
      url: '/api/v1/invitations/too-short/accept',
      payload: { password: NEW_PASSWORD },
    });
    expect(shortToken.statusCode).toBe(400);

    const shortPassword = await api.server.inject({
      method: 'POST',
      url: '/api/v1/invitations/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/accept',
      payload: { password: 'short' },
    });
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json()).toMatchObject({
      error: { details: [{ field: 'password', code: 'too_short' }] },
    });

    const longPassword = await api.server.inject({
      method: 'POST',
      url: '/api/v1/invitations/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/accept',
      payload: { password: 'x'.repeat(513) },
    });
    expect(longPassword.statusCode).toBe(400);

    const notAnObject = await api.server.inject({
      method: 'POST',
      url: '/api/v1/invitations/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/accept',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(['nope']),
    });
    expect(notAnObject.statusCode).toBe(400);
  });

  it('rate limits repeated accept attempts from one address', async () => {
    let sawLimit = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await api.server.inject({
        method: 'POST',
        url: '/api/v1/invitations/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC/accept',
        remoteAddress: '198.51.100.77',
        payload: { password: NEW_PASSWORD },
      });
      if (response.statusCode === 429) {
        sawLimit = true;
        expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } });
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it('refuses to revoke an invitation that is not pending', async () => {
    const gone = await api.server.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${api.tenantId}/invitations/99999999-9999-4999-8999-999999999999`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(gone.statusCode).toBe(404);

    const noCsrf = await api.server.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${api.tenantId}/invitations/99999999-9999-4999-8999-999999999999`,
      headers: { cookie: owner.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('requires a session for the tenant-scoped invitation routes', async () => {
    const list = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/invitations`,
    });
    expect(list.statusCode).toBe(401);
  });
});

describe('the default invitation delivery adapter', () => {
  it('logs a redacted address without the token, and never throws', async () => {
    const lines: string[] = [];
    const delivery = new LoggingInvitationDelivery((line) => lines.push(line));
    const token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    await delivery.deliver(NO_SQL, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      invitationId: '00000000-0000-4000-8000-000000000002',
      email: 'tarek@digital-school.example',
      token,
      tenantName: 'Digital School',
      roleName: 'Agent',
      expiresAt: new Date('2026-09-16T12:00:00.000Z'),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('t***@digital-school.example');
    expect(lines[0]).toContain('Agent');
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).toContain('no delivery adapter is configured');
  });
});
