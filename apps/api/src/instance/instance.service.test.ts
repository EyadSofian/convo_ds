import type { SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config.js';
import type { IdempotencyService, StoredHttpResponse } from '../idempotency/idempotency.service.js';
import type { PasswordHasher } from '../tokens.js';
import { InstanceService, responseRequestId } from './instance.service.js';

const CONFIG = {
  deploymentMode: 'saas',
  installationName: 'Test',
  publicBaseUrl: 'https://example.test',
  defaultLocale: 'ar',
  supportedLocales: ['ar', 'en'],
  ssoConfigured: false,
  mfaAvailable: true,
  processRole: 'api',
  secrets: {
    authHash: 'auth-hash-secret-test-value-00000001',
    bootstrapToken: 'bootstrap-token-test-value-00000001',
    idempotencyHash: 'idempotency-secret-test-value-000001',
    credentialKeys: [],
  },
  channelSecrets: {},
  workerConcurrency: 4,
  host: '127.0.0.1',
  port: 0,
  database: {
    host: '127.0.0.1',
    port: 5432,
    name: 'convo',
    user: 'convo_app',
    password: 'secret',
  },
} as const satisfies ApiConfig;

describe('InstanceService defensive mappings', () => {
  it('maps a domain invalid_input rejection to HTTP 400', async () => {
    const hasher: PasswordHasher = {
      hash: () => Promise.resolve('not-a-supported-password-hash'),
      verify: () => Promise.resolve(false),
    };
    const fakeSql: SqlExecutor = {
      async query<R>() {
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    const idempotency = {
      execute: async (
        _command: unknown,
        work: (sql: SqlExecutor) => Promise<StoredHttpResponse>,
      ) => ({
        status: 'completed' as const,
        replayed: false,
        response: await work(fakeSql),
      }),
    } as unknown as IdempotencyService;
    const service = new InstanceService(
      CONFIG,
      {} as Pool,
      hasher,
      idempotency,
    );

    const response = await service.bootstrap(
      {
        companyName: 'Acme',
        companySlug: 'acme',
        ownerEmail: 'owner@acme.test',
        ownerPassword: 'a sufficiently long password',
      },
      CONFIG.secrets.bootstrapToken,
      'key',
      'request-1',
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'invalid_input', request_id: 'request-1' },
    });
  });

  it('generates a response id only for an impossible malformed stored body', () => {
    expect(responseRequestId({ statusCode: 200, body: {} })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
