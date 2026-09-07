import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrationPool, runtimePool } from '../support/pools.js';
import { NAMES } from '../support/cluster.js';

/**
 * TEN-04: RLS is only a control if the role that runs application queries
 * cannot switch it off. These assertions are about the role itself, so they run
 * against the catalog rather than against business tables.
 */
describe('runtime database role', () => {
  let admin: Pool;
  let app: Pool;

  beforeAll(() => {
    admin = migrationPool();
    app = runtimePool();
  });

  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  it('has neither superuser nor BYPASSRLS', async () => {
    const { rows } = await admin.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1',
      [NAMES.runtimeRole],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('owns no tables, so FORCE ROW LEVEL SECURITY cannot be sidestepped', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = $1 AND c.relkind IN ('r', 'p')`,
      [NAMES.runtimeRole],
    );

    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('cannot create tables in the application schema', async () => {
    await expect(app.query('CREATE TABLE escalation_attempt (id int)')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot grant itself BYPASSRLS', async () => {
    await expect(app.query(`ALTER ROLE ${NAMES.runtimeRole} BYPASSRLS`)).rejects.toThrow();
  });

  it('has every tenant-owned table under RLS, with FORCE set', async () => {
    const expected = [
      'membership_scopes',
      'memberships',
      'role_permissions',
      'roles',
      'team_members',
      'teams',
      'tenants',
    ];

    const { rows } = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [expected],
    );

    expect(rows.map((r) => r.relname)).toEqual(expected);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });
});
