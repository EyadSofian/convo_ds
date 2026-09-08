import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrapCluster } from '../../packages/database/src/bootstrap.js';
import { migrate, type MigrateOptions } from '../../packages/database/src/migrate.js';
import type { ClusterCredentials, DatabaseNames } from '../../packages/database/src/types.js';
import { NAMES } from './cluster.js';

/**
 * Cluster credentials published by the global setup.
 *
 * Tests that exercise `bootstrapCluster` and `migrate` must call them **in this
 * process**. Running them only in Vitest's global-setup process is what left
 * P1-T1 with an unmeasurable 14% coverage number: the v8 provider does not
 * instrument that process, so the code executed without ever being counted.
 */
export function clusterCredentials(): ClusterCredentials {
  return {
    host: env('CONVO_TEST_PG_HOST'),
    port: Number(env('CONVO_TEST_PG_PORT')),
    superUser: env('CONVO_TEST_PG_SUPERUSER'),
    superPassword: env('CONVO_TEST_PG_SUPERPASSWORD'),
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is missing; the integration global setup did not run.`);
  }
  return value;
}

/** A throwaway database name that cannot collide with another test file's. */
export function scratchDatabaseName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function scratchNames(database: string): DatabaseNames {
  return { ...NAMES, database };
}

/** Creates an empty database owned by the migration role, with no schema yet. */
export async function createScratchDatabase(prefix: string): Promise<DatabaseNames> {
  const names = scratchNames(scratchDatabaseName(prefix));
  await bootstrapCluster(clusterCredentials(), names);
  return names;
}

export async function migrateScratch(
  names: DatabaseNames,
  options?: MigrateOptions,
): Promise<void> {
  await migrate(clusterCredentials(), names, options);
}

/** A runtime-role pool for a scratch database. Caller must `end()` it. */
export function scratchRuntimePool(names: DatabaseNames, max = 2): Pool {
  const cluster = clusterCredentials();
  return new Pool({
    host: cluster.host,
    port: cluster.port,
    database: names.database,
    user: names.runtimeRole,
    password: names.runtimePassword,
    max,
  });
}

/** A migration-role pool for a scratch database. Caller must `end()` it. */
export function scratchMigrationPool(names: DatabaseNames, max = 1): Pool {
  const cluster = clusterCredentials();
  return new Pool({
    host: cluster.host,
    port: cluster.port,
    database: names.database,
    user: names.migrationRole,
    password: names.migrationPassword,
    max,
  });
}

/** A superuser pool. Only for asserting on cluster catalogs. */
export function superuserPool(database = 'postgres', max = 1): Pool {
  const cluster = clusterCredentials();
  return new Pool({
    host: cluster.host,
    port: cluster.port,
    database,
    user: cluster.superUser,
    password: cluster.superPassword,
    max,
  });
}
