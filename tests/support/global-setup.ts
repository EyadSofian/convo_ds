import { Pool } from 'pg';
import { applyInstallationConfig } from '../../packages/domain/src/installation/state.js';
import { asExecutor } from '../../packages/database/src/transaction.js';
import { bootstrapCluster } from '../../packages/database/src/bootstrap.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { NAMES, startCluster } from './cluster.js';

/**
 * Starts one real PostgreSQL for the integration project, bootstraps the two
 * roles, applies every migration and records the installation as `saas` --
 * which from migration 0004 onward is a precondition for creating any company
 * at all (MODE-04). Connection details reach the tests through the environment
 * because Vitest's global setup runs in its own process.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const cluster = await startCluster();

  await bootstrapCluster(cluster.credentials, NAMES);
  const applied = await migrate(cluster.credentials, NAMES);
  console.log(`[integration] applied ${applied.length} migration(s) to ${NAMES.database}`);

  const pool = new Pool({
    host: cluster.credentials.host,
    port: cluster.credentials.port,
    database: NAMES.database,
    user: NAMES.runtimeRole,
    password: NAMES.runtimePassword,
    max: 1,
  });
  try {
    const result = await applyInstallationConfig(asExecutor(pool), 'saas');
    console.log(`[integration] installation ${result.status} (saas)`);
  } finally {
    await pool.end();
  }

  process.env['CONVO_TEST_PG_HOST'] = cluster.credentials.host;
  process.env['CONVO_TEST_PG_PORT'] = String(cluster.credentials.port);
  process.env['CONVO_TEST_PG_SUPERUSER'] = cluster.credentials.superUser;
  process.env['CONVO_TEST_PG_SUPERPASSWORD'] = cluster.credentials.superPassword;

  return async () => {
    await cluster.stop();
  };
}
