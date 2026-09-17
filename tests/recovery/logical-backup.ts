import type { Pool } from 'pg';

/**
 * A logical backup and restore, performed through the PostgreSQL wire protocol.
 *
 * ## What this is, and what it is not
 *
 * This is **not** `pg_dump`. It does not exercise `pg_dump`'s format, its
 * `--section` ordering, its handling of large objects, or Railway's volume
 * snapshots. Those tools are not installed on the machine this runs on, and a
 * test that pretended otherwise would be worse than no test.
 *
 * What it *is* is the half of disaster recovery that a backup tool cannot prove
 * for you and that is far more often wrong: that a restored database is
 * **functionally correct for this application**. Specifically it proves, by
 * executing them:
 *
 * - the schema is rebuilt by the real migration set, to the same checksums;
 * - every row of every table comes back, with its foreign keys intact — which
 *   means the dependency ordering below is correct and no constraint is
 *   violated on the way in;
 * - row level security is still enabled, still forced, and still has its
 *   policies;
 * - tenant isolation still *works* on the restored copy, checked by querying it
 *   as the runtime role rather than by reading `pg_policies`;
 * - the application boots against the restored database and serves real
 *   authenticated reads.
 *
 * The evidence for the parts this cannot cover — `pg_dump` fidelity and the
 * platform's snapshot mechanism — has to come from an actual restore drill on
 * the platform, and `docs/runbooks/DATABASE_RECOVERY.md` says so plainly.
 *
 * ## Why SELECT/INSERT rather than COPY
 *
 * `COPY ... TO STDOUT` would need `pg-copy-streams`, a dependency this
 * repository does not have and does not need: the datasets here are test-sized,
 * and readability matters more than throughput in a file whose job is to be
 * believed.
 *
 * ## Why the restore runs as the superuser
 *
 * Every tenant-owned table carries `FORCE ROW LEVEL SECURITY`, which applies to
 * the table owner as well — so the migration role cannot insert another tenant's
 * rows any more than the runtime role can. A real `pg_restore` runs as a
 * superuser for exactly this reason, and so does this.
 */

/**
 * Every table, in an order where each one's foreign keys already exist.
 *
 * Maintained by hand rather than derived from `pg_constraint`, deliberately: a
 * derived order would silently reorder itself when a migration adds a cycle or
 * a self-reference, and the failure would look like a restore bug rather than a
 * schema one. A new table that is not listed here fails the completeness check
 * in `tableInventory`, which is the point.
 */
export const RESTORE_ORDER: readonly string[] = [
  // Reference and installation data.
  "installations",
  "permissions",
  "builtin_role_definitions",
  "builtin_role_grants",
  "automation_templates",
  // Identity.
  "users",
  "tenants",
  "tenant_event_sequences",
  "roles",
  "role_permissions",
  "memberships",
  "user_membership_index",
  "teams",
  "team_members",
  "membership_scopes",
  "user_sessions",
  "auth_rate_limits",
  "password_recovery_challenges",
  "invitations",
  "invitation_scopes",
  "ownership_transfers",
  "admin_audit_events",
  "idempotency_records",
  // Channels.
  "channel_apps",
  "channel_connections",
  "channel_asset_registry",
  "channel_credentials",
  "channel_suppressions",
  "channel_test_recipients",
  "webhook_receipts",
  "channel_events",
  "channel_event_queue",
  "inbound_events",
  "templates",
  "template_revisions",
  "whatsapp_templates",
  // Contacts and metadata.
  "custom_fields",
  "contacts",
  "contact_identities",
  "contact_custom_field_values",
  "consents",
  "labels",
  "contact_labels",
  "metadata_audit",
  // Conversations.
  "conversations",
  "conversation_episodes",
  "conversation_participants",
  "conversation_collaborators",
  "conversation_labels",
  "conversation_custom_field_values",
  "conversation_audit",
  "conversation_notes",
  "conversation_reads",
  "conversation_wakes",
  "conversation_handoffs",
  "conversation_handoff_expiries",
  "saved_views",
  // Outbound.
  "outbound_messages",
  "outbox",
  "outbound_attempts",
  // Audiences and campaigns.
  "audiences",
  "audience_snapshots",
  "audience_snapshot_members",
  "campaigns",
  "campaign_revisions",
  "campaign_approvals",
  "campaign_executions",
  "campaign_recipients",
  "campaign_work_queue",
  "campaign_test_sends",
  "campaign_audit",
  "campaign_retry_runs",
  "campaign_retry_recipients",
  "campaign_report_rows",
  "campaign_report_exports",
  "campaign_report_export_queue",
  "budget_reservations",
  // Automations.
  "automations",
  "automation_runs",
  "automation_recipients",
  "automation_action_executions",
  "automation_logs",
  "automation_events",
  "automation_schedule_queue",
  "automation_work_queue",
  // Realtime and broker.
  "realtime_events",
  "broker_outbox",
  "broker_deliveries",
  "broker_dead_letters",
  // Infrastructure.
  "email_deliveries",
  "schema_migrations",
];

export interface TableSnapshot {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

export type LogicalBackup = readonly TableSnapshot[];

/**
 * Every base table in `public`, checked against `RESTORE_ORDER`.
 *
 * A table that exists but is not listed is a failure rather than a silent
 * omission: it would be a table the restore quietly drops.
 */
export async function tableInventory(pool: Pool): Promise<readonly string[]> {
  const rows = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const present = rows.rows.map((row) => row.table_name);
  const missing = present.filter((table) => !RESTORE_ORDER.includes(table));
  if (missing.length > 0) {
    throw new Error(
      `RESTORE_ORDER does not cover: ${missing.join(', ')}. ` +
        'A table the restore does not know about is a table the restore drops.',
    );
  }
  return present;
}

/** Reads every row of every table, as the superuser, so RLS does not hide any. */
export async function backup(pool: Pool): Promise<LogicalBackup> {
  const present = await tableInventory(pool);
  const snapshots: TableSnapshot[] = [];
  for (const table of RESTORE_ORDER) {
    if (!present.includes(table)) {
      continue;
    }
    const columns = await columnsOf(pool, table);
    const result = await pool.query(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}`);
    snapshots.push({ table, columns, rows: result.rows as Record<string, unknown>[] });
  }
  return snapshots;
}

/**
 * Writes a backup into a freshly migrated database.
 *
 * The target's schema already exists — it was built by running the real
 * migrations — so this restores data only, which is exactly the split
 * `pg_restore --data-only` makes and exactly the one that matters here: the
 * schema must come from the migration set, or a restore silently resurrects a
 * schema nobody can reproduce.
 *
 * Reference tables seeded by migrations are already populated, so every insert
 * is `ON CONFLICT DO NOTHING` on the primary key. That makes the restore
 * idempotent, which is also what you want at 3am on the second attempt.
 */
export async function restore(pool: Pool, data: LogicalBackup): Promise<number> {
  let restored = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Constraints are checked at COMMIT rather than per statement, so a table
    // whose rows reference a later table in the order still restores.
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const snapshot of data) {
      for (const row of snapshot.rows) {
        const values = snapshot.columns.map((column) => row[column]);
        const placeholders = snapshot.columns.map((_column, index) => `$${String(index + 1)}`);
        await client.query(
          `INSERT INTO ${quote(snapshot.table)} (${snapshot.columns.map(quote).join(', ')})
           VALUES (${placeholders.join(', ')})
           ON CONFLICT DO NOTHING`,
          values,
        );
        restored += 1;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return restored;
}

/** Row counts per table, for comparing a source with its restored copy. */
export async function rowCounts(pool: Pool): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of await tableInventory(pool)) {
    const result = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${quote(table)}`,
    );
    counts[table] = Number(result.rows[0]?.total ?? '0');
  }
  return counts;
}

/** Which tables have RLS enabled and forced, and how many policies each carries. */
export async function rlsPosture(
  pool: Pool,
): Promise<Readonly<Record<string, { enabled: boolean; forced: boolean; policies: number }>>> {
  const rows = await pool.query<{
    table_name: string;
    enabled: boolean;
    forced: boolean;
    policies: string;
  }>(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced,
            (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  const posture: Record<string, { enabled: boolean; forced: boolean; policies: number }> = {};
  for (const row of rows.rows) {
    posture[row.table_name] = {
      enabled: row.enabled,
      forced: row.forced,
      policies: Number(row.policies),
    };
  }
  return posture;
}

async function columnsOf(pool: Pool, table: string): Promise<readonly string[]> {
  const rows = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND is_generated = 'NEVER' AND identity_generation IS DISTINCT FROM 'ALWAYS'
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.rows.map((row) => row.column_name);
}

/**
 * A SQL identifier, quoted.
 *
 * Every value that reaches here comes from `information_schema`, not from a
 * request, but quoting is not optional: an unquoted identifier is an injection
 * primitive the day somebody reuses this helper with a different source.
 */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
