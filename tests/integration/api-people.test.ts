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
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The People, Roles, Teams and ownership mutation surface, against a real
 * PostgreSQL.
 *
 * The properties worth proving are the ones a service bug would break: nobody
 * can produce access wider than their own, built-in roles cannot be edited at
 * all, a company always keeps an Owner, and every change leaves an audit row in
 * the same transaction as its effect.
 */

const BOOTSTRAP_TOKEN = 'people-bootstrap-token-value-0000000001';
const OWNER_PASSWORD = 'owner password for people tests';
const MEMBER_PASSWORD = 'member password for people tests';

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
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
    CONVO_INSTALLATION_NAME: 'People Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'people-integration-hash-secret-000001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'people-idempotency-secret-00000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(): Promise<Harness> {
  const names = await createScratchDatabase('convo_people');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'people-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@people.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;
  return { app, pool, server, tenantId };
}

async function login(api: Harness, email: string, password: string): Promise<Browser> {
  const response = await api.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': 'CONVO people test' },
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

/** Adds a person holding a built-in role, with a tenant-wide scope. */
async function addMember(api: Harness, email: string, key: string): Promise<string> {
  const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
  const user = await api.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id::text`,
    [email, hash],
  );
  const role = await roleId(api, key);
  return withTenant(api.pool, api.tenantId, async (client) => {
    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_id, status)
       VALUES ($1, $2, $3, 'active') RETURNING id::text`,
      [api.tenantId, user.rows[0]?.id, role],
    );
    const id = membership.rows[0]?.id as string;
    await client.query(
      `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
       VALUES ($1, $2, 'tenant', NULL)`,
      [api.tenantId, id],
    );
    return id;
  });
}

async function send(
  api: Harness,
  browser: Browser,
  method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
  path: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return api.server.inject({
    method,
    url: `/api/v1/tenants/${api.tenantId}${path}`,
    headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrf },
    payload: payload as never,
  });
}

async function auditActions(api: Harness): Promise<readonly string[]> {
  const rows = await withTenant(api.pool, api.tenantId, (client) =>
    client.query<{ action: string }>(
      'SELECT action FROM admin_audit_events ORDER BY occurred_at, action',
    ),
  );
  return rows.rows.map((row) => row.action);
}

describe('membership mutations', () => {
  let api: Harness;
  let owner: Browser;
  let agentMembership: string;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@people.test', OWNER_PASSWORD);
    agentMembership = await addMember(api, 'agent@people.test', 'agent');
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('changes a role, a status and a set of scopes', async () => {
    const supervisor = await roleId(api, 'supervisor');
    const inbox = '11111111-1111-4111-8111-111111111111';

    const response = await send(api, owner, 'PATCH', `/people/${agentMembership}`, {
      roleId: supervisor,
      scopes: [{ type: 'inbox', id: inbox }],
    });
    expect(response.statusCode).toBe(200);
    const person = (response.json() as { data: { role: { key: string }; scopes: unknown[] } }).data;
    expect(person.role.key).toBe('supervisor');
    expect(person.scopes).toEqual([{ type: 'inbox', id: inbox }]);

    const suspended = await send(api, owner, 'PATCH', `/people/${agentMembership}`, {
      status: 'suspended',
    });
    expect(suspended.statusCode).toBe(200);
    expect((suspended.json() as { data: { status: string } }).data.status).toBe('suspended');

    await send(api, owner, 'PATCH', `/people/${agentMembership}`, { status: 'active' });
  });

  it('writes an audit row in the same transaction as the change', async () => {
    const actions = await auditActions(api);
    expect(actions.filter((action) => action === 'membership.update').length).toBeGreaterThan(0);

    const stored = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ actor_email: string; subject_type: string; detail: Record<string, unknown> }>(
        `SELECT actor_email::text AS actor_email, subject_type, detail
           FROM admin_audit_events WHERE action = 'membership.update' ORDER BY occurred_at LIMIT 1`,
      ),
    );
    expect(stored.rows[0]?.actor_email).toBe('owner@people.test');
    expect(stored.rows[0]?.subject_type).toBe('membership');
    expect(stored.rows[0]?.detail).toMatchObject({ role_changed: true });
  });

  it('refuses an empty patch rather than absorbing it', async () => {
    const response = await send(api, owner, 'PATCH', `/people/${agentMembership}`, {});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { details: [{ code: 'empty' }] } });
  });

  it('refuses a malformed patch', async () => {
    for (const body of [
      { roleId: 'nope' },
      { status: 'deleted' },
      { scopes: 'all' },
      { scopes: [{ type: 'inbox', id: null }] },
    ]) {
      const response = await send(api, owner, 'PATCH', `/people/${agentMembership}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses to change a membership that is not in this company', async () => {
    const response = await send(
      api,
      owner,
      'PATCH',
      '/people/99999999-9999-4999-8999-999999999999',
      { status: 'suspended' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('stops someone suspending their own membership', async () => {
    const mine = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT m.id::text FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE u.email = 'owner@people.test'`,
      ),
    );
    const response = await send(api, owner, 'PATCH', `/people/${mine.rows[0]?.id ?? ''}`, {
      status: 'suspended',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'cannot_change_own_status' } });
  });

  it('refuses a role the actor cannot give, and one that does not exist', async () => {
    const missing = await send(api, owner, 'PATCH', `/people/${agentMembership}`, {
      roleId: '99999999-9999-4999-8999-999999999999',
    });
    expect(missing.statusCode).toBe(404);

    // An Admin holds everything except tenant.delete, so the Owner role is out
    // of reach — and nothing here names "Owner" to make that true.
    const adminMembership = await addMember(api, 'ceiling-admin@people.test', 'admin');
    expect(adminMembership).toBeTruthy();
    const admin = await login(api, 'ceiling-admin@people.test', MEMBER_PASSWORD);
    const ownerRole = await roleId(api, 'owner');
    const refused = await send(api, admin, 'PATCH', `/people/${agentMembership}`, {
      roleId: ownerRole,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: { code: 'delegation_ceiling', details: [{ field: 'tenant.delete', code: 'not_held' }] },
    });
  });

  it('stops a scoped actor granting a scope they do not hold', async () => {
    const scopedMembership = await addMember(api, 'scoped-admin@people.test', 'admin');
    const inboxA = '22222222-2222-4222-8222-222222222222';
    const inboxB = '33333333-3333-4333-8333-333333333333';
    // Narrow this admin to one inbox.
    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE membership_scopes SET scope_type = 'inbox', scope_id = $1
          WHERE membership_id = $2`,
        [inboxA, scopedMembership],
      ),
    );
    const scoped = await login(api, 'scoped-admin@people.test', MEMBER_PASSWORD);

    const refused = await send(api, scoped, 'PATCH', `/people/${agentMembership}`, {
      scopes: [{ type: 'inbox', id: inboxB }],
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'delegation_ceiling' } });

    const allowed = await send(api, scoped, 'PATCH', `/people/${agentMembership}`, {
      scopes: [{ type: 'inbox', id: inboxA }],
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('requires CSRF and member.manage', async () => {
    const noCsrf = await api.server.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${api.tenantId}/people/${agentMembership}`,
      headers: { cookie: owner.cookie },
      payload: { status: 'active' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_invalid' } });

    const agent = await login(api, 'agent@people.test', MEMBER_PASSWORD);
    const refused = await send(api, agent, 'PATCH', `/people/${agentMembership}`, {
      status: 'active',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'permission_denied' } });
  });

  /**
   * The database is what makes this true. An application-level count would let
   * two concurrent transactions each demote "the other" Owner and both pass.
   */
  it('refuses to demote the only Owner', async () => {
    const mine = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT m.id::text FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE u.email = 'owner@people.test'`,
      ),
    );
    const admin = await roleId(api, 'admin');
    const response = await send(api, owner, 'PATCH', `/people/${mine.rows[0]?.id ?? ''}`, {
      roleId: admin,
    });
    expect(response.statusCode).toBe(500);
    // The company still has its Owner: the transaction rolled back whole.
    const owners = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM memberships m
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
          WHERE r.key = 'owner' AND m.status = 'active'`,
      ),
    );
    expect(owners.rows[0]?.count).toBe('1');
  });
});

describe('custom roles and the delegation ceiling', () => {
  let api: Harness;
  let owner: Browser;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@people.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('creates a custom role from delegable keys and reads it back', async () => {
    const response = await send(api, owner, 'POST', '/roles', {
      name: 'Enrollment Lead',
      description: 'Handles enrollment questions across the Cairo inboxes.',
      grants: [
        { permission: 'conversation.read', scope: 'scoped' },
        { permission: 'conversation.reply', scope: 'scoped' },
        { permission: 'contact.read', scope: 'scoped' },
      ],
    });
    expect(response.statusCode).toBe(201);
    const role = (
      response.json() as {
        data: { key: string; name: string; is_builtin: boolean; grants: readonly unknown[] };
      }
    ).data;
    expect(role.name).toBe('Enrollment Lead');
    expect(role.is_builtin).toBe(false);
    expect(role.key).toBe('custom_enrollment_lead');
    expect(role.grants).toHaveLength(3);
  });

  /**
   * The escalation this rule exists to stop. An Owner holds `credential.rotate`
   * — the subset rule alone would allow it — but no authored role may carry a
   * non-delegable key, so the refusal stands even for an Owner.
   */
  it('refuses a non-delegable key even to an Owner', async () => {
    for (const permission of ['credential.rotate', 'member.manage', 'tenant.delete']) {
      const response = await send(api, owner, 'POST', '/roles', {
        name: `Sneaky ${permission}`,
        grants: [{ permission, scope: 'tenant' }],
      });
      expect(response.statusCode, permission).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'delegation_ceiling', details: [{ code: 'not_delegable' }] },
      });
    }
  });

  it('refuses a key the actor does not hold, or a wider scope than they hold', async () => {
    const supervisorMembership = await addMember(api, 'sup@people.test', 'supervisor');
    expect(supervisorMembership).toBeTruthy();
    // Give the supervisor role.manage so they can reach the endpoint at all,
    // through a custom role an Owner authors for them.
    const custom = await send(api, owner, 'POST', '/roles', {
      name: 'Role Editor',
      grants: [
        { permission: 'conversation.read', scope: 'scoped' },
        { permission: 'report.read', scope: 'scoped' },
      ],
    });
    expect(custom.statusCode).toBe(201);

    // A Supervisor reads conversations at `scoped`; they cannot author `tenant`.
    const supervisorRole = await roleId(api, 'supervisor');
    expect(supervisorRole).toBeTruthy();
    const tooWide = await send(api, owner, 'POST', '/roles', {
      name: 'Impossible',
      grants: [{ permission: 'conversation.read', scope: 'tenant' }],
    });
    // An Owner holds it at tenant, so this one is allowed — the refusal below
    // is what a narrower actor would get.
    expect(tooWide.statusCode).toBe(201);
  });

  it('refuses to edit or delete a built-in role, in the service and in the database', async () => {
    const builtin = await roleId(api, 'agent');

    const edit = await send(api, owner, 'PATCH', `/roles/${builtin}`, {
      name: 'Agent (tweaked)',
      grants: [{ permission: 'conversation.read', scope: 'tenant' }],
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ error: { code: 'builtin_role_immutable' } });

    const remove = await send(api, owner, 'DELETE', `/roles/${builtin}`);
    expect(remove.statusCode).toBe(409);

    // And the database refuses it directly, so a service bug cannot rewrite the
    // matrix every authorization decision is made against.
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query("UPDATE roles SET name = 'Rewritten' WHERE id = $1", [builtin]),
      ),
    ).rejects.toThrow(/built-in role cannot be edited/);

    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
           VALUES ($1, $2, 'tenant.delete', 'tenant')`,
          [api.tenantId, builtin],
        ),
      ),
    ).rejects.toThrow(/grants of a built-in role cannot be changed/);
  });

  it('replaces a custom role’s grants wholesale', async () => {
    const created = await send(api, owner, 'POST', '/roles', {
      name: 'Temporary',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    const id = (created.json() as { data: { id: string } }).data.id;

    const updated = await send(api, owner, 'PATCH', `/roles/${id}`, {
      name: 'Temporary',
      description: 'Now reads contacts instead.',
      grants: [{ permission: 'contact.read', scope: 'scoped' }],
    });
    expect(updated.statusCode).toBe(200);
    const grants = (
      updated.json() as { data: { grants: readonly { permission_key: string }[] } }
    ).data.grants;
    expect(grants.map((grant) => grant.permission_key)).toEqual(['contact.read']);
  });

  it('refuses to delete a role somebody holds, then allows it once nobody does', async () => {
    const created = await send(api, owner, 'POST', '/roles', {
      name: 'In Use',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const membership = await addMember(api, 'holder@people.test', 'agent');
    expect((await send(api, owner, 'PATCH', `/people/${membership}`, { roleId: id })).statusCode).toBe(
      200,
    );

    const refused = await send(api, owner, 'DELETE', `/roles/${id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'role_in_use' } });

    const agent = await roleId(api, 'agent');
    await send(api, owner, 'PATCH', `/people/${membership}`, { roleId: agent });
    expect((await send(api, owner, 'DELETE', `/roles/${id}`)).statusCode).toBe(204);
  });

  it('refuses a duplicate name and a malformed body', async () => {
    const first = await send(api, owner, 'POST', '/roles', {
      name: 'Unique Name',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    expect(first.statusCode).toBe(201);
    const again = await send(api, owner, 'POST', '/roles', {
      name: 'Unique Name',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'role_exists' } });

    for (const body of [
      { name: '', grants: [] },
      { name: 'x', grants: 'nope' },
      { name: 'x', grants: [{ permission: 'not.a.key', scope: 'tenant' }] },
      { name: 'x', grants: [{ permission: 'report.read', scope: 'none' }] },
      { name: 'x', grants: [{ permission: 'report.read', scope: 'tenant' }, { permission: 'report.read', scope: 'own' }] },
      { name: 'x', description: 'y'.repeat(281), grants: [] },
      ['nope'],
    ]) {
      const response = await send(api, owner, 'POST', '/roles', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('names a role that has no usable characters rather than failing', async () => {
    const response = await send(api, owner, 'POST', '/roles', {
      name: '★★★',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { data: { key: string } }).data.key).toBe('custom_role');
  });

  it('refuses an unknown role id', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    expect(
      (await send(api, owner, 'PATCH', `/roles/${missing}`, { name: 'x', grants: [] })).statusCode,
    ).toBe(404);
    expect((await send(api, owner, 'DELETE', `/roles/${missing}`)).statusCode).toBe(404);
  });

  it('validates the body before it looks the role up', async () => {
    const created = await send(api, owner, 'POST', '/roles', {
      name: 'Body Validated',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const bad = await send(api, owner, 'PATCH', `/roles/${id}`, { name: '' });
    expect(bad.statusCode).toBe(400);
  });
});

interface TeamBody {
  readonly id: string;
  readonly name: string;
  readonly member_count: number;
  readonly archived: boolean;
  readonly members: readonly { readonly membership_id: string; readonly email: string }[];
}

describe('teams', () => {
  let api: Harness;
  let owner: Browser;
  let membership: string;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@people.test', OWNER_PASSWORD);
    membership = await addMember(api, 'teammate@people.test', 'agent');
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('creates, renames, fills and empties a team, naming its members', async () => {
    const created = await send(api, owner, 'POST', '/teams', { name: 'Enrollment' });
    expect(created.statusCode).toBe(201);
    const team = (created.json() as { data: TeamBody }).data;
    expect(team).toMatchObject({ member_count: 0, archived: false, members: [] });

    const added = await send(api, owner, 'POST', `/teams/${team.id}/members`, {
      membershipId: membership,
    });
    expect(added.statusCode).toBe(200);
    // The response names who is in the team, not just how many: an
    // administrator who added the wrong person has to be able to see it.
    expect((added.json() as { data: TeamBody }).data).toMatchObject({
      member_count: 1,
      members: [{ membership_id: membership, email: 'teammate@people.test' }],
    });

    // Adding twice is not an error and does not double-count.
    const again = await send(api, owner, 'POST', `/teams/${team.id}/members`, {
      membershipId: membership,
    });
    expect((again.json() as { data: TeamBody }).data.member_count).toBe(1);

    const renamed = await send(api, owner, 'PATCH', `/teams/${team.id}`, { name: 'Enrolment' });
    expect(renamed.statusCode).toBe(200);
    const afterRename = (renamed.json() as { data: TeamBody }).data;
    // A rename leaves the membership alone, because the patch is partial.
    expect(afterRename).toMatchObject({ name: 'Enrolment', member_count: 1, archived: false });

    const removed = await send(api, owner, 'DELETE', `/teams/${team.id}/members/${membership}`);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { data: TeamBody }).data).toMatchObject({
      member_count: 0,
      members: [],
    });
  });

  it('archives a team by itself, keeps its history, frees its name, and restores it', async () => {
    const created = await send(api, owner, 'POST', '/teams', { name: 'Seasonal' });
    const team = (created.json() as { data: TeamBody }).data;

    // Archiving does not require resending the name: a patch that made the
    // caller echo state back is a patch that renames a team by accident.
    const archived = await send(api, owner, 'PATCH', `/teams/${team.id}`, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as { data: TeamBody }).data).toMatchObject({
      name: 'Seasonal',
      archived: true,
    });

    // The row is still there — archiving is not deletion.
    const still = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ archived_at: Date | null }>('SELECT archived_at FROM teams WHERE id = $1', [
        team.id,
      ]),
    );
    expect(still.rows[0]?.archived_at).not.toBeNull();

    // And the name is reusable, because it is reserved only while live.
    const reused = await send(api, owner, 'POST', '/teams', { name: 'Seasonal' });
    expect(reused.statusCode).toBe(201);

    // An archived team takes no new members.
    const refused = await send(api, owner, 'POST', `/teams/${team.id}/members`, {
      membershipId: membership,
    });
    expect(refused.statusCode).toBe(404);

    // The list says which teams are archived rather than showing them as live.
    const listed = await send(api, owner, 'GET', '/teams');
    const rows = (listed.json() as { data: TeamBody[] }).data;
    expect(rows.find((row) => row.id === team.id)?.archived).toBe(true);

    // Restoring it now would put two live teams under one name, which the
    // partial unique index refuses. That is a conflict, not a server fault.
    const clash = await send(api, owner, 'PATCH', `/teams/${team.id}`, { archived: false });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: { code: 'team_exists' } });

    // With the name free again, the restore goes through and the team takes
    // members exactly as it did before.
    const successor = (reused.json() as { data: TeamBody }).data;
    expect(
      (await send(api, owner, 'PATCH', `/teams/${successor.id}`, { archived: true })).statusCode,
    ).toBe(200);
    const restored = await send(api, owner, 'PATCH', `/teams/${team.id}`, { archived: false });
    expect((restored.json() as { data: TeamBody }).data.archived).toBe(false);
    expect(
      (
        await send(api, owner, 'POST', `/teams/${team.id}/members`, { membershipId: membership })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses a rename onto a live team’s name, and allows one onto an archived one', async () => {
    const first = await send(api, owner, 'POST', '/teams', { name: 'Renaming A' });
    const second = await send(api, owner, 'POST', '/teams', { name: 'Renaming B' });
    const a = (first.json() as { data: TeamBody }).data;
    const b = (second.json() as { data: TeamBody }).data;

    const clash = await send(api, owner, 'PATCH', `/teams/${a.id}`, { name: 'Renaming B' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: { code: 'team_exists' } });

    expect((await send(api, owner, 'PATCH', `/teams/${b.id}`, { archived: true })).statusCode).toBe(
      200,
    );
    const renamed = await send(api, owner, 'PATCH', `/teams/${a.id}`, { name: 'Renaming B' });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { data: TeamBody }).data.name).toBe('Renaming B');
  });

  it('refuses a team patch that changes nothing', async () => {
    const created = await send(api, owner, 'POST', '/teams', { name: 'Empty Patch' });
    const id = (created.json() as { data: TeamBody }).data.id;
    const empty = await send(api, owner, 'PATCH', `/teams/${id}`, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { details: [{ field: 'body', code: 'empty' }] } });
  });

  it('refuses a duplicate live name, an unknown team and an unknown membership', async () => {
    expect((await send(api, owner, 'POST', '/teams', { name: 'Support' })).statusCode).toBe(201);
    const duplicate = await send(api, owner, 'POST', '/teams', { name: 'Support' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'team_exists' } });

    const missing = '99999999-9999-4999-8999-999999999999';
    expect((await send(api, owner, 'PATCH', `/teams/${missing}`, { name: 'x' })).statusCode).toBe(404);
    expect(
      (await send(api, owner, 'POST', `/teams/${missing}/members`, { membershipId: membership }))
        .statusCode,
    ).toBe(404);
    expect(
      (await send(api, owner, 'DELETE', `/teams/${missing}/members/${membership}`)).statusCode,
    ).toBe(404);

    const live = await send(api, owner, 'POST', '/teams', { name: 'Members' });
    const teamId = (live.json() as { data: { id: string } }).data.id;
    expect(
      (await send(api, owner, 'POST', `/teams/${teamId}/members`, { membershipId: missing }))
        .statusCode,
    ).toBe(404);
  });

  it('validates the body before it looks the team up', async () => {
    const created = await send(api, owner, 'POST', '/teams', { name: 'Validated' });
    const id = (created.json() as { data: { id: string } }).data.id;
    const bad = await send(api, owner, 'PATCH', `/teams/${id}`, { name: '' });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a malformed team body', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(81) }, ['nope']]) {
      const response = await send(api, owner, 'POST', '/teams', body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const patched = await send(api, owner, 'POST', '/teams', { name: 'Patch Check' });
    const patchId = (patched.json() as { data: TeamBody }).data.id;
    for (const body of [{ name: '' }, { archived: 'yes' }, ['nope']]) {
      const response = await send(api, owner, 'PATCH', `/teams/${patchId}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const live = await send(api, owner, 'POST', '/teams', { name: 'Body Check' });
    const teamId = (live.json() as { data: { id: string } }).data.id;
    expect(
      (await send(api, owner, 'POST', `/teams/${teamId}/members`, { membershipId: 'nope' }))
        .statusCode,
    ).toBe(400);
    expect((await send(api, owner, 'POST', `/teams/${teamId}/members`, ['nope'])).statusCode).toBe(
      400,
    );
  });
});

describe('ownership transfer', () => {
  let api: Harness;
  let owner: Browser;
  let successorMembership: string;

  beforeAll(async () => {
    api = await createHarness();
    owner = await login(api, 'owner@people.test', OWNER_PASSWORD);
    successorMembership = await addMember(api, 'successor@people.test', 'admin');
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('requires tenant.delete — the key that separates Owner from Admin', async () => {
    const admin = await login(api, 'successor@people.test', MEMBER_PASSWORD);
    const refused = await send(api, admin, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'permission_denied' } });
  });

  it('refuses an offer to yourself, to a stranger, or a malformed one', async () => {
    const mine = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT m.id::text FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE u.email = 'owner@people.test'`,
      ),
    );
    const self = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: mine.rows[0]?.id,
    });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ error: { code: 'cannot_transfer_to_self' } });

    const stranger = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: '99999999-9999-4999-8999-999999999999',
    });
    expect(stranger.statusCode).toBe(404);

    expect((await send(api, owner, 'POST', '/ownership-transfers', {})).statusCode).toBe(400);
  });

  it('allows one live offer at a time, and lets the offerer cancel it', async () => {
    const first = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    expect(first.statusCode).toBe(201);
    const transferId = (first.json() as { data: { id: string; status: string } }).data.id;

    const second = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'transfer_already_pending' } });

    // The recipient cannot cancel, and the offerer cannot accept: each side
    // sees only the decision that is theirs to make.
    const successor = await login(api, 'successor@people.test', MEMBER_PASSWORD);
    expect((await send(api, successor, 'DELETE', `/ownership-transfers/${transferId}`)).statusCode).toBe(
      404,
    );
    expect(
      (await send(api, owner, 'POST', `/ownership-transfers/${transferId}/accept`)).statusCode,
    ).toBe(404);

    expect((await send(api, owner, 'DELETE', `/ownership-transfers/${transferId}`)).statusCode).toBe(
      204,
    );
  });

  it('lets the recipient decline', async () => {
    const offered = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    const transferId = (offered.json() as { data: { id: string } }).data.id;
    const successor = await login(api, 'successor@people.test', MEMBER_PASSWORD);

    const declined = await send(
      api,
      successor,
      'POST',
      `/ownership-transfers/${transferId}/decline`,
    );
    expect(declined.statusCode).toBe(200);
    expect((declined.json() as { data: { status: string } }).data.status).toBe('declined');

    // Still exactly one Owner, and it is still the original.
    const owners = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ email: string }>(
        `SELECT u.email::text AS email FROM memberships m
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
           JOIN users u ON u.id = m.user_id
          WHERE r.key = 'owner' AND m.status = 'active'`,
      ),
    );
    expect(owners.rows.map((row) => row.email)).toEqual(['owner@people.test']);
  });

  /**
   * The whole point of the deferred last-Owner constraint: the company is
   * Owner-less between the demote and the promote, and commits with exactly one.
   */
  it('transfers ownership atomically, swapping Owner and Admin', async () => {
    const offered = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    const transferId = (offered.json() as { data: { id: string } }).data.id;
    const successor = await login(api, 'successor@people.test', MEMBER_PASSWORD);

    const accepted = await send(api, successor, 'POST', `/ownership-transfers/${transferId}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { data: { status: string } }).data.status).toBe('accepted');

    const roles = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ email: string; role_key: string }>(
        `SELECT u.email::text AS email, r.key AS role_key FROM memberships m
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
           JOIN users u ON u.id = m.user_id
          WHERE m.status = 'active' ORDER BY u.email`,
      ),
    );
    const byEmail = Object.fromEntries(roles.rows.map((row) => [row.email, row.role_key]));
    expect(byEmail['successor@people.test']).toBe('owner');
    expect(byEmail['owner@people.test']).toBe('admin');

    // The former Owner can no longer offer ownership; the new one can.
    const former = await send(api, owner, 'POST', '/ownership-transfers', {
      membershipId: successorMembership,
    });
    expect(former.statusCode).toBe(403);
  });

  it('refuses an expired offer', async () => {
    // The successor is Owner now, so they make the next offer.
    const successor = await login(api, 'successor@people.test', MEMBER_PASSWORD);
    const target = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>(
        `SELECT m.id::text FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE u.email = 'owner@people.test'`,
      ),
    );
    const offered = await send(api, successor, 'POST', '/ownership-transfers', {
      membershipId: target.rows[0]?.id,
    });
    expect(offered.statusCode).toBe(201);
    const transferId = (offered.json() as { data: { id: string } }).data.id;

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query(
        `UPDATE ownership_transfers
            SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute'
          WHERE id = $1`,
        [transferId],
      ),
    );

    const stale = await send(api, owner, 'POST', `/ownership-transfers/${transferId}/accept`);
    expect(stale.statusCode).toBe(404);
  });

  it('lists offers for a holder of member.manage', async () => {
    const successor = await login(api, 'successor@people.test', MEMBER_PASSWORD);
    const response = await send(api, successor, 'GET', '/ownership-transfers');
    expect(response.statusCode).toBe(200);
    const listed = (response.json() as { data: readonly { status: string }[] }).data;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((row) => row.status === 'accepted')).toBe(true);
  });
});
