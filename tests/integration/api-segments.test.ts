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

const BOOTSTRAP_TOKEN = 'segment-bootstrap-token-value-0000001';
const PASSWORD = 'segment owner password';
const conditions = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'channel', operator: 'eq', value: 'whatsapp' }] } };

interface Browser { readonly cookie: string; readonly csrf: string; }
interface Harness extends Browser { readonly app: NestFastifyApplication; readonly pool: Pool; readonly server: FastifyInstance; readonly tenantId: string; readonly teamId: string; readonly agent: Browser; }

async function setup(): Promise<Harness> {
  const names: DatabaseNames = await createScratchDatabase('convo_segments');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 5);
  await applyInstallationConfig(asExecutor(pool), 'saas');
  const cluster = clusterCredentials();
  const app = await createApiApplication(parseApiConfig({
    CONVO_DEPLOYMENT_MODE: 'saas', CONVO_INSTALLATION_NAME: 'Segment Test', CONVO_PUBLIC_BASE_URL: 'https://segments.test',
    CONVO_PROCESS_ROLE: 'api', CONVO_AUTH_HASH_SECRET: 'segment-auth-hash-secret-value-00001', CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'segment-idempotency-secret-value-001', CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host, CONVO_PG_PORT: String(cluster.port), CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole, CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  }), pool);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const boot = await server.inject({ method: 'POST', url: '/api/v1/instance/bootstrap', headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'segment-bootstrap' }, payload: { companyName: 'Digital School', companySlug: `segments-${randomUUID().slice(0, 8)}`, ownerEmail: 'owner@segments.test', ownerPassword: PASSWORD } });
  expect(boot.statusCode).toBe(201);
  const tenantId = (boot.json() as { data: { tenantId: string } }).data.tenantId;
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@segments.test', password: PASSWORD } });
  const cookies = login.headers['set-cookie']; const lines = cookies === undefined ? [] : Array.isArray(cookies) ? cookies : [cookies];
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrf = cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith('convo_csrf='))?.slice(11) ?? '';
  const agentPassword = 'segment agent password';
  const seeded = await withTenant(pool, tenantId, async (sql) => {
    const teamId = (await sql.query<{ id: string }>(`INSERT INTO teams(tenant_id,name) VALUES($1,'Marketing') RETURNING id::text`, [tenantId])).rows[0]!.id;
    const userId = randomUUID();
    await sql.query(`INSERT INTO users(id,email,password_hash,status) VALUES($1,'agent@segments.test',$2,'active')`, [userId, await argon2.hash(agentPassword)]);
    const membershipId = (await sql.query<{ id: string }>(`INSERT INTO memberships(tenant_id,user_id,role_id,status) SELECT $1,$2,id,'active' FROM roles WHERE key='agent' RETURNING id::text`, [tenantId, userId])).rows[0]!.id;
    await sql.query(`INSERT INTO membership_scopes(tenant_id,membership_id,scope_type,scope_id) VALUES($1,$2,'team',$3)`, [tenantId, membershipId, teamId]);
    return { teamId };
  });
  const agentLogin = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'agent@segments.test', password: agentPassword } });
  const agentLines = Array.isArray(agentLogin.headers['set-cookie']) ? agentLogin.headers['set-cookie'] : [agentLogin.headers['set-cookie'] ?? ''];
  const agentCookie = agentLines.map((line) => line.split(';')[0]).join('; ');
  const agentCsrf = agentCookie.split(';').map((value) => value.trim()).find((value) => value.startsWith('convo_csrf='))?.slice(11) ?? '';
  return { app, pool, server, tenantId, cookie, csrf, teamId: seeded.teamId, agent: { cookie: agentCookie, csrf: agentCsrf } };
}

function send(api: Harness, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>, browser: Browser = api): Promise<LightMyRequestResponse> {
  return api.server.inject({ method, url: `/api/v1/tenants/${api.tenantId}${path}`, headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrf }, ...(payload === undefined ? {} : { payload }) });
}

describe('saved views and audiences API', () => {
  let api: Harness;
  beforeAll(async () => { api = await setup(); }, 120_000);
  afterAll(async () => { if (api !== undefined) await api.app.close(); });

  it('persists private, team and workspace views and retires with version fencing', async () => {
    const created = await send(api, 'POST', '/saved-views', { name: 'Unread WhatsApp', resource: 'conversations', visibility: 'private', conditions });
    expect(created.statusCode, created.body).toBe(201);
    const view = (created.json() as { data: { id: string; version: number } }).data;
    expect((await send(api, 'POST', '/saved-views', { name: 'Marketing leads', resource: 'contacts', visibility: 'team', teamId: api.teamId, conditions })).statusCode).toBe(201);
    const shared = await send(api, 'POST', '/saved-views', { name: 'Shared inbox', resource: 'conversations', visibility: 'workspace', conditions });
    expect(shared.statusCode).toBe(201);
    const sharedView = (shared.json() as { data: { id: string; version: number } }).data;
    const listed = await send(api, 'GET', '/saved-views?resource=conversations');
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { data: readonly unknown[] }).data).toHaveLength(2);

    const updated = await send(api, 'PATCH', `/saved-views/${view.id}`, { version: view.version, name: 'Unread priority', resource: 'conversations', visibility: 'team', teamId: api.teamId, conditions });
    expect(updated.statusCode).toBe(200);
    const next = (updated.json() as { data: { version: number } }).data.version;
    expect((await send(api, 'PATCH', `/saved-views/${view.id}`, { version: 1, name: 'stale', resource: 'conversations', visibility: 'private', conditions })).statusCode).toBe(409);
    expect((await send(api, 'DELETE', `/saved-views/${view.id}`, { version: next })).statusCode).toBe(200);
    expect((await send(api, 'DELETE', `/saved-views/${view.id}`, { version: next })).statusCode).toBe(404);
    const sharedUpdated = await send(api, 'PATCH', `/saved-views/${sharedView.id}`, { version: sharedView.version, name: 'Shared work', resource: 'conversations', visibility: 'workspace', conditions });
    expect(sharedUpdated.statusCode).toBe(200);
    expect((await send(api, 'DELETE', `/saved-views/${sharedView.id}`, { version: (sharedUpdated.json() as { data: { version: number } }).data.version })).statusCode).toBe(200);
    const retireConflict = await send(api, 'POST', '/saved-views', { name: 'Retire fence', resource: 'contacts', visibility: 'private', conditions });
    const retireView = (retireConflict.json() as { data: { id: string; version: number } }).data;
    expect((await send(api, 'DELETE', `/saved-views/${retireView.id}`, { version: 99 })).statusCode).toBe(409);
    expect((await send(api, 'DELETE', `/saved-views/${retireView.id}`, { version: retireView.version })).statusCode).toBe(200);
  });

  it('validates filters, resources, CSRF and team references at the boundary', async () => {
    expect((await send(api, 'GET', '/saved-views?resource=campaigns')).statusCode).toBe(400);
    expect((await send(api, 'POST', '/saved-views', { name: 'Bad', resource: 'contacts', visibility: 'private', conditions: { version: 1 } })).statusCode).toBe(400);
    expect((await send(api, 'POST', '/saved-views', { name: 'Bad team', resource: 'contacts', visibility: 'team', teamId: randomUUID(), conditions })).statusCode).toBe(404);
    const noCsrf = await api.server.inject({ method: 'POST', url: `/api/v1/tenants/${api.tenantId}/saved-views`, headers: { cookie: api.cookie }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
    expect((await send(api, 'POST', '/saved-views', { name: 'My queue', resource: 'conversations', visibility: 'private', conditions }, api.agent)).statusCode).toBe(201);
    expect((await send(api, 'POST', '/saved-views', { name: 'My contacts', resource: 'contacts', visibility: 'private', conditions }, api.agent)).statusCode).toBe(201);
    const agentViews = await send(api, 'GET', '/saved-views?resource=conversations', undefined, api.agent);
    expect(agentViews.statusCode).toBe(200);
    expect((agentViews.json() as { data: readonly unknown[] }).data).toHaveLength(1);
    expect((await send(api, 'POST', '/saved-views', { name: 'Shared by agent', resource: 'conversations', visibility: 'workspace', conditions }, api.agent)).statusCode).toBe(403);
    expect((await send(api, 'POST', '/saved-views', { name: 'Wrong team', resource: 'conversations', visibility: 'team', teamId: randomUUID(), conditions }, api.agent)).statusCode).toBe(403);
  });

  it('creates, lists, updates and retires reusable dynamic audiences', async () => {
    const created = await send(api, 'POST', '/audiences', { name: 'Consented leads', description: 'Reusable cohort', conditions });
    expect(created.statusCode, created.body).toBe(201);
    const audience = (created.json() as { data: { id: string; version: number } }).data;
    expect((await send(api, 'POST', '/audiences', { name: 'Consented leads', conditions })).statusCode).toBe(409);
    expect((await send(api, 'GET', '/audiences')).statusCode).toBe(200);
    const updated = await send(api, 'PATCH', `/audiences/${audience.id}`, { version: audience.version, name: 'Qualified leads', conditions });
    expect(updated.statusCode).toBe(200);
    const next = (updated.json() as { data: { version: number } }).data.version;
    expect((await send(api, 'PATCH', `/audiences/${audience.id}`, { version: audience.version, name: 'Stale', conditions })).statusCode).toBe(409);
    expect((await send(api, 'DELETE', `/audiences/${audience.id}`, { version: next })).statusCode).toBe(200);
    expect((await send(api, 'DELETE', `/audiences/${audience.id}`, { version: next })).statusCode).toBe(409);
  });
});
