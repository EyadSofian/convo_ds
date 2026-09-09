import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrate } from '../../packages/database/src/migrate.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  scratchMigrationPool,
} from '../support/scratch.js';

/**
 * These run the migration runner **in this process**, against a throwaway
 * database on the same real PostgreSQL. P1-T1 executed the same code only
 * inside Vitest's global-setup process, where the v8 provider cannot see it --
 * so it was exercised but never measured, and its failure paths were never
 * exercised at all.
 */
describe('migrate', () => {
  let names: DatabaseNames;
  let pool: Pool;

  beforeAll(async () => {
    names = await createScratchDatabase('convo_migrate');
    pool = scratchMigrationPool(names);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies every migration in filename order on a fresh database', async () => {
    const applied = await migrate(clusterCredentials(), names);

    expect(applied.map((m) => m.name)).toEqual([
      '0001_foundation.sql',
      '0002_rls.sql',
      '0003_permission_catalogue.sql',
      '0004_installation_mode.sql',
      '0005_idempotency.sql',
      '0006_auth_sessions.sql',
      '0007_role_matrix.sql',
      '0008_invitations.sql',
      '0009_people_admin.sql',
      '0010_channels.sql',
      '0011_outbound.sql',
      '0012_channel_settings.sql',
    ]);
    expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(applied[0]?.appliedAt).toBeInstanceOf(Date);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'admin_audit_events',
      'auth_rate_limits',
      'builtin_role_definitions',
      'builtin_role_grants',
      'channel_apps',
      'channel_asset_registry',
      'channel_connections',
      'channel_credentials',
      'channel_event_queue',
      'channel_events',
      'channel_suppressions',
      'idempotency_records',
      'inbound_events',
      'installations',
      'invitation_scopes',
      'invitations',
      'membership_scopes',
      'memberships',
      'outbound_attempts',
      'outbound_messages',
      'outbox',
      'ownership_transfers',
      'password_recovery_challenges',
      'permissions',
      'role_permissions',
      'roles',
      'schema_migrations',
      'team_members',
      'teams',
      'tenants',
      'user_membership_index',
      'user_sessions',
      'users',
      'webhook_receipts',
    ]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const applied = await migrate(clusterCredentials(), names);
    expect(applied).toEqual([]);

    const recorded = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(recorded.rows[0]?.count).toBe('12');
  });

  /**
   * The drift guard is the whole reason checksums are stored. Editing an
   * applied migration is how two environments end up with different schemas
   * while both report "up to date".
   */
  it('refuses to continue when an applied migration has been edited', async () => {
    await pool.query(
      `UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = '0002_rls.sql'`,
    );

    await expect(migrate(clusterCredentials(), names)).rejects.toThrow(
      /Migration 0002_rls\.sql changed after it was applied/,
    );
    await expect(migrate(clusterCredentials(), names)).rejects.toThrow(
      /Add a new migration instead of editing an applied one/,
    );

    // Restore so later assertions in this file see a consistent database.
    const real = await migrate(clusterCredentials(), await restoreChecksum(pool, names));
    expect(real).toEqual([]);
  });

  describe('when a migration fails', () => {
    let failingDir: string;

    beforeAll(async () => {
      failingDir = await mkdtemp(path.join(os.tmpdir(), 'convo-bad-migrations-'));
      await writeFile(
        path.join(failingDir, '0001_ok.sql'),
        'CREATE TABLE demo_ok (id integer PRIMARY KEY);',
      );
      await writeFile(
        path.join(failingDir, '0002_bad.sql'),
        'CREATE TABLE demo_partial (id integer PRIMARY KEY);\nSELECT 1 / 0;',
      );
      // A non-.sql file must be ignored rather than executed.
      await writeFile(path.join(failingDir, 'README.md'), 'not a migration');
    });

    afterAll(async () => {
      await rm(failingDir, { recursive: true, force: true });
    });

    it('rolls the whole file back, records nothing, and names the file', async () => {
      const target = await createScratchDatabase('convo_migrate_fail');
      const scratchPool = scratchMigrationPool(target);
      try {
        await expect(
          migrate(clusterCredentials(), target, { migrationsDir: failingDir }),
        ).rejects.toThrow(/Migration 0002_bad\.sql failed: division by zero/);

        const recorded = await scratchPool.query<{ name: string }>(
          'SELECT name FROM schema_migrations ORDER BY name',
        );
        expect(recorded.rows.map((r) => r.name)).toEqual(['0001_ok.sql']);

        const partial = await scratchPool.query<{ exists: boolean }>(
          `SELECT to_regclass('public.demo_partial') IS NOT NULL AS exists`,
        );
        expect(partial.rows[0]?.exists).toBe(false);

        const succeeded = await scratchPool.query<{ exists: boolean }>(
          `SELECT to_regclass('public.demo_ok') IS NOT NULL AS exists`,
        );
        expect(succeeded.rows[0]?.exists).toBe(true);
      } finally {
        await scratchPool.end();
      }
    }, 120_000);

    it('keeps the original driver error as the cause', async () => {
      const target = await createScratchDatabase('convo_migrate_cause');
      await migrate(clusterCredentials(), target, { migrationsDir: failingDir }).then(
        () => {
          throw new Error('expected the migration to fail');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).cause).toBeDefined();
        },
      );
    }, 120_000);
  });
});

/** Puts the real checksum back so the drift guard stops firing. */
async function restoreChecksum(pool: Pool, names: DatabaseNames): Promise<DatabaseNames> {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { MIGRATIONS_DIR } = await import('../../packages/database/src/migrate.js');
  const sql = await readFile(path.join(MIGRATIONS_DIR, '0002_rls.sql'), 'utf8');
  await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
    createHash('sha256').update(sql).digest('hex'),
    '0002_rls.sql',
  ]);
  return names;
}
