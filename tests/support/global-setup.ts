import { bootstrapCluster } from '../../packages/database/src/bootstrap.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { NAMES, startCluster } from './cluster.js';

/**
 * Starts one real PostgreSQL for the integration project, bootstraps the two
 * roles and applies every migration. Connection details reach the tests through
 * the environment because Vitest's global setup runs in its own process.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const cluster = await startCluster();

  await bootstrapCluster(cluster.credentials, NAMES);
  const applied = await migrate(cluster.credentials, NAMES);
  console.log(`[integration] applied ${applied.length} migration(s) to ${NAMES.database}`);

  process.env['CONVO_TEST_PG_HOST'] = cluster.credentials.host;
  process.env['CONVO_TEST_PG_PORT'] = String(cluster.credentials.port);

  return async () => {
    await cluster.stop();
  };
}
