import { bootstrapCluster } from './bootstrap.js';
import { migrate } from './migrate.js';
import type { ClusterCredentials, DatabaseNames } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'migrate' && command !== 'bootstrap') {
    console.error('usage: cli.ts <bootstrap|migrate>');
    process.exitCode = 2;
    return;
  }

  const cluster: ClusterCredentials = {
    host: required('CONVO_PG_HOST'),
    port: Number(required('CONVO_PG_PORT')),
    superUser: process.env['CONVO_PG_SUPERUSER'] ?? '',
    superPassword: process.env['CONVO_PG_SUPERPASSWORD'] ?? '',
  };

  const names: DatabaseNames = {
    database: required('CONVO_PG_DATABASE'),
    migrationRole: required('CONVO_PG_MIGRATION_ROLE'),
    migrationPassword: required('CONVO_PG_MIGRATION_PASSWORD'),
    runtimeRole: required('CONVO_PG_RUNTIME_ROLE'),
    runtimePassword: required('CONVO_PG_RUNTIME_PASSWORD'),
  };

  if (command === 'bootstrap') {
    await bootstrapCluster(cluster, names);
    console.log('bootstrap complete');
    return;
  }

  const applied = await migrate(cluster, names);
  if (applied.length === 0) {
    console.log('no pending migrations');
  } else {
    for (const m of applied) {
      console.log(`applied ${m.name}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
