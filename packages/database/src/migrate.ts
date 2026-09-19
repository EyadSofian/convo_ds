import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg, { type Client as PgClient } from 'pg';
import type { AppliedMigration, ClusterCredentials, DatabaseNames } from './types.js';

// See the note in bootstrap.ts: `pg` is CommonJS and has no ESM named export.
const { Client } = pg;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
/** Stable per-database session lock: ASCII-ish `CONV`, inside signed int32. */
export const MIGRATION_ADVISORY_LOCK_KEY = 1_129_273_942;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 250;

export interface MigrateOptions {
  /**
   * Directory to read `.sql` files from. Overridden only by tests, which need
   * to prove that a failing migration rolls back and records nothing -- a fact
   * that cannot be demonstrated with the real, working migration set.
   */
  readonly migrationsDir?: string;
  /** Maximum wait for another migrator before failing clearly. */
  readonly lockTimeoutMs?: number;
  /** Test override; production uses a short, bounded polling interval. */
  readonly lockPollMs?: number;
}

/**
 * Forward-only SQL migrations, applied as the migration role.
 *
 * Each file runs inside its own transaction and is recorded with a checksum, so
 * an edited-after-the-fact migration fails loudly instead of drifting silently
 * between environments.
 */
export async function migrate(
  cluster: ClusterCredentials,
  names: DatabaseNames,
  options: MigrateOptions = {},
): Promise<AppliedMigration[]> {
  const directory = options.migrationsDir ?? MIGRATIONS_DIR;
  const client = new Client({
    host: cluster.host,
    port: cluster.port,
    user: names.migrationRole,
    password: names.migrationPassword,
    database: names.database,
  });
  await client.connect();
  let lockHeld = false;
  try {
    await acquireMigrationLock(
      client,
      names.database,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
    );
    lockHeld = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
    const previous = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(previous.rows.map((r) => [r.name, r.checksum]));

    const results: AppliedMigration[] = [];
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const known = applied.get(name);

      if (known !== undefined) {
        if (known !== checksum) {
          throw new Error(
            `Migration ${name} changed after it was applied (recorded ${known}, now ${checksum}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        const inserted = await client.query<{ applied_at: Date }>(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) RETURNING applied_at',
          [name, checksum],
        );
        await client.query('COMMIT');
        results.push({ name, checksum, appliedAt: inserted.rows[0]!.applied_at });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return results;
  } finally {
    try {
      if (lockHeld) {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      }
    } finally {
      await client.end();
    }
  }
}

async function acquireMigrationLock(
  client: PgClient,
  database: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error('Migration lock timeout must be a non-negative integer.');
  }
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error('Migration lock poll interval must be a positive integer.');
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    if (result.rows[0]?.acquired === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Migration lock timed out after ${String(timeoutMs)} ms for database ${database}; ` +
          'another migrator is still running.',
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollMs, deadline - Date.now())),
    );
  }
}
