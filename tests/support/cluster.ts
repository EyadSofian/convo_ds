import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { ClusterCredentials, DatabaseNames } from '../../packages/database/src/types.js';

export const NAMES: DatabaseNames = {
  database: 'convo_test',
  migrationRole: 'convo_migrator',
  migrationPassword: 'migrator-local-test',
  runtimeRole: 'convo_app',
  runtimePassword: 'app-local-test',
};

export interface RunningCluster {
  readonly credentials: ClusterCredentials;
  stop(): Promise<void>;
}

/**
 * A real PostgreSQL for integration tests, started as a child process.
 *
 * This machine has no Docker daemon, so Testcontainers is unavailable (see
 * ADR-0015). `embedded-postgres` downloads and runs a genuine PostgreSQL
 * binary, which is what lets us assert on RLS, composite foreign keys and
 * pooled `SET LOCAL` behaviour rather than on a fake that has none of them.
 */
export async function startCluster(): Promise<RunningCluster> {
  const port = await findFreePort();
  const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'convo-pg-'));

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'convo_super',
    password: 'super-local-test',
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();

  return {
    credentials: {
      host: '127.0.0.1',
      port,
      superUser: 'convo_super',
      superPassword: 'super-local-test',
    },
    async stop() {
      await pg.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
