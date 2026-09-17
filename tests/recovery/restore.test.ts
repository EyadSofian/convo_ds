import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
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
  superuserPool,
} from '../support/scratch.js';
import {
  backup,
  restore,
  rlsPosture,
  rowCounts,
  tableInventory,
  type LogicalBackup,
} from './logical-backup.js';

/**
 * The restore drill.
 *
 * A configured backup is not proof of recovery, and this file exists because
 * the difference has to be executed rather than asserted in a document. What it
 * proves is listed in `logical-backup.ts`; what it deliberately does **not**
 * prove — `pg_dump` fidelity, and the platform's snapshot mechanism — is
 * recorded in `docs/runbooks/DATABASE_RECOVERY.md` and is still an open gate.
 *
 * The shape is: build a source installation with real data through the real
 * API, take a logical backup, build an isolated target from the migration set
 * alone, restore into it, then prove the copy is correct *and* that the
 * application works against it.
 */

const BOOTSTRAP_TOKEN = 'recovery-drill-bootstrap-token-000001';
const OWNER_PASSWORD = 'owner password for the recovery drill';

interface Installation {
  readonly app: NestFastifyApplication;
  readonly server: FastifyInstance;
  readonly pool: Pool;
  readonly names: DatabaseNames;
}

interface Browser {
  readonly cookie: string;
  readonly csrf: string;
}

let source: Installation;
let target: Installation | undefined;
let sourceSuper: Pool;
let targetSuper: Pool;
let snapshot: LogicalBackup;
let sourceCounts: Readonly<Record<string, number>>;
let owner: Browser;
let tenantId: string;

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Digital School Operations',
    CONVO_PUBLIC_BASE_URL: 'https://ops.digital-school.test',
    CONVO_DEFAULT_LOCALE: 'en',
    CONVO_SUPPORTED_LOCALES: 'ar,en',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'recovery-drill-hash-secret-0000000001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'recovery-drill-idempotency-000000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function open(names: DatabaseNames): Promise<Installation> {
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool);
  return {
    app,
    pool,
    names,
    server: app.getHttpAdapter().getInstance() as unknown as FastifyInstance,
  };
}

async function signIn(install: Installation, email: string, password: string): Promise<Browser> {
  const login = await install.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const cookies = login.headers['set-cookie'] as string[];
  const session = cookies.find((value) => value.startsWith('convo_session='))?.split(';')[0] ?? '';
  const csrf = cookies.find((value) => value.startsWith('convo_csrf='))?.split(';')[0] ?? '';
  return { cookie: `${session}; ${csrf}`, csrf: csrf.slice('convo_csrf='.length) };
}

/**
 * Real data, created through the real API.
 *
 * Seeding with INSERTs would test the restore against rows no code path
 * produces. Everything below is created the way production creates it, so the
 * backup contains exactly the shapes a real installation holds.
 */
async function seed(install: Installation): Promise<void> {
  const bootstrap = await install.server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'recovery-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@recovery.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(201);
  tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;
  owner = await signIn(install, 'owner@recovery.test', OWNER_PASSWORD);

  const roles = await install.server.inject({
    method: 'GET',
    url: `/api/v1/tenants/${tenantId}/roles`,
    headers: { cookie: owner.cookie },
  });
  const agent = (roles.json() as { data: { id: string; key: string }[] }).data.find(
    (role) => role.key === 'agent',
  );

  // An invitation, which also queues an email delivery in the same transaction.
  const invited = await install.server.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/invitations`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'idempotency-key': 'recovery-invite-1' },
    payload: { email: 'agent@recovery.test', roleId: agent?.id, scopes: [{ type: 'tenant', id: null }] },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  // Contacts, so there is tenant-owned content behind an RLS policy.
  //
  // Written through a tenant transaction rather than an endpoint because the
  // product has no contact-creation API: a contact comes into existence when a
  // customer messages in, via `ChannelNormalizationService`. Driving a whole
  // signed webhook delivery here would test the ingress, which has its own
  // suite; what this drill needs is rows under a policy, created the same way
  // `ContactService` creates them.
  await withTenant(install.pool, tenantId, async (client) => {
    for (const name of ['Nadia Hassan', 'Omar Khaled', 'Huda Salem']) {
      await client.query(
        'INSERT INTO contacts (tenant_id, display_name, search_name) VALUES ($1, $2, $3)',
        [tenantId, name, name.toLowerCase()],
      );
    }
  });

  // A recovery challenge, so the global non-tenant tables carry rows too.
  const recovery = await install.server.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery',
    remoteAddress: '203.0.113.50',
    payload: { email: 'owner@recovery.test' },
  });
  expect(recovery.statusCode).toBe(202);
}

beforeAll(async () => {
  const sourceNames = await createScratchDatabase('convo_recovery_src');
  await migrateScratch(sourceNames);
  source = await open(sourceNames);
  await seed(source);

  sourceSuper = superuserPool(sourceNames.database);
  snapshot = await backup(sourceSuper);
  sourceCounts = await rowCounts(sourceSuper);
}, 180_000);

afterAll(async () => {
  await source.app.close().catch(() => undefined);
  await target?.app.close().catch(() => undefined);
  await sourceSuper.end().catch(() => undefined);
  await targetSuper?.end().catch(() => undefined);
});

describe('the backup', () => {
  it('covers every table the schema actually has', async () => {
    // A table the restore order does not know about is a table the restore
    // silently drops. `tableInventory` throws rather than letting that pass.
    await expect(tableInventory(sourceSuper)).resolves.toBeDefined();
  });

  it('captured the rows the seeding actually created', () => {
    expect(sourceCounts['tenants']).toBe(1);
    expect(sourceCounts['users']).toBeGreaterThanOrEqual(1);
    expect(sourceCounts['contacts']).toBe(3);
    expect(sourceCounts['invitations']).toBe(1);
    expect(sourceCounts['email_deliveries']).toBe(2);
    expect(sourceCounts['password_recovery_challenges']).toBe(1);
    expect(sourceCounts['schema_migrations']).toBeGreaterThanOrEqual(32);
  });
});

describe('restoring into an isolated database', () => {
  it('rebuilds the schema from the migration set alone', async () => {
    const targetNames = await createScratchDatabase('convo_recovery_dst');
    await migrateScratch(targetNames);
    targetSuper = superuserPool(targetNames.database);

    // The schema in the target came from running the migrations, not from the
    // backup. A restore that resurrects a schema nobody can reproduce is how an
    // environment drifts permanently.
    const targetMigrations = await targetSuper.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const sourceMigrations = await sourceSuper.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    expect(targetMigrations.rows).toEqual(sourceMigrations.rows);

    const written = await restore(targetSuper, snapshot);
    expect(written).toBeGreaterThan(0);

    target = await open(targetNames);
  }, 180_000);

  it('brings back every row of every table', async () => {
    const restored = await rowCounts(targetSuper);
    expect(restored).toEqual(sourceCounts);
  });

  it('keeps row level security enabled, forced and policied', async () => {
    const before = await rlsPosture(sourceSuper);
    const after = await rlsPosture(targetSuper);
    expect(after).toEqual(before);

    // Named explicitly as well as compared, so a source that had lost RLS could
    // not make this pass by matching.
    for (const table of ['tenants', 'contacts', 'conversations', 'automations', 'invitations']) {
      expect(after[table]).toEqual({ enabled: true, forced: true, policies: 1 });
    }
  });
});

describe('the restored copy behaves like a database, not like a dump', () => {
  it('still refuses a read with no tenant context', async () => {
    // The default is DENY because `app_current_tenant()` is NULL, and
    // `tenant_id = NULL` is NULL rather than true.
    const rows = await target!.pool.query('SELECT id FROM contacts');
    expect(rows.rowCount).toBe(0);
  });

  it('still isolates one company from another', async () => {
    const client = await target!.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['convo.tenant_id', tenantId]);
      const mine = await client.query('SELECT id FROM contacts');
      expect(mine.rowCount).toBe(3);

      // A company id that does not exist here sees nothing, which is the same
      // answer a real other tenant would get.
      await client.query('SELECT set_config($1, $2, true)', [
        'convo.tenant_id',
        '00000000-0000-4000-8000-0000000000ff',
      ]);
      const theirs = await client.query('SELECT id FROM contacts');
      expect(theirs.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('still enforces its foreign keys', async () => {
    // A restore that disabled constraints and never re-enabled them would pass
    // every count check above and be silently corrupt.
    await expect(
      target!.pool.query(
        `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'orphan')`,
        ['00000000-0000-4000-8000-0000000000ff'],
      ),
    ).rejects.toThrow();
  });
});

describe('the application against the restored database', () => {
  it('is ready', async () => {
    const response = await target!.server.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
  });

  it('lets the original owner sign in with the original password', async () => {
    // The password hash survived the round trip, which is the one credential
    // fact a restore can get subtly wrong.
    const restored = await signIn(target!, 'owner@recovery.test', OWNER_PASSWORD);
    expect(restored.cookie).toContain('convo_session=');
  });

  it('serves the contacts that were created before the backup', async () => {
    const restored = await signIn(target!, 'owner@recovery.test', OWNER_PASSWORD);
    const response = await target!.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/contacts`,
      headers: { cookie: restored.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const names = (response.json() as { data: { displayName: string }[] }).data.map(
      (contact) => contact.displayName,
    );
    expect(names.sort()).toEqual(['Huda Salem', 'Nadia Hassan', 'Omar Khaled']);
  });

  it('serves the invitation that was pending before the backup', async () => {
    const restored = await signIn(target!, 'owner@recovery.test', OWNER_PASSWORD);
    const response = await target!.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/invitations`,
      headers: { cookie: restored.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const pending = (response.json() as { data: { email: string; status: string }[] }).data;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email: 'agent@recovery.test', status: 'pending' });
  });

  it('still holds the queued email deliveries, unsent', async () => {
    // Queued work survives a restore. It has to: an invitation whose email was
    // lost in the restore is an invitation nobody can accept.
    const rows = await targetSuper.query<{ state: string; kind: string }>(
      'SELECT state, kind FROM email_deliveries ORDER BY kind',
    );
    expect(rows.rows).toEqual([
      { kind: 'invitation', state: 'pending' },
      { kind: 'password_recovery', state: 'pending' },
    ]);
  });
});
