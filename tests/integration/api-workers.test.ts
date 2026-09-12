import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApplication, requiresBroker, startApi } from '../../apps/api/src/app.js';
import type { BrokerPort } from '../../apps/api/src/broker/broker.port.js';
import { BrokerRelayService } from '../../apps/api/src/broker/relay.service.js';
import { CampaignPlannerService } from '../../apps/api/src/campaigns/campaign-planner.service.js';
import { CampaignReportExportService } from '../../apps/api/src/campaigns/report-export.service.js';
import { PROCESS_ROLES, parseApiConfig } from '../../apps/api/src/config.js';
import { ChannelDispatcherService } from '../../apps/api/src/channels/dispatcher.service.js';
import { tickFor } from '../../apps/api/src/workers/worker-roles.js';
import type { WorkerRole } from '../../apps/api/src/workers/worker-roles.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

/**
 * The four worker roles, run against a real database.
 *
 * These are not tests of *what* each worker does — the normalizer, the
 * dispatcher and the relay are each proved in their own file. They are tests
 * that the role wiring is real: that one artifact configured as
 * `worker-campaign` actually drains bulk outbound work, that a worker role does
 * not bind a port, and that the role which needs a broker refuses to run
 * without one rather than quietly becoming an in-memory queue.
 */

const BOOTSTRAP_TOKEN = 'workers-bootstrap-token-value-0000001';
const OWNER_PASSWORD = 'owner password for worker tests';

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  readonly names: DatabaseNames;
  readonly tenantId: string;
}

const stubBroker: BrokerPort = {
  name: 'test-stub',
  healthy: () => Promise.resolve(true),
  publish: () => Promise.resolve({ status: 'confirmed' }),
};

function envFor(names: DatabaseNames, role: string): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Workers Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: role,
    CONVO_AUTH_HASH_SECRET: 'workers-integration-hash-secret-001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'workers-idempotency-secret-000001',
    CONVO_WORKER_CONCURRENCY: '2',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

let api: Harness;

beforeAll(async () => {
  const names = await createScratchDatabase('convo_workers');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names, 'api'));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool, { broker: stubBroker });
  const server = app.getHttpAdapter().getInstance() as unknown as {
    inject: (options: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
  };
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'workers-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@workers.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  api = {
    app,
    pool,
    names,
    tenantId: (bootstrap.json() as { data: { tenantId: string } }).data.tenantId,
  };
}, 180_000);

afterAll(async () => {
  await api.app.close();
});

describe('the worker roles', () => {
  it.each<WorkerRole>([
    'worker-inbound',
    'worker-interactive',
    'worker-campaign',
    'worker-integration',
    'worker-report',
  ])('runs a tick for %s against a real database', async (role) => {
    const tick = tickFor(role, { app: api.app, concurrency: 2 });
    // An idle tick is the normal case for a freshly started worker, and it must
    // be a quiet zero rather than a crash.
    expect((await tick()).handled).toBe(0);
  });

  it('drains work through the role that owns it, and not through the others', async () => {
    // A broker envelope is the integration worker's job and nobody else's.
    const relay = api.app.get(BrokerRelayService);
    await withTenant(api.pool, api.tenantId, (client) =>
      relay.enqueue(asExecutor(client), api.tenantId, 'inbound.event', { eventId: 'w1' }),
    );

    for (const role of ['worker-inbound', 'worker-interactive', 'worker-campaign', 'worker-report'] as const) {
      expect((await tickFor(role, { app: api.app, concurrency: 2 })()).handled).toBe(0);
    }
    const integration = await tickFor('worker-integration', { app: api.app, concurrency: 2 })();
    expect(integration.handled).toBe(1);
  });
});

describe('the fair scheduler, in the worker that runs it', () => {
  it('reports what an idle round was offered and what it achieved', async () => {
    const idle = await tickFor('worker-interactive', { app: api.app, concurrency: 2 })();
    // Nothing offered and nothing achieved is not the same as no answer: an
    // operator watching for starvation needs a zero, not a gap.
    expect(idle.fairness).toEqual({ offered: 0, achieved: 0 });
  });

  it('bounds the round and deals it out rather than draining one company', async () => {
    // Two companies is the shape the scheduler exists for, and this
    // installation has one — so the property is asserted where it lives, over
    // many shapes, in packages/domain/src/channels/fairness.test.ts. What is
    // asserted here is the wiring: the worker asks for offers, plans a round
    // with a capacity, and reports both numbers.
    const dispatcher = api.app.get(ChannelDispatcherService);
    expect(await dispatcher.offers('interactive')).toEqual([]);
    expect(await dispatcher.offers('bulk')).toEqual([]);
  });

  it('lets the campaign role turn due campaign work into the same bulk queue', async () => {
    const planner = api.app.get(CampaignPlannerService);
    const pending = vi.spyOn(planner, 'pendingTenants').mockResolvedValueOnce([api.tenantId]);
    const planned = vi.spyOn(planner, 'plan').mockResolvedValueOnce(3);
    const result = await tickFor('worker-campaign', { app: api.app, concurrency: 2 })();
    expect(result).toMatchObject({ handled: 3, fairness: { offered: 0, achieved: 0 } });
    expect(pending).toHaveBeenCalledOnce();
    expect(planned).toHaveBeenCalledWith(api.tenantId, 8);
    pending.mockRestore();
    planned.mockRestore();
  });

  it('lets the report role drain only report export jobs', async () => {
    const exports = api.app.get(CampaignReportExportService);
    const pending = vi.spyOn(exports, 'pendingTenants').mockResolvedValueOnce([api.tenantId]);
    const processed = vi.spyOn(exports, 'process').mockResolvedValueOnce(2);
    const result = await tickFor('worker-report', { app: api.app, concurrency: 2 })();
    expect(result).toEqual({ handled: 2 });
    expect(pending).toHaveBeenCalledOnce();
    expect(processed).toHaveBeenCalledWith(api.tenantId, 2);
    pending.mockRestore();
    processed.mockRestore();
  });
});

describe('process roles', () => {
  it('accepts every declared role, and refuses anything else', () => {
    for (const role of PROCESS_ROLES) {
      expect(parseApiConfig(envFor(api.names, role)).processRole).toBe(role);
    }
    expect(() => parseApiConfig(envFor(api.names, 'worker-telepathy'))).toThrow(
      /CONVO_PROCESS_ROLE/,
    );
  });

  it('starts a worker role without binding a port', async () => {
    const worker = await startApi(envFor(api.names, 'worker-inbound'));
    try {
      const address = (worker.getHttpServer() as { address: () => unknown }).address();
      // A worker that listened would take a port on every host it runs on, for
      // a service it does not offer.
      expect(address).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('names the one role that cannot run without a broker', () => {
    // The integration worker exists to publish to one, so starting it without
    // a broker would be a process whose only job is impossible. Everything else
    // degrades instead: the outbox simply grows, visibly.
    expect(requiresBroker('worker-integration')).toBe(true);
    for (const role of PROCESS_ROLES.filter((entry) => entry !== 'worker-integration')) {
      expect(requiresBroker(role)).toBe(false);
    }
  });
});
