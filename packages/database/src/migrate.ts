import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import type { AppliedMigration, ClusterCredentials, DatabaseNames } from './types.js';

// See the note in bootstrap.ts: `pg` is CommonJS and has no ESM named export.
const { Client } = pg;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface MigrateOptions {
  /**
   * Directory to read `.sql` files from. Overridden only by tests, which need
   * to prove that a failing migration rolls back and records nothing -- a fact
   * that cannot be demonstrated with the real, working migration set.
   */
  readonly migrationsDir?: string;
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
  try {
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
    await client.end();
  }
}
