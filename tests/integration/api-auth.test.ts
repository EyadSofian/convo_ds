import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig, type ApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig, PERMISSION_KEYS } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'auth-bootstrap-token-value-000000000001';
const OWNER_PASSWORD = 'owner password for auth tests';
const AGENT_PASSWORD = 'agent password for auth tests';

interface AuthHarness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly config: ApiConfig;
  readonly names: DatabaseNames;
  readonly tenantId: string;
}

interface BrowserSession {
  readonly cookie: string;
  readonly csrf: string;
  readonly sessionId: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Auth Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'auth-integration-hash-secret-value-00001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'auth-idempotency-secret-value-0000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(): Promise<AuthHarness> {
  const names = await createScratchDatabase('convo_auth');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 8);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: {
      'x-bootstrap-token': BOOTSTRAP_TOKEN,
      'idempotency-key': 'auth-bootstrap',
    },
    payload: {
      companyName: 'Auth Company',
      companySlug: 'auth-company',
      ownerEmail: 'owner@auth.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;
  return { app, pool, server, config, names, tenantId };
}

async function login(
  server: FastifyInstance,
  email: string,
  password: string,
  requestId: string,
): Promise<{ response: LightMyRequestResponse; browser?: BrowserSession }> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId, 'user-agent': 'CONVO integration browser' },
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    return { response };
  }
  const cookieLines = asArray(response.headers['set-cookie']);
  const cookie = cookieLines.map((line) => line.split(';')[0]).join('; ');
  const csrf = cookieValue(cookie, 'convo_csrf');
  const sessionId = (response.json() as { data: { session: { id: string } } }).data.session.id;
  return { response, browser: { cookie, csrf, sessionId } };
}

function asArray(value: string | string[] | undefined): readonly string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cookieValue(cookie: string, name: string): string {
  const match = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + '='));
  return match?.slice(name.length + 1) ?? '';
}

describe('local authentication and permission boundary', () => {
  let api: AuthHarness;
  let owner: BrowserSession;

  beforeAll(async () => {
    api = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('rejects malformed login input before credential work', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': 'login-invalid' },
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_input', request_id: 'login-invalid' },
    });
    const anonymous = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('uses the same response for unknown users and wrong passwords', async () => {
    const unknown = await login(api.server, 'unknown@auth.test', 'wrong password', 'unknown');
    const wrong = await login(api.server, 'owner@auth.test', 'wrong password', 'wrong');
    expect(unknown.response.statusCode).toBe(401);
    expect(wrong.response.statusCode).toBe(401);
    expect(unknown.response.json()).toMatchObject({ error: { code: 'credentials_invalid' } });
    expect(wrong.response.json()).toMatchObject({ error: { code: 'credentials_invalid' } });
    expect((unknown.response.json() as { error: { message: string } }).error.message).toBe(
      (wrong.response.json() as { error: { message: string } }).error.message,
    );
  });

  it('creates only hashed durable credentials and hardened cookies', async () => {
    const result = await login(api.server, 'OWNER@AUTH.TEST', OWNER_PASSWORD, 'login-owner');
    expect(result.response.statusCode).toBe(200);
    owner = result.browser as BrowserSession;
    const cookieLines = asArray(result.response.headers['set-cookie']);
    expect(cookieLines).toHaveLength(2);
    expect(cookieLines[0]).toContain('HttpOnly');
    expect(cookieLines[0]).toContain('SameSite=Strict');
    expect(cookieLines[0]).toContain('Secure');
    expect(cookieLines[1]).not.toContain('HttpOnly');

    const stored = await api.pool.query<{
      verifier_hash: string;
      csrf_hash: string;
      ip_hash: string;
      user_agent_hash: string;
    }>('SELECT verifier_hash, csrf_hash, ip_hash, user_agent_hash FROM user_sessions');
    expect(stored.rows[0]).toMatchObject({
      verifier_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      csrf_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      user_agent_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(cookieValue(owner.cookie, 'convo_session'));
    expect(JSON.stringify(stored.rows[0])).not.toContain(owner.csrf);
  });

  it('serves current session, inventory and same-owner detail only', async () => {
    const current = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: owner.cookie, 'x-request-id': 'current-session' },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      data: {
        user: { email: 'owner@auth.test' },
        session: { id: owner.sessionId },
      },
      request_id: 'current-session',
    });

    const list = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ data: [{ id: owner.sessionId, current: true }] });

    const detail = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions/' + owner.sessionId,
      headers: { cookie: owner.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ data: { id: owner.sessionId, current: true } });

    const missing = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions/not-a-uuid',
      headers: { cookie: owner.cookie },
    });
    expect(missing.statusCode).toBe(404);

    const absentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const absent = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions/' + absentId,
      headers: { cookie: owner.cookie },
    });
    const malformedRevoke = await api.server.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/not-a-uuid',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    const absentRevoke = await api.server.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/' + absentId,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(absent.statusCode).toBe(404);
    expect(malformedRevoke.statusCode).toBe(404);
    expect(absentRevoke.statusCode).toBe(404);
  });

  it('requires the matching cookie and header CSRF value for mutations', async () => {
    const missing = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: owner.cookie },
    });
    const wrong = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: owner.cookie, 'x-csrf-token': 'x'.repeat(43) },
    });
    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ error: { code: 'csrf_invalid' } });
  });

  it('lists active memberships and enforces role.manage by permission key', async () => {
    const memberships = await api.server.inject({
      method: 'GET',
      url: '/api/v1/me/memberships',
      headers: { cookie: owner.cookie },
    });
    expect(memberships.statusCode).toBe(200);
    expect(memberships.json()).toMatchObject({
      data: [
        {
          tenant: { id: api.tenantId, name: 'Auth Company', slug: 'auth-company' },
          role: { key: 'owner' },
          permissions: expect.arrayContaining([
            'conversation.assign',
            'conversation.handoff.request',
          ]),
        },
      ],
    });

    const permissions = await api.server.inject({
      method: 'GET',
      url: '/api/v1/tenants/' + api.tenantId + '/permissions',
      headers: { cookie: owner.cookie },
    });
    expect(permissions.statusCode).toBe(200);
    expect((permissions.json() as { data: unknown[] }).data).toHaveLength(PERMISSION_KEYS.length);
  });

  it('denies another role and hides nonexistent tenant membership', async () => {
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const roleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const membershipId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const passwordHash = await argon2.hash(AGENT_PASSWORD, { type: argon2.argon2id });
    await api.pool.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, 'agent@auth.test', $2, 'active')",
      [agentId, passwordHash],
    );
    await withTenant(api.pool, api.tenantId, async (client) => {
      // Use the Agent role the tenant was seeded with (migration 0007), not a
      // hand-made empty one: the point of the test is that the *real* matrix
      // denies this, and an ad-hoc role with no grants would pass trivially.
      const seeded = await client.query<{ id: string }>(
        "SELECT id::text FROM roles WHERE key = 'agent'",
      );
      expect(seeded.rows).toHaveLength(1);
      const agentRoleId = seeded.rows[0]?.id ?? roleId;
      await client.query(
        'INSERT INTO memberships (id, tenant_id, user_id, role_id) VALUES ($1, $2, $3, $4)',
        [membershipId, api.tenantId, agentId, agentRoleId],
      );
      await client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, 'tenant', NULL)`,
        [api.tenantId, membershipId],
      );
    });
    const loggedIn = await login(api.server, 'agent@auth.test', AGENT_PASSWORD, 'agent-login');
    const agent = loggedIn.browser as BrowserSession;

    const denied = await api.server.inject({
      method: 'GET',
      url: '/api/v1/tenants/' + api.tenantId + '/permissions',
      headers: { cookie: agent.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'permission_denied' } });

    // The whole administration surface is gated by key, not by one route
    // remembering to check. An Agent holds neither `role.manage` nor
    // `member.manage`, so all four refuse identically.
    for (const path of ['roles', 'people', 'teams']) {
      const refused = await api.server.inject({
        method: 'GET',
        url: `/api/v1/tenants/${api.tenantId}/${path}`,
        headers: { cookie: agent.cookie },
      });
      expect(refused.statusCode, path).toBe(403);
      expect(refused.json()).toMatchObject({ error: { code: 'permission_denied' } });
    }

    const hidden = await api.server.inject({
      method: 'GET',
      url: '/api/v1/tenants/99999999-9999-4999-8999-999999999999/permissions',
      headers: { cookie: agent.cookie },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: 'resource_not_found' } });

    const malformedTenant = await api.server.inject({
      method: 'GET',
      url: '/api/v1/tenants/not-a-uuid/permissions',
      headers: { cookie: agent.cookie },
    });
    expect(malformedTenant.statusCode).toBe(404);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query("UPDATE memberships SET status = 'suspended' WHERE id = $1", [membershipId]),
    );
    const activeOnly = await api.server.inject({
      method: 'GET',
      url: '/api/v1/me/memberships',
      headers: { cookie: agent.cookie },
    });
    expect(activeOnly.statusCode).toBe(200);
    expect(activeOnly.json()).toMatchObject({ data: [] });
  });

  it('revokes another session immediately and persists sessions across API restart', async () => {
    const secondLogin = await login(api.server, 'owner@auth.test', OWNER_PASSWORD, 'second-login');
    const second = secondLogin.browser as BrowserSession;
    const revoke = await api.server.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/' + second.sessionId,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(revoke.statusCode).toBe(204);
    expect(revoke.headers['set-cookie']).toBeUndefined();

    const revoked = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: second.cookie },
    });
    expect(revoked.statusCode).toBe(401);

    await api.app.close();
    api.pool = scratchRuntimePool(api.names, 8);
    api.app = await createApiApplication(api.config, api.pool);
    api.server = api.app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    const survived = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: owner.cookie },
    });
    expect(survived.statusCode).toBe(200);
  });

  it('accepts a client without a user-agent and clears cookies when it revokes itself', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@auth.test', password: OWNER_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = asArray(response.headers['set-cookie'])
      .map((line) => line.split(';')[0])
      .join('; ');
    const csrf = cookieValue(cookie, 'convo_csrf');
    const sessionId = (response.json() as { data: { session: { id: string } } }).data.session.id;
    const revoke = await api.server.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/' + sessionId,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(revoke.statusCode).toBe(204);
    expect(asArray(revoke.headers['set-cookie'])).toHaveLength(2);
  });

  it('clears cookies on logout and rejects the next request', async () => {
    const logout = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(logout.statusCode).toBe(204);
    expect(asArray(logout.headers['set-cookie'])).toHaveLength(2);
    expect(asArray(logout.headers['set-cookie'])[0]).toContain('Max-Age=0');
    const after = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: owner.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('returns 429 with Retry-After after the shared database threshold', async () => {
    let response: LightMyRequestResponse | undefined;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      response = await api.server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '203.0.113.90',
        payload: { email: 'limited@auth.test', password: 'wrong password' },
      });
    }
    expect(response?.statusCode).toBe(429);
    expect(response?.headers['retry-after']).toMatch(/^\d+$/);
    expect(response?.json()).toMatchObject({ error: { code: 'login_rate_limited' } });
  });
});
