import argon2 from 'argon2';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig, type ApiConfig } from '../../apps/api/src/config.js';
import { INSTALLATION_IDEMPOTENCY_CONTEXT_ID } from '../../apps/api/src/instance/instance.service.js';
import {
  asExecutor,
  enableInstallationContext,
  withTenant,
} from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'integration-bootstrap-token-value-000001';
const IDEMPOTENCY_SECRET = 'integration-idempotency-secret-value-001';

function bootstrapHeaders(idempotencyKey: string, requestId: string) {
  return {
    'x-bootstrap-token': BOOTSTRAP_TOKEN,
    'idempotency-key': idempotencyKey,
    'x-request-id': requestId,
  };
}

interface ApiHarness {
  readonly app: NestFastifyApplication;
  readonly server: FastifyInstance;
  readonly pool: Pool;
  readonly config: ApiConfig;
  readonly names: DatabaseNames;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Convo Local',
    CONVO_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    CONVO_DEFAULT_LOCALE: 'ar',
    CONVO_SUPPORTED_LOCALES: 'ar,en',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'integration-auth-hash-secret-value-0001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: IDEMPOTENCY_SECRET,
    CONVO_API_HOST: '127.0.0.1',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function harness(prefix: string, configured: boolean): Promise<ApiHarness> {
  const names = await createScratchDatabase(prefix);
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 6);
  const config = parseApiConfig(envFor(names));
  if (configured) {
    await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  }
  const app = await createApiApplication(config, pool);
  return {
    app,
    pool,
    config,
    names,
    server: app.getHttpAdapter().getInstance() as unknown as FastifyInstance,
  };
}

interface TestBody {
  readonly [key: string]: unknown;
  readonly bootstrapRequired?: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly request_id: string };
}

function body(response: LightMyRequestResponse): TestBody {
  return response.json() as TestBody;
}

const VALID_BOOTSTRAP = {
  companyName: 'Acme Support',
  companySlug: 'acme-support',
  ownerEmail: 'owner@acme.test',
  ownerPassword: 'a long local password',
};

describe('instance HTTP surface', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await harness('convo_api', true);
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('serves the sanitized pre-auth instance descriptor', async () => {
    const response = await api.server.inject({
      method: 'GET',
      url: '/api/v1/instance',
      headers: { 'x-request-id': 'descriptor-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('descriptor-1');
    expect(body(response)).toEqual({
      apiVersion: 'v1',
      deploymentMode: 'self_hosted_single',
      installationName: 'Convo Local',
      defaultLocale: 'ar',
      supportedLocales: ['ar', 'en'],
      bootstrapRequired: true,
      capabilities: {
        multiTenant: false,
        selfServiceSignup: false,
        ssoConfigured: false,
        mfaAvailable: true,
      },
    });
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain(api.names.runtimeRole);
    expect(response.body).not.toContain(api.config.secrets.bootstrapToken);
    expect(response.body).not.toContain(api.config.secrets.idempotencyHash);
  });

  it('returns the nested error envelope for a missing idempotency key', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'x-request-id': 'missing-key' },
      payload: VALID_BOOTSTRAP,
    });
    expect(response.statusCode).toBe(400);
    expect(body(response)).toEqual({
      error: {
        code: 'invalid_idempotency_key',
        message: 'A printable Idempotency-Key of 1-200 characters is required.',
        request_id: 'missing-key',
        details: [],
      },
    });
  });

  it('rejects missing and wrong bootstrap credentials with the same safe error', async () => {
    const missing = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: { 'idempotency-key': 'auth-missing', 'x-request-id': 'auth-missing' },
      payload: VALID_BOOTSTRAP,
    });
    const wrong = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: {
        'x-bootstrap-token': BOOTSTRAP_TOKEN + '-wrong',
        'idempotency-key': 'auth-wrong',
        'x-request-id': 'auth-wrong',
      },
      payload: VALID_BOOTSTRAP,
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(body(missing).error?.code).toBe('bootstrap_authentication_failed');
    expect(body(wrong).error?.code).toBe('bootstrap_authentication_failed');
    expect(body(missing).error?.message).toBe(body(wrong).error?.message);
  });

  it('stores and replays invalid input, then refuses key reuse with another body', async () => {
    const first = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: bootstrapHeaders('invalid-1', 'invalid-original'),
      payload: { ...VALID_BOOTSTRAP, ownerPassword: 'short' },
    });
    const replay = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: bootstrapHeaders('invalid-1', 'invalid-retry'),
      payload: {
        companyName: VALID_BOOTSTRAP.companyName,
        companySlug: VALID_BOOTSTRAP.companySlug,
        ownerEmail: VALID_BOOTSTRAP.ownerEmail,
        ownerPassword: 'short',
      },
    });
    const conflict = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: bootstrapHeaders('invalid-1', 'invalid-conflict'),
      payload: { ...VALID_BOOTSTRAP, ownerPassword: 'different but long password' },
    });

    expect(first.statusCode).toBe(400);
    expect(replay.statusCode).toBe(400);
    expect(body(replay)).toEqual(body(first));
    expect(replay.headers['x-request-id']).toBe('invalid-original');
    expect(conflict.statusCode).toBe(409);
    expect(body(conflict).error?.code).toBe('idempotency_key_reused');
    expect(body(conflict).error?.request_id).toBe('invalid-conflict');
  });

  it('serializes concurrent identical bootstrap requests to one effect and one result', async () => {
    const [first, second] = await Promise.all([
      api.server.inject({
        method: 'POST',
        url: '/api/v1/instance/bootstrap',
        headers: bootstrapHeaders('create-1', 'create-a'),
        payload: VALID_BOOTSTRAP,
      }),
      api.server.inject({
        method: 'POST',
        url: '/api/v1/instance/bootstrap',
        headers: bootstrapHeaders('create-1', 'create-b'),
        payload: {
          ownerEmail: VALID_BOOTSTRAP.ownerEmail,
          ownerPassword: VALID_BOOTSTRAP.ownerPassword,
          companySlug: VALID_BOOTSTRAP.companySlug,
          companyName: VALID_BOOTSTRAP.companyName,
        },
      }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(body(second)).toEqual(body(first));

    const created = body(first).data as {
      tenantId: string;
      ownerUserId: string;
    };
    const users = await api.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users',
    );
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(
      await argon2.verify(users.rows[0]?.password_hash ?? '', VALID_BOOTSTRAP.ownerPassword),
    ).toBe(true);

    await withTenant(api.pool, created.tenantId, async (client) => {
      const tenants = await client.query('SELECT id FROM tenants');
      expect(tenants.rows).toHaveLength(1);
    });
    const hiddenRecords = await withTenant(api.pool, created.tenantId, (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM idempotency_records',
      ),
    );
    expect(hiddenRecords.rows[0]?.count).toBe('0');
    const records = await withTenant(
      api.pool,
      INSTALLATION_IDEMPOTENCY_CONTEXT_ID,
      async (client) => {
        await enableInstallationContext(asExecutor(client));
        return client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM idempotency_records',
        );
      },
    );
    expect(records.rows[0]?.count).toBe('2');
  });

  it('maps later bootstrap attempts to 409 and replays that rejection', async () => {
    const first = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: bootstrapHeaders('already-1', 'already-original'),
      payload: { ...VALID_BOOTSTRAP, ownerEmail: 'another@acme.test' },
    });
    const replay = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: bootstrapHeaders('already-1', 'already-retry'),
      payload: { ...VALID_BOOTSTRAP, ownerEmail: 'another@acme.test' },
    });
    expect(first.statusCode).toBe(409);
    expect(body(first).error?.code).toBe('installation_already_bootstrapped');
    expect(body(replay)).toEqual(body(first));
    expect(replay.headers['x-request-id']).toBe('already-original');
  });

  it('reports bootstrap complete and envelopes framework failures', async () => {
    const descriptor = await api.server.inject({ method: 'GET', url: '/api/v1/instance' });
    expect(body(descriptor).bootstrapRequired).toBe(false);

    const missing = await api.server.inject({
      method: 'GET',
      url: '/api/v1/not-a-route',
      headers: { 'x-request-id': 'not-found-1' },
    });
    expect(missing.statusCode).toBe(404);
    expect(body(missing).error?.code).toBe('route_not_found');
    expect(body(missing).error?.request_id).toBe('not-found-1');

    const malformed = await api.server.inject({
      method: 'POST',
      url: '/api/v1/instance/bootstrap',
      headers: {
        'content-type': 'application/json',
        'x-bootstrap-token': BOOTSTRAP_TOKEN,
        'idempotency-key': 'malformed-json',
        'x-request-id': 'malformed-1',
      },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(body(malformed).error?.code).toBe('invalid_request');
    expect(body(malformed).error?.request_id).toBe('malformed-1');
  });
});

describe('unconfigured installation bootstrap', () => {
  it('maps the domain rejection to a retryable 503', async () => {
    const api = await harness('convo_api_unconfigured', false);
    try {
      const response = await api.server.inject({
        method: 'POST',
        url: '/api/v1/instance/bootstrap',
        headers: bootstrapHeaders('before-config', 'unconfigured-1'),
        payload: VALID_BOOTSTRAP,
      });
      expect(response.statusCode).toBe(503);
      expect(body(response).error?.code).toBe('installation_not_configured');
      expect(body(response).error?.request_id).toBe('unconfigured-1');
    } finally {
      await api.app.close();
    }
  }, 180_000);
});
