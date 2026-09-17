import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
  superuserPool,
} from '../support/scratch.js';
import { runLoad, type LoadResult, type Scenario } from './harness.js';
import { seedVolume } from './seed.js';

/**
 * The load run.
 *
 * It boots the real API on a real socket, seeds a realistic volume, and drives
 * it over HTTP with real cookies — not `server.inject`, which skips the socket,
 * the parser and the keep-alive handling that a load test exists to exercise.
 *
 * **What these numbers are.** Measurements of this application's query plans and
 * request handling, on this machine, against a local PostgreSQL. They are
 * directly useful for what they are good at: finding N+1 queries, missing
 * indexes, and endpoints whose cost grows with table size. A ranking of
 * endpoints by cost transfers to production; the absolute milliseconds do not.
 *
 * **What they are not.** A production capacity figure. Railway's CPU share, its
 * network hop between services, its managed PostgreSQL and its noisy neighbours
 * are all absent here, and the client is on the same machine as the server, so
 * network latency is zero. Any headline number taken from this file and
 * described as "supports N users" would be a fabrication.
 *
 * `docs/audit/LOAD_TEST_REPORT.md` states both halves of that.
 */

const BOOTSTRAP_TOKEN = 'load-test-bootstrap-token-0000000001';
const OWNER_PASSWORD = 'owner password for the load test run';

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Load Test',
    CONVO_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'load-test-hash-secret-000000000000001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'load-test-idempotency-secret-0000001',
    CONVO_API_HOST: '127.0.0.1',
    CONVO_API_PORT: '0',
    // Quiet: a line per request would make the log the bottleneck and would
    // measure stdout rather than the API.
    CONVO_LOG_LEVEL: 'error',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

export interface LoadReport {
  readonly measured_at: string;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly volume: Readonly<Record<string, number>>;
  readonly runs: readonly LoadResult[];
}

async function main(): Promise<LoadReport> {
  const conversations = Number(process.env['CONVO_LOAD_CONVERSATIONS'] ?? '10000');
  const messages = Number(process.env['CONVO_LOAD_MESSAGES'] ?? '5');
  const contacts = Number(process.env['CONVO_LOAD_CONTACTS'] ?? '10000');
  const durationMs = Number(process.env['CONVO_LOAD_DURATION_MS'] ?? '10000');
  const levels = (process.env['CONVO_LOAD_LEVELS'] ?? '10,25,50,100')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  process.stdout.write('[load] preparing database\n');
  const names = await createScratchDatabase('convo_load');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 20);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);

  const app: NestFastifyApplication = await createApiApplication(config, pool);
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const address = server.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(address.port)}`;

  const tenantId = await bootstrap(origin);
  const session = await signIn(origin);

  process.stdout.write(
    `[load] seeding ${String(conversations)} conversations, ${String(contacts)} contacts, ` +
      `${String(messages)} messages each\n`,
  );
  const admin = superuserPool(names.database, 2);
  const seeded = await seedVolume(pool, admin, tenantId, {
    conversations,
    messagesPerConversation: messages,
    contacts,
  });
  process.stdout.write(`[load] seeded in ${String(seeded.elapsedMs)}ms\n`);

  const scenarios = buildScenarios(origin, tenantId, session, seeded.conversationIds);
  const runs: LoadResult[] = [];

  for (const concurrency of levels) {
    process.stdout.write(`[load] concurrency ${String(concurrency)}\n`);
    const result = await runLoad(scenarios, { concurrency, durationMs });
    runs.push(result);
    process.stdout.write(
      `        ${String(result.totalRequests)} requests, ` +
        `${String(result.requestsPerSecond)} rps, ${String(result.errorRate)}% errors\n`,
    );
    for (const scenario of result.scenarios) {
      process.stdout.write(
        `        ${scenario.scenario.padEnd(22)} ` +
          `p50 ${String(scenario.p50).padStart(8)}ms  ` +
          `p95 ${String(scenario.p95).padStart(8)}ms  ` +
          `p99 ${String(scenario.p99).padStart(8)}ms  ` +
          `n=${String(scenario.samples)}  err=${String(scenario.errors)}\n`,
      );
    }
  }

  const report: LoadReport = {
    measured_at: new Date().toISOString(),
    environment: {
      note: 'Local developer machine. Client and server share a host, so network latency is zero. Not a production capacity measurement.',
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      postgres: 'embedded-postgres 17.4.0-beta.15, local socket',
    },
    volume: { conversations, contacts, messagesPerConversation: messages },
    runs,
  };
  const output = process.env['CONVO_LOAD_OUTPUT'] ?? 'docs/evidence/load-test-latest.json';
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[load] wrote ${output}\n`);

  await app.close();
  await pool.end().catch(() => undefined);
  await admin.end().catch(() => undefined);
  return report;
}

/**
 * The scenarios, weighted the way an operator's day is.
 *
 * An inbox is read far more than it is written, and the conversation list is
 * the screen an agent sits on. Weighting every endpoint equally would report a
 * mix nobody produces and would hide the cost of the one query that matters.
 */
function buildScenarios(
  origin: string,
  tenantId: string,
  session: Session,
  conversationIds: readonly string[],
): readonly Scenario[] {
  const headers = { cookie: session.cookie };
  let cursor = 0;
  const nextConversation = (): string => {
    cursor = (cursor + 1) % Math.max(1, conversationIds.length);
    return conversationIds[cursor] ?? '';
  };

  const get = async (path: string): Promise<number> => {
    const response = await fetch(`${origin}${path}`, { headers });
    // Draining the body matters: an undrained response holds the socket and
    // the next request in this virtual user pays for a new one.
    await response.arrayBuffer();
    return response.status;
  };

  return [
    { name: 'conversation-list', weight: 5, run: () => get(`/api/v1/tenants/${tenantId}/conversations`) },
    {
      name: 'conversation-open',
      weight: 3,
      run: () => get(`/api/v1/tenants/${tenantId}/conversations/${nextConversation()}`),
    },
    {
      name: 'message-timeline',
      weight: 3,
      run: () => get(`/api/v1/tenants/${tenantId}/conversations/${nextConversation()}/messages`),
    },
    { name: 'contact-search', weight: 2, run: () => get(`/api/v1/tenants/${tenantId}/contacts?q=nadia`) },
    { name: 'session-check', weight: 1, run: () => get('/api/v1/auth/session') },
    { name: 'readiness', weight: 1, run: () => get('/ready') },
  ];
}

async function bootstrap(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/instance/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bootstrap-token': BOOTSTRAP_TOKEN,
      'idempotency-key': 'load-bootstrap',
    },
    body: JSON.stringify({
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@load.test',
      ownerPassword: OWNER_PASSWORD,
    }),
  });
  if (!response.ok) {
    throw new Error(`bootstrap failed: ${String(response.status)} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { tenantId: string } };
  return body.data.tenantId;
}

async function signIn(origin: string): Promise<Session> {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@load.test', password: OWNER_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`login failed: ${String(response.status)}`);
  }
  const raw = response.headers.getSetCookie();
  const sessionCookie = raw.find((value) => value.startsWith('convo_session='))?.split(';')[0] ?? '';
  const csrfCookie = raw.find((value) => value.startsWith('convo_csrf='))?.split(';')[0] ?? '';
  return {
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrf: csrfCookie.slice('convo_csrf='.length),
  };
}



export { main as runLoadTest };
