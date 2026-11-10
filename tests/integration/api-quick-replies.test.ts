import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import { clusterCredentials, createScratchDatabase, migrateScratch, scratchRuntimePool } from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'quickreply-bootstrap-token-value-001';
const PASSWORD = 'quick reply owner password';

interface Browser { readonly cookie: string; readonly csrf: string; }
interface Harness extends Browser { readonly app: NestFastifyApplication; readonly pool: Pool; readonly server: FastifyInstance; readonly tenantId: string; readonly teamId: string; readonly agent: Browser; }

async function setup(): Promise<Harness> {
  const names: DatabaseNames = await createScratchDatabase('convo_quick_replies');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 5);
  await applyInstallationConfig(asExecutor(pool), 'saas');
  const cluster = clusterCredentials();
  const app = await createApiApplication(parseApiConfig({
    CONVO_DEPLOYMENT_MODE: 'saas', CONVO_INSTALLATION_NAME: 'Quick Reply Test', CONVO_PUBLIC_BASE_URL: 'https://quick-replies.test',
    CONVO_PROCESS_ROLE: 'api', CONVO_AUTH_HASH_SECRET: 'quickreply-auth-hash-secret-value-01', CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'quickreply-idempotency-secret-val-01', CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host, CONVO_PG_PORT: String(cluster.port), CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole, CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  }), pool);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const boot = await server.inject({ method: 'POST', url: '/api/v1/instance/bootstrap', headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'quick-reply-bootstrap' }, payload: { companyName: 'Digital School', companySlug: `quick-${randomUUID().slice(0, 8)}`, ownerEmail: 'owner@quick-replies.test', ownerPassword: PASSWORD } });
  expect(boot.statusCode).toBe(201);
  const tenantId = (boot.json() as { data: { tenantId: string } }).data.tenantId;
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@quick-replies.test', password: PASSWORD } });
  const cookies = login.headers['set-cookie']; const lines = cookies === undefined ? [] : Array.isArray(cookies) ? cookies : [cookies];
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrf = cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith('convo_csrf='))?.slice(11) ?? '';
  const agentPassword = 'quick reply agent password';
  const seeded = await withTenant(pool, tenantId, async (sql) => {
    const teamId = (await sql.query<{ id: string }>(`INSERT INTO teams(tenant_id,name) VALUES($1,'Marketing') RETURNING id::text`, [tenantId])).rows[0]!.id;
    const userId = randomUUID();
    await sql.query(`INSERT INTO users(id,email,password_hash,status) VALUES($1,'agent@quick-replies.test',$2,'active')`, [userId, await argon2.hash(agentPassword)]);
    const membershipId = (await sql.query<{ id: string }>(`INSERT INTO memberships(tenant_id,user_id,role_id,status) SELECT $1,$2,id,'active' FROM roles WHERE key='agent' RETURNING id::text`, [tenantId, userId])).rows[0]!.id;
    await sql.query(`INSERT INTO membership_scopes(tenant_id,membership_id,scope_type,scope_id) VALUES($1,$2,'team',$3)`, [tenantId, membershipId, teamId]);
    return { teamId };
  });
  const agentLogin = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'agent@quick-replies.test', password: agentPassword } });
  const agentLines = Array.isArray(agentLogin.headers['set-cookie']) ? agentLogin.headers['set-cookie'] : [agentLogin.headers['set-cookie'] ?? ''];
  const agentCookie = agentLines.map((line) => line.split(';')[0]).join('; ');
  const agentCsrf = agentCookie.split(';').map((value) => value.trim()).find((value) => value.startsWith('convo_csrf='))?.slice(11) ?? '';
  return { app, pool, server, tenantId, cookie, csrf, teamId: seeded.teamId, agent: { cookie: agentCookie, csrf: agentCsrf } };
}

function send(api: Harness, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>, browser: Browser = api): Promise<LightMyRequestResponse> {
  return api.server.inject({ method, url: `/api/v1/tenants/${api.tenantId}${path}`, headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrf }, ...(payload === undefined ? {} : { payload }) });
}

describe('quick replies API', () => {
  let api: Harness;
  beforeAll(async () => { api = await setup(); }, 120_000);
  afterAll(async () => { if (api !== undefined) await api.app.close(); });

  it('creates, lists, updates and deletes text and location replies with version fencing', async () => {
    const created = await send(api, 'POST', '/quick-replies', { shortcut: '/Welcome', title: 'Welcome', body: 'أهلاً بيك في Digital School' });
    expect(created.statusCode, created.body).toBe(201);
    const reply = (created.json() as { data: { id: string; version: number; shortcut: string; kind: string; location: unknown; updatedAt: string } }).data;
    expect(reply).toMatchObject({ shortcut: 'welcome', kind: 'text', location: null });
    expect(Number.isNaN(Date.parse(reply.updatedAt))).toBe(false);
    expect((await send(api, 'POST', '/quick-replies', { shortcut: 'WELCOME', title: 'Again', body: 'x' })).statusCode).toBe(409);

    const place = await send(api, 'POST', '/quick-replies', {
      shortcut: 'فرع', title: 'Branch', kind: 'location', body: 'Open 10am–8pm',
      location: { name: 'Nasr City branch', address: '12 Abbas El Akkad', latitude: 30.0561, longitude: 31.3301 },
    });
    expect(place.statusCode, place.body).toBe(201);
    expect((place.json() as { data: { location: unknown } }).data.location).toEqual({ name: 'Nasr City branch', address: '12 Abbas El Akkad', latitude: 30.0561, longitude: 31.3301 });

    const listed = await send(api, 'GET', '/quick-replies', undefined, api.agent);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { data: readonly { shortcut: string }[] }).data.map((row) => row.shortcut).sort()).toEqual(['welcome', 'فرع'].sort());

    const updated = await send(api, 'PATCH', `/quick-replies/${reply.id}`, { version: reply.version, shortcut: 'hi', title: 'Hi', body: 'Hello!' });
    expect(updated.statusCode, updated.body).toBe(200);
    const next = (updated.json() as { data: { version: number } }).data.version;
    expect(next).toBe(reply.version + 1);
    expect((await send(api, 'PATCH', `/quick-replies/${reply.id}`, { version: reply.version, shortcut: 'hi', title: 'Stale', body: 'x' })).statusCode).toBe(409);
    expect((await send(api, 'PATCH', `/quick-replies/${reply.id}`, { version: next, shortcut: 'فرع', title: 'Clash', body: 'x' })).statusCode).toBe(409);
    expect((await send(api, 'PATCH', `/quick-replies/${randomUUID()}`, { version: 1, shortcut: 'ghost', title: 'Ghost', body: 'x' })).statusCode).toBe(404);

    expect((await send(api, 'DELETE', `/quick-replies/${reply.id}`, { version: reply.version })).statusCode).toBe(409);
    const removed = await send(api, 'DELETE', `/quick-replies/${reply.id}`, { version: next });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { data: unknown }).data).toEqual({ deleted: true });
    expect((await send(api, 'DELETE', `/quick-replies/${reply.id}`, { version: next })).statusCode).toBe(404);
  });

  it('validates input and CSRF, and keeps changes to catalogue managers', async () => {
    expect((await send(api, 'POST', '/quick-replies', { shortcut: 'two words', title: '', body: '' })).statusCode).toBe(400);
    expect((await send(api, 'POST', '/quick-replies', { shortcut: 'loc', title: 'L', kind: 'location', location: { name: 'X', latitude: 200, longitude: 0 } })).statusCode).toBe(400);
    expect((await send(api, 'PATCH', `/quick-replies/${randomUUID()}`, { shortcut: 'ok', title: 'Ok', body: 'ok' })).statusCode).toBe(400);
    expect((await send(api, 'DELETE', `/quick-replies/${randomUUID()}`, {})).statusCode).toBe(400);
    expect((await send(api, 'PATCH', '/quick-replies/not-a-uuid', { version: 1, shortcut: 'ok', title: 'Ok', body: 'ok' })).statusCode).toBe(404);
    const noCsrf = await api.server.inject({ method: 'POST', url: `/api/v1/tenants/${api.tenantId}/quick-replies`, headers: { cookie: api.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    expect((await send(api, 'POST', '/quick-replies', { shortcut: 'mine', title: 'Mine', body: 'x' }, api.agent)).statusCode).toBe(403);
    const unauthenticated = await api.server.inject({ method: 'GET', url: `/api/v1/tenants/${api.tenantId}/quick-replies` });
    expect(unauthenticated.statusCode).toBe(401);
    const stored = await withTenant(api.pool, api.tenantId, async (sql) => (await sql.query<{ count: string }>('SELECT count(*)::text AS count FROM quick_replies')).rows[0]!.count);
    expect(stored).toBe('1');
  });
});
