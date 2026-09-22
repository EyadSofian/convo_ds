import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  migrate,
} from '../../packages/database/src/migrate.js';
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
/** Every migration on disk, which is what a fresh database ends up holding. */
const MIGRATION_FILES = readdirSync(
  fileURLToPath(new URL('../../packages/database/migrations', import.meta.url)),
).filter((name) => name.endsWith('.sql'));

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
      '0013_broker_relay.sql',
      '0014_realtime.sql',
      '0015_receipt_watermark.sql',
      '0016_contacts.sql',
      '0017_conversation_lifecycle.sql',
      '0018_work_routing.sql',
      '0019_metadata_catalogue.sql',
      '0020_campaign_core.sql',
      '0021_campaign_dispatch_queue.sql',
      '0022_campaign_test_send.sql',
      '0023_campaign_reporting.sql',
      '0024_campaign_failed_retry.sql',
      '0025_campaign_report_exports.sql',
      '0026_contact_field_email_phone.sql',
      '0027_views_and_audiences.sql',
      '0028_automation_foundation.sql',
      '0029_automation_event_queue.sql',
      '0030_email_outbox.sql',
      '0031_invitation_tenant_scope.sql',
      '0032_automation_execution.sql',
      '0033_account_security_events.sql',
      '0034_campaign_conversation_attribution.sql',
    ]);
    expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(applied[0]?.appliedAt).toBeInstanceOf(Date);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'account_security_events',
      'admin_audit_events',
      'audience_snapshot_members',
      'audience_snapshots',
      'audiences',
      'auth_rate_limits',
      'automation_action_executions',
      'automation_events',
      'automation_logs',
      'automation_recipients',
      'automation_runs',
      'automation_schedule_queue',
      'automation_templates',
      'automation_work_queue',
      'automations',
      'broker_dead_letters',
      'broker_deliveries',
      'broker_outbox',
      'budget_reservations',
      'builtin_role_definitions',
      'builtin_role_grants',
      'campaign_approvals',
      'campaign_audit',
      'campaign_conversation_attributions',
      'campaign_executions',
      'campaign_recipients',
      'campaign_report_export_queue',
      'campaign_report_exports',
      'campaign_report_rows',
      'campaign_retry_recipients',
      'campaign_retry_runs',
      'campaign_revisions',
      'campaign_test_sends',
      'campaign_work_queue',
      'campaigns',
      'channel_apps',
      'channel_asset_registry',
      'channel_connections',
      'channel_credentials',
      'channel_event_queue',
      'channel_events',
      'channel_suppressions',
      'channel_test_recipients',
      'consents',
      'contact_custom_field_values',
      'contact_identities',
      'contact_labels',
      'contacts',
      'conversation_audit',
      'conversation_collaborators',
      'conversation_custom_field_values',
      'conversation_episodes',
      'conversation_handoff_expiries',
      'conversation_handoffs',
      'conversation_labels',
      'conversation_notes',
      'conversation_participants',
      'conversation_reads',
      'conversation_wakes',
      'conversations',
      'custom_fields',
      'email_deliveries',
      'idempotency_records',
      'inbound_events',
      'installations',
      'invitation_scopes',
      'invitations',
      'labels',
      'membership_scopes',
      'memberships',
      'metadata_audit',
      'outbound_attempts',
      'outbound_messages',
      'outbox',
      'ownership_transfers',
      'password_recovery_challenges',
      'permissions',
      'realtime_events',
      'role_permissions',
      'roles',
      'saved_views',
      'schema_migrations',
      'team_members',
      'teams',
      'template_revisions',
      'templates',
      'tenant_event_sequences',
      'tenants',
      'user_membership_index',
      'user_sessions',
      'users',
      'webhook_receipts',
      'whatsapp_templates',
    ]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const applied = await migrate(clusterCredentials(), names);
    expect(applied).toEqual([]);

    const recorded = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    // Counted from the directory rather than pinned: a forward-only migration
    // added by a later slice must not make this assertion a lie somebody edits.
    expect(recorded.rows[0]?.count).toBe(String(MIGRATION_FILES.length));
  });

  it('serializes two migration jobs instead of racing schema writes', async () => {
    const target = await createScratchDatabase('convo_migrate_concurrent');
    const [first, second] = await Promise.all([
      migrate(clusterCredentials(), target),
      migrate(clusterCredentials(), target),
    ]);

    expect(first.length + second.length).toBe(MIGRATION_FILES.length);
    expect([first.length, second.length].sort((a, b) => a - b)).toEqual([
      0,
      MIGRATION_FILES.length,
    ]);
  }, 120_000);

  it('fails clearly after a bounded wait when another migrator holds the lock', async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      await expect(
        migrate(clusterCredentials(), names, { lockTimeoutMs: 25, lockPollMs: 5 }),
      ).rejects.toThrow(/Migration lock timed out after 25 ms.*another migrator is still running/);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      lockClient.release();
    }
  });

  it.each([
    [{ lockTimeoutMs: 1.5 }, /timeout must be a non-negative integer/],
    [{ lockTimeoutMs: -1 }, /timeout must be a non-negative integer/],
    [{ lockPollMs: 1.5 }, /poll interval must be a positive integer/],
    [{ lockPollMs: 0 }, /poll interval must be a positive integer/],
  ] as const)('rejects invalid advisory-lock timing options: %o', async (options, message) => {
    await expect(migrate(clusterCredentials(), names, options)).rejects.toThrow(message);
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
