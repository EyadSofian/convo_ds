import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { registeredOperationalRoutes } from '../../apps/api/src/route-inventory.js';
import { asExecutor } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The two probes.
 *
 * The property that matters most is the one that is easiest to get wrong:
 * **liveness must not consult the database.** If it did, a database blip would
 * make the platform kill and restart every healthy API instance simultaneously,
 * turning a recoverable dependency failure into a full outage at the moment the
 * dependency is least able to absorb a reconnection storm. That is asserted
 * below by stopping the pool and checking liveness still answers.
 */

let app: NestFastifyApplication;
let server: FastifyInstance;
let pool: Pool;
let names: DatabaseNames;

function envFor(database: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Health Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'health-integration-hash-secret-000001',
    CONVO_BOOTSTRAP_TOKEN: 'health-bootstrap-token-value-00000001',
    CONVO_IDEMPOTENCY_HASH_SECRET: 'health-idempotency-secret-0000000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: database.database,
    CONVO_PG_RUNTIME_ROLE: database.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: database.runtimePassword,
  };
}

beforeAll(async () => {
  names = await createScratchDatabase('convo_health');
  await migrateScratch(names);
  pool = scratchRuntimePool(names, 2);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  app = await createApiApplication(config, pool);
  server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
});

afterAll(async () => {
  await app.close();
});

describe('where the probes live', () => {
  it('serves them outside the versioned prefix', async () => {
    // A health check that moves with the API version returns 404 on the next
    // major, and a 404 is "unhealthy" to every probe ever written.
    expect((await server.inject({ method: 'GET', url: '/live' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/api/v1/live' })).statusCode).toBe(404);
  });

  it('registers exactly the two operational routes', () => {
    expect(registeredOperationalRoutes(server)).toEqual([
      { method: 'GET', path: '/live' },
      { method: 'GET', path: '/ready' },
    ]);
  });
});

describe('liveness', () => {
  it('answers without authentication', async () => {
    const response = await server.inject({ method: 'GET', url: '/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'alive' });
  });

  it('is never cached', async () => {
    const response = await server.inject({ method: 'GET', url: '/live' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reveals nothing about the installation', async () => {
    const body = (await server.inject({ method: 'GET', url: '/live' })).body;
    for (const secret of [names.database, names.runtimeRole, 'Health Test', '5432']) {
      expect(body).not.toContain(secret);
    }
  });
});

describe('readiness', () => {
  it('reports ready with a healthy database', async () => {
    const response = await server.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; role: string; checks: { name: string; ok: boolean }[] };
    expect(body.status).toBe('ready');
    expect(body.role).toBe('api');
    expect(body.checks).toEqual([
      expect.objectContaining({ name: 'database', ok: true }),
    ]);
  });

  it('answers 503 rather than a 200 carrying a false flag', async () => {
    // Most probes read the status line and never look at the body.
    const failing = await createScratchDatabase('convo_health_down');
    await migrateScratch(failing);
    const brokenPool = scratchRuntimePool(failing, 1);
    const brokenApp = await createApiApplication(parseApiConfig(envFor(failing)), brokenPool);
    const brokenServer = brokenApp.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    await brokenPool.end();

    const response = await brokenServer.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string; checks: { ok: boolean; code?: string }[] };
    expect(body.status).toBe('not_ready');
    expect(body.checks[0]?.ok).toBe(false);
    // A typed code, never the driver's message: that carries host, port and role.
    expect(body.checks[0]?.code).toBe('unavailable');
    expect(response.body).not.toContain(failing.runtimeRole);

    await brokenApp.close().catch(() => undefined);
  });

  it('stays alive even when it is not ready', async () => {
    // The whole point of separating the two: a database outage must not become
    // a restart storm across every instance at once.
    const failing = await createScratchDatabase('convo_health_live');
    await migrateScratch(failing);
    const brokenPool = scratchRuntimePool(failing, 1);
    const brokenApp = await createApiApplication(parseApiConfig(envFor(failing)), brokenPool);
    const brokenServer = brokenApp.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    await brokenPool.end();

    expect((await brokenServer.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    expect((await brokenServer.inject({ method: 'GET', url: '/live' })).statusCode).toBe(200);

    await brokenApp.close().catch(() => undefined);
  });
});
