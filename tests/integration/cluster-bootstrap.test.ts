import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapCluster } from '../../packages/database/src/bootstrap.js';
import { NAMES } from '../support/cluster.js';
import { clusterCredentials, scratchDatabaseName, superuserPool } from '../support/scratch.js';

const cluster = clusterCredentials();
const admin = superuserPool();

afterAll(async () => {
  await admin.end();
});

function uniqueRole(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

interface RoleAttributes {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolcanlogin: boolean;
}

async function attributesOf(role: string): Promise<RoleAttributes | undefined> {
  const result = await admin.query<RoleAttributes>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  return result.rows[0];
}

describe('bootstrapCluster', () => {
  it('creates the database and lets only the runtime role connect', async () => {
    const names = { ...NAMES, database: scratchDatabaseName('convo_boot') };
    await bootstrapCluster(cluster, names);

    const created = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      names.database,
    ]);
    expect(created.rowCount).toBe(1);

    const privileges = await admin.query<{ runtime: boolean; everyone: boolean }>(
      `SELECT has_database_privilege($1, $2, 'CONNECT') AS runtime,
              has_database_privilege('public', $2, 'CONNECT') AS everyone`,
      [names.runtimeRole, names.database],
    );
    expect(privileges.rows[0]?.runtime).toBe(true);
    expect(privileges.rows[0]?.everyone).toBe(false);
  }, 60_000);

  it('is idempotent: re-running against an existing cluster changes nothing', async () => {
    const names = { ...NAMES, database: scratchDatabaseName('convo_boot_twice') };
    await bootstrapCluster(cluster, names);
    await expect(bootstrapCluster(cluster, names)).resolves.toBeUndefined();

    const count = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_database WHERE datname = $1',
      [names.database],
    );
    expect(count.rows[0]?.count).toBe('1');
  }, 60_000);

  /**
   * The runtime role is the one thing standing between a bug in a policy and a
   * cross-tenant read. A role pre-created by an operator with wider rights --
   * which is exactly how a self-hosted install goes wrong -- must be narrowed
   * on every boot, not merely on first creation.
   */
  it('strips SUPERUSER and BYPASSRLS from a pre-existing over-privileged runtime role', async () => {
    const role = uniqueRole('convo_wide');
    await admin.query(
      `CREATE ROLE "${role}" LOGIN SUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD 'wide-test'`,
    );
    expect(await attributesOf(role)).toMatchObject({
      rolsuper: true,
      rolbypassrls: true,
      rolcreatedb: true,
      rolcreaterole: true,
    });

    await bootstrapCluster(cluster, {
      ...NAMES,
      database: scratchDatabaseName('convo_boot_wide'),
      runtimeRole: role,
      runtimePassword: 'wide-test',
    });

    expect(await attributesOf(role)).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
  }, 60_000);

  it('creates a login role whose password contains a quote, and it can connect', async () => {
    const role = uniqueRole('convo_quoted');
    const password = "pa'ss'word";
    const names = {
      ...NAMES,
      database: scratchDatabaseName('convo_boot_quoted'),
      runtimeRole: role,
      runtimePassword: password,
    };
    await bootstrapCluster(cluster, names);

    const client = new Client({
      host: cluster.host,
      port: cluster.port,
      database: names.database,
      user: role,
      password,
    });
    await client.connect();
    try {
      const who = await client.query<{ me: string }>('SELECT current_user AS me');
      expect(who.rows[0]?.me).toBe(role);
    } finally {
      await client.end();
    }
  }, 60_000);

  describe('identifier safety', () => {
    it.each([
      ['a quoted injection', 'evil"; DROP DATABASE postgres; --'],
      ['a hyphen', 'convo-app'],
      ['a leading digit', '1role'],
      ['an empty name', ''],
      ['a space', 'convo app'],
    ])('refuses %s as a role name before any SQL is built', async (_label, role) => {
      await expect(
        bootstrapCluster(cluster, {
          ...NAMES,
          database: scratchDatabaseName('convo_boot_unsafe'),
          runtimeRole: role,
          runtimePassword: 'x',
        }),
      ).rejects.toThrow(`Unsafe SQL identifier: ${role}`);

      const survived = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        'postgres',
      ]);
      expect(survived.rowCount).toBe(1);
    }, 60_000);

    it('refuses an unsafe database name', async () => {
      await expect(
        bootstrapCluster(cluster, { ...NAMES, database: 'convo"; DROP DATABASE postgres; --' }),
      ).rejects.toThrow('Unsafe SQL identifier');
    }, 60_000);
  });
});
