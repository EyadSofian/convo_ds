import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig, BUILTIN_ROLE_KEYS, scopeFor } from '../../packages/domain/src/index.js';
import type { BuiltinRoleKey, PermissionKey } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The role boundary against a real PostgreSQL under FORCE RLS.
 *
 * The domain engine is exhaustively unit-tested; this file proves the other
 * half — that the database really holds the matrix, that the HTTP surface
 * enforces it by key, that a company can never lose its last Owner, and that a
 * pooled connection cannot carry one tenant's context into another's request.
 */

const BOOTSTRAP_TOKEN = 'authz-bootstrap-token-value-00000000001';
const OWNER_PASSWORD = 'owner password for authorization tests';
const MEMBER_PASSWORD = 'member password for authorization tests';

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly names: DatabaseNames;
  readonly tenantId: string;
  readonly ownerUserId: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Authz Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'authz-integration-hash-secret-value-001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'authz-idempotency-secret-value-000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(): Promise<Harness> {
  const names = await createScratchDatabase('convo_authz');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool);
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'authz-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@authz.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const body = bootstrap.json() as { data: { tenantId: string; ownerUserId: string } };
  return {
    app,
    pool,
    server,
    names,
    tenantId: body.data.tenantId,
    ownerUserId: body.data.ownerUserId,
  };
}

async function loginCookie(
  server: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': 'CONVO authz test' },
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return lines.map((line) => line.split(';')[0]).join('; ');
}

/** Adds a person to the tenant holding one of the seeded built-in roles. */
async function addMember(
  api: Harness,
  email: string,
  roleKey: BuiltinRoleKey,
  scopes: readonly { type: 'tenant' | 'team' | 'inbox'; id: string | null }[],
): Promise<{ userId: string; membershipId: string }> {
  const hash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });
  const inserted = await api.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id::text`,
    [email, hash],
  );
  const userId = inserted.rows[0]?.id as string;
  const membershipId = await withTenant(api.pool, api.tenantId, async (client) => {
    const role = await client.query<{ id: string }>(
      'SELECT id::text FROM roles WHERE key = $1',
      [roleKey],
    );
    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_id, status)
       VALUES ($1, $2, $3, 'active') RETURNING id::text`,
      [api.tenantId, userId, role.rows[0]?.id],
    );
    const id = membership.rows[0]?.id as string;
    for (const scope of scopes) {
      await client.query(
        `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
         VALUES ($1, $2, $3, $4)`,
        [api.tenantId, id, scope.type, scope.id],
      );
    }
    return id;
  });
  return { userId, membershipId };
}

describe('role boundary over HTTP', () => {
  let api: Harness;
  let ownerCookie: string;

  beforeAll(async () => {
    api = await createHarness();
    ownerCookie = await loginCookie(api.server, 'owner@authz.test', OWNER_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('seeds all seven roles with the scope levels the domain matrix declares', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/roles`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: readonly {
        key: string;
        is_builtin: boolean;
        grants: readonly { permission_key: string; scope_level: string }[];
      }[];
    };
    expect(body.data.map((role) => role.key)).toEqual([...BUILTIN_ROLE_KEYS].sort());

    // Every grant the API reports matches the domain matrix, cell for cell.
    for (const role of body.data) {
      for (const grant of role.grants) {
        expect(
          scopeFor(role.key as BuiltinRoleKey, grant.permission_key as PermissionKey),
          `${role.key} × ${grant.permission_key}`,
        ).toBe(grant.scope_level);
      }
    }

    // And no grant is missing: an Agent reads at `own`, an Analyst holds one key.
    const agent = body.data.find((role) => role.key === 'agent');
    expect(
      agent?.grants.find((grant) => grant.permission_key === 'conversation.read')?.scope_level,
    ).toBe('own');
    const analyst = body.data.find((role) => role.key === 'analyst');
    expect(analyst?.grants.map((grant) => grant.permission_key)).toEqual(['report.read']);
  });

  it('lists people and teams for a holder of member.manage', async () => {
    const supervisor = await addMember(api, 'supervisor@authz.test', 'supervisor', [
      { type: 'tenant', id: null },
    ]);

    // A team with a member, so the count is a real count and not a constant.
    await withTenant(api.pool, api.tenantId, async (client) => {
      const team = await client.query<{ id: string }>(
        `INSERT INTO teams (tenant_id, name) VALUES ($1, 'Enrollment') RETURNING id::text`,
        [api.tenantId],
      );
      await client.query(
        'INSERT INTO team_members (tenant_id, team_id, membership_id) VALUES ($1, $2, $3)',
        [api.tenantId, team.rows[0]?.id, supervisor.membershipId],
      );
    });

    const people = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/people`,
      headers: { cookie: ownerCookie },
    });
    expect(people.statusCode).toBe(200);
    const listed = (people.json() as { data: readonly { email: string; role: { key: string } }[] })
      .data;
    expect(listed.map((person) => person.email).sort()).toEqual([
      'owner@authz.test',
      'supervisor@authz.test',
    ]);
    expect(listed.find((person) => person.email === 'supervisor@authz.test')?.role.key).toBe(
      'supervisor',
    );

    const teams = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/teams`,
      headers: { cookie: ownerCookie },
    });
    expect(teams.statusCode).toBe(200);
    expect((teams.json() as { data: readonly { name: string; member_count: number }[] }).data).toEqual([
      { id: expect.any(String) as unknown as string, name: 'Enrollment', member_count: 1 },
    ]);
  });

  /**
   * Every built-in role against the administration surface. The decision comes
   * from the seeded matrix, so this is the database and the engine agreeing —
   * not a hand-written list of who may do what.
   */
  it.each([
    ['admin', 200, 200],
    ['supervisor', 403, 403],
    ['agent', 403, 403],
    ['campaign_manager', 403, 403],
    ['analyst', 403, 403],
    ['integration_developer', 403, 403],
  ] as const)('gates roles and people correctly for %s', async (roleKey, roles, people) => {
    const email = `${roleKey}-probe@authz.test`;
    await addMember(api, email, roleKey, [{ type: 'tenant', id: null }]);
    const cookie = await loginCookie(api.server, email, MEMBER_PASSWORD);

    const roleResponse = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/roles`,
      headers: { cookie },
    });
    expect(roleResponse.statusCode, `${roleKey} → roles`).toBe(roles);

    const peopleResponse = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/people`,
      headers: { cookie },
    });
    expect(peopleResponse.statusCode, `${roleKey} → people`).toBe(people);
  });

  it('conceals a revoked membership as 404, never as 403', async () => {
    const email = 'revoked@authz.test';
    const { membershipId } = await addMember(api, email, 'admin', [{ type: 'tenant', id: null }]);
    const cookie = await loginCookie(api.server, email, MEMBER_PASSWORD);

    const before = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/roles`,
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    await withTenant(api.pool, api.tenantId, (client) =>
      client.query("UPDATE memberships SET status = 'revoked' WHERE id = $1", [membershipId]),
    );

    const after = await api.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${api.tenantId}/roles`,
      headers: { cookie },
    });
    // 403 would confirm the company exists to someone who no longer belongs.
    expect(after.statusCode).toBe(404);
    expect(after.json()).toMatchObject({ error: { code: 'resource_not_found' } });
  });

  it('refuses an unknown or malformed tenant identically', async () => {
    for (const tenant of ['99999999-9999-4999-8999-999999999999', 'not-a-uuid']) {
      const response = await api.server.inject({
        method: 'GET',
        url: `/api/v1/tenants/${tenant}/people`,
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode, tenant).toBe(404);
    }
  });

  it('requires a session for every administration route', async () => {
    for (const path of ['roles', 'people', 'teams', 'permissions']) {
      const response = await api.server.inject({
        method: 'GET',
        url: `/api/v1/tenants/${api.tenantId}/${path}`,
      });
      expect(response.statusCode, path).toBe(401);
    }
  });
});

describe('last-active-Owner protection', () => {
  let api: Harness;

  beforeAll(async () => {
    api = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('refuses to revoke the only Owner', async () => {
    await expect(
      withTenant(api.pool, api.tenantId, (client) =>
        client.query("UPDATE memberships SET status = 'revoked'"),
      ),
    ).rejects.toThrow(/at least one active Owner/);

    // The company still has its Owner: the transaction rolled back whole.
    const remaining = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM memberships WHERE status = 'active'",
      ),
    );
    expect(remaining.rows[0]?.count).toBe('1');
  });

  it('refuses to demote the only Owner to another role', async () => {
    await expect(
      withTenant(api.pool, api.tenantId, async (client) => {
        const admin = await client.query<{ id: string }>(
          "SELECT id::text FROM roles WHERE key = 'admin'",
        );
        return client.query('UPDATE memberships SET role_id = $1', [admin.rows[0]?.id]);
      }),
    ).rejects.toThrow(/at least one active Owner/);
  });

  /**
   * The trigger is deferred to commit precisely so this works: within one
   * transaction the company is briefly Owner-less, which is fine, and it
   * commits with exactly one Owner, which is what the rule protects.
   */
  it('allows a transactional ownership transfer that is Owner-less mid-flight', async () => {
    const second = await addMember(api, 'successor@authz.test', 'admin', [
      { type: 'tenant', id: null },
    ]);

    await withTenant(api.pool, api.tenantId, async (client) => {
      const roles = await client.query<{ key: string; id: string }>(
        "SELECT key, id::text FROM roles WHERE key IN ('owner', 'admin')",
      );
      const ownerRole = roles.rows.find((row) => row.key === 'owner')?.id;
      const adminRole = roles.rows.find((row) => row.key === 'admin')?.id;

      // Demote the incumbent first: the company has no Owner at this instant.
      await client.query(
        'UPDATE memberships SET role_id = $1 WHERE user_id = $2',
        [adminRole, api.ownerUserId],
      );
      // Then promote the successor. Commit sees exactly one Owner.
      await client.query('UPDATE memberships SET role_id = $1 WHERE id = $2', [
        ownerRole,
        second.membershipId,
      ]);
    });

    const owners = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ email: string }>(
        `SELECT u.email::text AS email
           FROM memberships m
           JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
           JOIN users u ON u.id = m.user_id
          WHERE r.key = 'owner' AND m.status = 'active'`,
      ),
    );
    expect(owners.rows.map((row) => row.email)).toEqual(['successor@authz.test']);
  });
});

describe('tenant isolation under a reused pooled connection', () => {
  let api: Harness;

  beforeAll(async () => {
    api = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  /**
   * The pool is deliberately small, so these transactions reuse the same
   * physical connections. A tenant context that leaked across a checkout would
   * show up here as one tenant reading another's rows.
   */
  it('never carries one tenant’s context into another transaction', async () => {
    // A second tenant cannot be created here — this is a self-hosted
    // single-company installation and the database enforces that. Another
    // tenant *id* is enough to prove the point: every predicate compares
    // against `app_current_tenant()`, so a context that leaked would show the
    // first tenant's rows under the second tenant's id.
    const otherTenantId = '11111111-2222-4333-8444-555555555555';

    for (let round = 0; round < 12; round += 1) {
      const mine = await withTenant(api.pool, api.tenantId, (client) =>
        client.query<{ count: string }>('SELECT count(*)::text AS count FROM roles'),
      );
      expect(mine.rows[0]?.count).toBe('7');

      const theirs = await withTenant(api.pool, otherTenantId, (client) =>
        client.query<{ count: string }>('SELECT count(*)::text AS count FROM roles'),
      );
      // No such tenant, so it must see zero roles — not the seven belonging
      // to the tenant whose context the connection last held.
      expect(theirs.rows[0]?.count).toBe('0');

      const stray = await api.pool.query<{ tenant: string | null }>(
        'SELECT app_current_tenant()::text AS tenant',
      );
      // Outside a `withTenant` transaction there is no context at all, so RLS
      // denies by default rather than falling back to the last one used.
      expect(stray.rows[0]?.tenant).toBeNull();
    }
  });

  it('denies every tenant-owned read when no context is set', async () => {
    const rows = await api.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memberships',
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
