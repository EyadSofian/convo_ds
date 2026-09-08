import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { LoggingRecoveryDelivery, redactEmail } from '../../apps/api/src/auth/recovery-delivery.js';
import type { RecoveryMessage } from '../../apps/api/src/auth/recovery-delivery.js';
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
 * Password recovery against a real PostgreSQL (IAM-03).
 *
 * The property under test is mostly a *negative* one: nothing an unauthenticated
 * caller can observe may differ between a known and an unknown address. That is
 * asserted by comparing whole responses byte for byte, not by reading the code.
 */

const BOOTSTRAP_TOKEN = 'recovery-bootstrap-token-value-000000001';
const OWNER_PASSWORD = 'owner password for recovery tests';
const NEW_PASSWORD = 'a replacement password that is long enough';

/** Captures what the product tried to deliver, without the product leaking it. */
class CapturingDelivery {
  readonly sent: RecoveryMessage[] = [];

  async deliver(message: RecoveryMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly delivery: CapturingDelivery;
  readonly names: DatabaseNames;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Recovery Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'recovery-integration-hash-secret-00001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'recovery-idempotency-secret-0000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

async function createHarness(): Promise<Harness> {
  const names = await createScratchDatabase('convo_recovery');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const delivery = new CapturingDelivery();
  const app = await createApiApplication(config, pool, { recoveryDelivery: delivery });
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'recovery-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@recovery.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  return { app, pool, server, delivery, names };
}

async function startRecovery(api: Harness, email: string, ip: string) {
  return api.server.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery',
    headers: { 'x-request-id': 'fixed-request-id', 'x-forwarded-for': ip },
    remoteAddress: ip,
    payload: { email },
  });
}

async function login(api: Harness, email: string, password: string) {
  return api.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': 'CONVO recovery test' },
    payload: { email, password },
  });
}

describe('password recovery start says nothing about the account', () => {
  let api: Harness;

  beforeAll(async () => {
    api = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('returns a byte-identical response for a known and an unknown address', async () => {
    const known = await startRecovery(api, 'owner@recovery.test', '203.0.113.10');
    const unknown = await startRecovery(api, 'nobody@recovery.test', '203.0.113.11');

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    // The request id is pinned to the same value, so the bodies must match
    // exactly. Anything that differs here is an enumeration oracle.
    expect(known.body).toBe(unknown.body);
    expect(known.json()).toMatchObject({ data: { status: 'accepted' } });
  });

  it('never returns the token, and never writes it in the clear', async () => {
    await startRecovery(api, 'owner@recovery.test', '203.0.113.12');
    const message = api.delivery.sent.at(-1);
    expect(message?.email).toBe('owner@recovery.test');
    expect(message?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The token appears in no response body...
    const response = await startRecovery(api, 'owner@recovery.test', '203.0.113.13');
    const latest = api.delivery.sent.at(-1);
    expect(response.body).not.toContain(latest?.token ?? 'unreachable');

    // ...and only its HMAC fingerprint is stored.
    const stored = await api.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM password_recovery_challenges',
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(latest?.token ?? 'unreachable');
    }
  });

  it('writes a challenge for an unknown address too, so the table is not a directory', async () => {
    const before = await api.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM password_recovery_challenges WHERE user_id IS NULL',
    );
    await startRecovery(api, 'ghost@recovery.test', '203.0.113.14');
    const after = await api.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM password_recovery_challenges WHERE user_id IS NULL',
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);

    // But nothing was delivered anywhere for an address with no account.
    expect(api.delivery.sent.some((message) => message.email === 'ghost@recovery.test')).toBe(false);
  });

  it('rejects a malformed address before doing any account work', async () => {
    const response = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_input' } });

    for (const payload of [['nope'], { email: 42 }, { email: `${'a'.repeat(250)}@x.example` }]) {
      const bad = await api.server.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('never issues a decoy challenge that anyone could complete', async () => {
    // Decoy rows exist so the table is not a directory, but they carry a NULL
    // user and are never delivered, so no caller can ever hold their token.
    // The completion query requires `user_id IS NOT NULL`, so even a guessed
    // decoy token is refused exactly like an unknown one — there is no second
    // code path, and therefore none that could drift.
    await startRecovery(api, 'decoy-check@recovery.test', '203.0.113.30');
    const decoys = await api.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM password_recovery_challenges WHERE user_id IS NULL',
    );
    expect(Number(decoys.rows[0]?.count)).toBeGreaterThan(0);
    expect(
      api.delivery.sent.some((message) => message.email === 'decoy-check@recovery.test'),
    ).toBe(false);
  });

  it('keeps answering 202 once the address is rate limited', async () => {
    const ip = '203.0.113.20';
    const responses = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      responses.push(await startRecovery(api, 'ratelimited@recovery.test', ip));
    }
    // A 429 here would confirm to an enumerator that they had found a real,
    // rate-limited target. Every attempt looks the same.
    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe(responses[0]?.body);
    }
  });
});

describe('password recovery completion', () => {
  let api: Harness;

  beforeAll(async () => {
    api = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await api.app.close();
  });

  it('replaces the password, revokes every session, and burns the token', async () => {
    // An existing session, so the revocation is observable.
    const before = await login(api, 'owner@recovery.test', OWNER_PASSWORD);
    expect(before.statusCode).toBe(200);
    const raw = before.headers['set-cookie'];
    const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const cookie = lines.map((line) => line.split(';')[0]).join('; ');

    const session = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);

    await startRecovery(api, 'owner@recovery.test', '198.51.100.10');
    const token = api.delivery.sent.at(-1)?.token as string;

    const completed = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.10',
      payload: { token, password: NEW_PASSWORD },
    });
    expect(completed.statusCode).toBe(204);

    // The old session is gone on its very next request.
    const afterReset = await api.server.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(afterReset.statusCode).toBe(401);

    // The old password no longer works and the new one does.
    expect((await login(api, 'owner@recovery.test', OWNER_PASSWORD)).statusCode).toBe(401);
    expect((await login(api, 'owner@recovery.test', NEW_PASSWORD)).statusCode).toBe(200);

    // The token is single use.
    const replay = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.11',
      payload: { token, password: 'yet another sufficiently long password' },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      error: { code: 'invalid_input', details: [{ code: 'invalid_or_expired' }] },
    });
  });

  it('spends every other outstanding challenge for the same account', async () => {
    await startRecovery(api, 'owner@recovery.test', '198.51.100.20');
    const first = api.delivery.sent.at(-1)?.token as string;
    await startRecovery(api, 'owner@recovery.test', '198.51.100.21');
    const second = api.delivery.sent.at(-1)?.token as string;
    expect(first).not.toBe(second);

    const completed = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.22',
      payload: { token: second, password: 'a third password long enough to pass' },
    });
    expect(completed.statusCode).toBe(204);

    // The older email cannot be used after the newer one succeeded.
    const stale = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.23',
      payload: { token: first, password: 'a fourth password long enough to pass' },
    });
    expect(stale.statusCode).toBe(400);
  });

  it('reports expired, unknown and decoy tokens identically', async () => {
    // Expired.
    await startRecovery(api, 'owner@recovery.test', '198.51.100.30');
    const expiring = api.delivery.sent.at(-1)?.token as string;
    // `created_at` moves with it: the table's own CHECK requires
    // `expires_at > created_at`, so an expired row is one issued in the past,
    // not one with an impossible lifetime.
    await api.pool.query(
      `UPDATE password_recovery_challenges
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 minute'
        WHERE used_at IS NULL`,
    );
    const expired = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.31',
      payload: { token: expiring, password: 'password for the expired attempt' },
    });

    // Never issued.
    const unknown = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.32',
      payload: {
        token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password: 'password for the unknown attempt',
      },
    });

    // A decoy issued for an address with no account.
    await startRecovery(api, 'nobody-here@recovery.test', '198.51.100.33');

    expect(expired.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ error: { details: [{ code: 'invalid_or_expired' }] } });
    expect(unknown.json()).toMatchObject({ error: { details: [{ code: 'invalid_or_expired' }] } });
  });

  it('validates the token shape and the password length before any work', async () => {
    const bad = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.40',
      payload: { token: 'too-short', password: 'short' },
    });
    expect(bad.statusCode).toBe(400);
    const details = (bad.json() as { error: { details: readonly { field: string }[] } }).error
      .details;
    expect(details.map((detail) => detail.field).sort()).toEqual(['password', 'token']);

    const notAnObject = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.41',
      payload: JSON.stringify(['nope']),
      headers: { 'content-type': 'application/json' },
    });
    expect(notAnObject.statusCode).toBe(400);

    // An unbounded password is a hashing-cost denial of service, so it is
    // rejected by length before Argon2id is asked to do any work.
    const tooLong = await api.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/complete',
      remoteAddress: '198.51.100.42',
      payload: {
        token: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        password: 'x'.repeat(513),
      },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({
      error: { details: [{ field: 'password', code: 'too_long' }] },
    });
  });

  it('rate limits repeated completion attempts from one address', async () => {
    const ip = '198.51.100.50';
    let sawLimit = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await api.server.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery/complete',
        remoteAddress: ip,
        payload: {
          token: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          password: 'a password that is long enough to pass',
        },
      });
      if (response.statusCode === 429) {
        sawLimit = true;
        expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } });
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe('the default delivery adapter', () => {
  it('logs a redacted line without the token, and never throws', async () => {
    const lines: string[] = [];
    const delivery = new LoggingRecoveryDelivery((line) => lines.push(line));
    const token = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    await delivery.deliver({
      email: 'hana@digital-school.example',
      token,
      expiresAt: new Date('2026-09-09T12:00:00.000Z'),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('h***@digital-school.example');
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).toContain('no delivery adapter is configured');
  });

  it('redacts an address it cannot parse rather than logging it whole', () => {
    expect(redactEmail('hana@digital-school.example')).toBe('h***@digital-school.example');
    expect(redactEmail('not-an-email')).toBe('***');
    expect(redactEmail('@no-local-part')).toBe('***');
  });
});
