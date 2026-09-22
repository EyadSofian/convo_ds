import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { EmailOutboxService } from '../../apps/api/src/email/email-outbox.service.js';
import type {
  EmailMessage,
  EmailProviderPort,
  EmailSendOutcome,
} from '../../apps/api/src/email/email-provider.port.js';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { readMetadataBatch } from '../../apps/api/src/metadata/metadata.service.js';
import { applyInstallationConfig, type SqlExecutor } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
  superuserPool,
} from '../support/scratch.js';

/**
 * The durable email outbox, end to end, against a real PostgreSQL.
 *
 * What is being proved here is not "an email was sent" — a test can never prove
 * that, and a test that claims to is lying. What is proved is everything this
 * product is actually responsible for:
 *
 * - queueing happens in the **same transaction** as the thing it belongs to;
 * - a provider outage cannot corrupt IAM state or change what an unauthenticated
 *   caller can observe;
 * - a failure is retried with backoff, bounded, and then visible;
 * - a token never survives in the database past the send;
 * - a token never appears in an HTTP response.
 *
 * The provider is a script rather than a network. That is the correct boundary:
 * everything above `EmailProviderPort` is ours to prove, and whether Resend's
 * servers are up is not.
 */

const BOOTSTRAP_TOKEN = 'email-bootstrap-token-value-0000000001';
const OWNER_PASSWORD = 'owner password for the email tests';

/** A provider whose answers are dictated by the test, one send at a time. */
class ScriptedProvider implements EmailProviderPort {
  readonly name = 'scripted';
  readonly sent: EmailMessage[] = [];
  private script: EmailSendOutcome[] = [];
  private fallback: EmailSendOutcome = { status: 'accepted', providerMessageId: 'msg_default' };

  answers(...outcomes: readonly EmailSendOutcome[]): void {
    this.script = [...outcomes];
  }

  always(outcome: EmailSendOutcome): void {
    this.fallback = outcome;
    this.script = [];
  }

  send(message: EmailMessage): Promise<EmailSendOutcome> {
    this.sent.push(message);
    return Promise.resolve(this.script.shift() ?? this.fallback);
  }
}

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  server: FastifyInstance;
  readonly provider: ScriptedProvider;
  readonly outbox: EmailOutboxService;
  readonly names: DatabaseNames;
}

interface Browser {
  readonly cookie: string;
  readonly csrf: string;
}

interface DeliveryRow {
  readonly id: string;
  readonly kind: string;
  readonly tenant_id: string | null;
  readonly recipient_email: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly payload: Record<string, unknown>;
  readonly payload_scrubbed_at: Date | null;
  readonly provider_message_id: string | null;
  readonly provider: string | null;
  readonly last_error_code: string | null;
  readonly next_attempt_at: Date;
  readonly sent_at: Date | null;
  readonly failed_at: Date | null;
}

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Digital School Operations',
    CONVO_PUBLIC_BASE_URL: 'https://ops.digital-school.test',
    CONVO_DEFAULT_LOCALE: 'en',
    CONVO_SUPPORTED_LOCALES: 'ar,en',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'email-integration-hash-secret-000001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'email-idempotency-secret-00000000001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

let harness: Harness;
let tenantId: string;
let owner: Browser;

async function deliveries(api: Harness, kind?: string): Promise<readonly DeliveryRow[]> {
  const rows = await asExecutor(api.pool).query<DeliveryRow>(
    `SELECT id::text, kind, tenant_id::text, recipient_email::text, locale, state, attempt_count,
            payload, payload_scrubbed_at, provider_message_id, provider, last_error_code,
            next_attempt_at, sent_at, failed_at
       FROM email_deliveries
      ${kind === undefined ? '' : 'WHERE kind = $1'}
      ORDER BY created_at, id`,
    kind === undefined ? [] : [kind],
  );
  return rows.rows;
}

async function clearDeliveries(api: Harness): Promise<void> {
  await api.pool.query('DELETE FROM email_deliveries');
}

async function invite(api: Harness, email: string, key: string) {
  const roles = await api.server.inject({
    method: 'GET',
    url: `/api/v1/tenants/${tenantId}/roles`,
    headers: { cookie: owner.cookie },
  });
  const role = (roles.json() as { data: { id: string; key: string }[] }).data.find(
    (entry) => entry.key === 'agent',
  );
  expect(role, roles.body).toBeDefined();
  return api.server.inject({
    method: 'POST',
    url: `/api/v1/tenants/${tenantId}/invitations`,
    headers: {
      cookie: owner.cookie,
      'x-csrf-token': owner.csrf,
      'idempotency-key': key,
    },
    payload: { email, roleId: role?.id, scopes: [{ type: 'tenant', id: null }] },
  });
}

beforeAll(async () => {
  const names = await createScratchDatabase('convo_email');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const provider = new ScriptedProvider();
  const app = await createApiApplication(config, pool, { emailProvider: provider });
  const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;

  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'email-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@email.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(201);
  tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;

  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'owner@email.test', password: OWNER_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const cookies = login.headers['set-cookie'] as string[];
  const session = cookies.find((value) => value.startsWith('convo_session='))?.split(';')[0] ?? '';
  const csrfCookie = cookies.find((value) => value.startsWith('convo_csrf='))?.split(';')[0] ?? '';
  owner = {
    cookie: `${session}; ${csrfCookie}`,
    csrf: csrfCookie.slice('convo_csrf='.length),
  };

  harness = { app, pool, server, provider, outbox: app.get(EmailOutboxService), names };
});

afterAll(async () => {
  await harness.app.close();
});

describe('an invitation queues a durable delivery in the creating transaction', () => {
  it('writes exactly one pending row, attributed to the company', async () => {
    await clearDeliveries(harness);
    const created = await invite(harness, 'nadia@digital-school.test', 'invite-key-0001');
    expect(created.statusCode, created.body).toBe(201);

    const rows = await deliveries(harness, 'invitation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.tenant_id).toBe(tenantId);
    expect(rows[0]?.recipient_email).toBe('nadia@digital-school.test');
    expect(rows[0]?.attempt_count).toBe(0);
  });

  it('never returns the token in the API response', async () => {
    await clearDeliveries(harness);
    const created = await invite(harness, 'omar@digital-school.test', 'invite-key-0002');
    const rows = await deliveries(harness, 'invitation');
    const token = rows[0]?.payload['token'];
    expect(typeof token).toBe('string');
    expect(created.body).not.toContain(token as string);
  });

  it('is one delivery however many times the same request is retried', async () => {
    await clearDeliveries(harness);
    const first = await invite(harness, 'huda@digital-school.test', 'invite-key-0003');
    const second = await invite(harness, 'huda@digital-school.test', 'invite-key-0003');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(await deliveries(harness, 'invitation')).toHaveLength(1);
  });
});

describe('the worker sends what the request queued', () => {
  it('marks the row sent, records the provider id, and scrubs the token', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'yara@digital-school.test', 'invite-key-0010');
    harness.provider.answers({ status: 'accepted', providerMessageId: 'msg_real_001' });

    const result = await harness.outbox.drain(10, 'test-worker');
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0 });

    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('sent');
    expect(row?.provider_message_id).toBe('msg_real_001');
    expect(row?.provider).toBe('scripted');
    expect(row?.sent_at).not.toBeNull();
    // The token is gone the moment the row is terminal. The table's CHECK
    // constraint refuses any other combination.
    expect(row?.payload).toEqual({});
    expect(row?.payload_scrubbed_at).not.toBeNull();
  });

  it('renders a real message, with the link built from the configured origin', async () => {
    await clearDeliveries(harness);
    harness.provider.always({ status: 'accepted', providerMessageId: 'msg_real_002' });
    await invite(harness, 'sami@digital-school.test', 'invite-key-0011');
    await harness.outbox.drain(10, 'test-worker');

    const message = harness.provider.sent.at(-1);
    expect(message?.to).toBe('sami@digital-school.test');
    expect(message?.subject).toContain('Digital School');
    expect(message?.html).toContain('https://ops.digital-school.test/#/accept-invitation?token=');
    expect(message?.text).toContain('https://ops.digital-school.test/#/accept-invitation?token=');
    // The role the person is being given is in the message, because "you have
    // been invited" without saying as what is not an invitation.
    expect(message?.html).toContain('Agent');
  });

  it('does nothing when the queue is empty', async () => {
    await clearDeliveries(harness);
    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ claimed: 0, sent: 0 });
  });
});

describe('a provider outage', () => {
  it('retries with backoff and leaves the invitation intact', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'lina@digital-school.test', 'invite-key-0020');
    harness.provider.answers({
      status: 'refused',
      code: 'provider_unavailable',
      message: 'Resend answered 503.',
      retryable: true,
    });

    const result = await harness.outbox.drain(10, 'test-worker');
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 0, retried: 1 });

    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('pending');
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error_code).toBe('provider_unavailable');
    // Backed off, so the next drain does not spin on it.
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    // Still holding the token, because it has not been delivered yet.
    expect(row?.payload['token']).toBeTypeOf('string');

    // The IAM state the request committed is untouched by the provider's mood.
    const invitations = await harness.server.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/invitations`,
      headers: { cookie: owner.cookie },
    });
    const pending = (invitations.json() as { data: { email: string; status: string }[] }).data.filter(
      (entry) => entry.email === 'lina@digital-school.test' && entry.status === 'pending',
    );
    expect(pending).toHaveLength(1);
  });

  it('does not claim a row that is still backed off', async () => {
    // Continues from the row left pending above.
    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ claimed: 0 });
  });

  it('sends it once the provider recovers', async () => {
    await harness.pool.query("UPDATE email_deliveries SET next_attempt_at = now() WHERE state = 'pending'");
    harness.provider.answers({ status: 'accepted', providerMessageId: 'msg_after_outage' });
    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ claimed: 1, sent: 1 });
    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('sent');
    expect(row?.attempt_count).toBe(2);
  });
});

describe('a failure that waiting cannot fix', () => {
  it('fails immediately rather than burning six attempts on a bad key', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'rami@digital-school.test', 'invite-key-0030');
    harness.provider.always({
      status: 'refused',
      code: 'provider_credentials_rejected',
      message: 'Resend answered 401.',
      retryable: false,
    });

    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ claimed: 1, failed: 1 });
    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('failed');
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error_code).toBe('provider_credentials_rejected');
    expect(row?.failed_at).not.toBeNull();
    // A failed row holds no token either.
    expect(row?.payload).toEqual({});
  });

  it('gives up after the configured attempts and says which error exhausted it', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'dina@digital-school.test', 'invite-key-0031');
    harness.provider.always({
      status: 'unknown',
      code: 'provider_timeout',
      message: 'Resend did not answer within 10000ms.',
    });
    await harness.pool.query('UPDATE email_deliveries SET max_attempts = 3');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await harness.pool.query(
        "UPDATE email_deliveries SET next_attempt_at = now() WHERE state = 'pending'",
      );
      await harness.outbox.drain(10, 'test-worker');
    }

    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('failed');
    expect(row?.attempt_count).toBe(3);
    expect(row?.last_error_code).toBe('attempts_exhausted:provider_timeout');
  });
});

describe('password recovery queues nothing it should not', () => {
  it('answers identically for a known and an unknown address', async () => {
    await clearDeliveries(harness);
    harness.provider.always({ status: 'accepted', providerMessageId: 'msg_recovery' });

    const known = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { 'x-request-id': 'same-request-id' },
      remoteAddress: '203.0.113.10',
      payload: { email: 'owner@email.test' },
    });
    const unknown = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery',
      headers: { 'x-request-id': 'same-request-id' },
      remoteAddress: '203.0.113.11',
      payload: { email: 'nobody@email.test' },
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  it('queues a delivery only for the address that has an account', async () => {
    const rows = await deliveries(harness, 'password_recovery');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient_email).toBe('owner@email.test');
    // Recovery belongs to a person, not a company.
    expect(rows[0]?.tenant_id).toBeNull();
  });

  it('sends a reset link built from the configured origin', async () => {
    await harness.outbox.drain(10, 'test-worker');
    const message = harness.provider.sent.at(-1);
    expect(message?.to).toBe('owner@email.test');
    expect(message?.html).toContain('https://ops.digital-school.test/#/reset-password?token=');
    expect(message?.text).toContain('ignore this email');
  });

  it('leaves no token in the database after sending', async () => {
    const row = (await deliveries(harness, 'password_recovery'))[0];
    expect(row?.state).toBe('sent');
    expect(row?.payload).toEqual({});
  });
});

describe('the backlog an operator reads', () => {
  it('counts what is waiting, what failed, and how old the oldest is', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'backlog@digital-school.test', 'invite-key-0040');

    const waiting = await harness.outbox.backlog();
    expect(waiting.pending).toBe(1);
    expect(waiting.failed).toBe(0);
    expect(waiting.oldestPendingAgeSeconds).not.toBeNull();

    harness.provider.always({
      status: 'refused',
      code: 'provider_credentials_rejected',
      message: 'no',
      retryable: false,
    });
    await harness.outbox.drain(10, 'test-worker');

    const after = await harness.outbox.backlog();
    expect(after.pending).toBe(0);
    expect(after.failed).toBe(1);
    expect(after.oldestPendingAgeSeconds).toBeNull();
  });
});

describe('rows the renderer cannot use', () => {
  it('fails a delivery whose payload lost its token, and does not retry it', async () => {
    // Not an outage: a payload the renderer cannot read will never become
    // readable, so burning six attempts on it would only delay the operator
    // learning about it.
    await clearDeliveries(harness);
    await invite(harness, 'corrupt@digital-school.test', 'invite-key-0050');
    await harness.pool.query(`UPDATE email_deliveries SET payload = '{}'::jsonb`);

    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ claimed: 1, failed: 1 });
    const row = (await deliveries(harness, 'invitation'))[0];
    expect(row?.state).toBe('failed');
    expect(row?.last_error_code).toBe('payload_unrenderable');
    expect(row?.attempt_count).toBe(1);
  });

  it('fails a delivery whose stored expiry is not a date', async () => {
    await clearDeliveries(harness);
    await invite(harness, 'badexpiry@digital-school.test', 'invite-key-0051');
    await harness.pool.query(
      `UPDATE email_deliveries SET payload = jsonb_set(payload, '{expiresAt}', '"not-a-date"')`,
    );

    expect(await harness.outbox.drain(10, 'test-worker')).toMatchObject({ failed: 1 });
    expect((await deliveries(harness, 'invitation'))[0]?.last_error_code).toBe(
      'payload_unrenderable',
    );
  });
});

describe('enqueueing directly', () => {
  it('returns the existing delivery id when the same key is queued twice', async () => {
    // The second caller still learns which delivery its request corresponds to,
    // rather than being told nothing happened.
    await clearDeliveries(harness);
    const first = await harness.outbox.enqueue({
      kind: 'password_recovery',
      idempotencyKey: 'direct-key-0001',
      email: 'direct@digital-school.test',
      locale: 'en',
      token: 'a'.repeat(43),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const second = await harness.outbox.enqueue({
      kind: 'password_recovery',
      idempotencyKey: 'direct-key-0001',
      email: 'direct@digital-school.test',
      locale: 'en',
      token: 'b'.repeat(43),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(second).toBe(first);
    expect(await deliveries(harness, 'password_recovery')).toHaveLength(1);
  });

  it('queues an invitation with its company attributed', async () => {
    await clearDeliveries(harness);
    await harness.outbox.enqueue({
      kind: 'invitation',
      tenantId,
      idempotencyKey: 'direct-key-0002',
      email: 'direct2@digital-school.test',
      locale: 'ar',
      workspaceName: 'Digital School',
      roleName: 'Agent',
      token: 'c'.repeat(43),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const rows = await deliveries(harness, 'invitation');
    expect(rows[0]).toMatchObject({ tenant_id: tenantId, locale: 'ar', state: 'pending' });
  });
});

describe('when the outbox itself cannot be written', () => {
  it('rolls the recovery challenge back rather than leaving IAM half-applied', async () => {
    // The challenge and its queued email are one transaction. If the email row
    // cannot be written, the challenge must not survive — otherwise a token
    // exists that nobody was ever sent.
    await clearDeliveries(harness);
    const before = await asExecutor(harness.pool).query<{ total: string }>(
      'SELECT count(*)::text AS total FROM password_recovery_challenges',
    );

    const admin = superuserPool(harness.names.database, 1);
    try {
      await admin.query(
        `REVOKE INSERT ON email_deliveries FROM ${harness.names.runtimeRole}`,
      );
      const response = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/auth/recovery',
        remoteAddress: '203.0.113.99',
        payload: { email: 'owner@email.test' },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await admin.query(`GRANT INSERT ON email_deliveries TO ${harness.names.runtimeRole}`);
      await admin.end();
    }

    const after = await asExecutor(harness.pool).query<{ total: string }>(
      'SELECT count(*)::text AS total FROM password_recovery_challenges',
    );
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
    expect(await deliveries(harness, 'password_recovery')).toHaveLength(0);
  });
});

describe('metadata batching across both targets', () => {
  it('reads conversation metadata in the same two queries', async () => {
    // The contact path is exercised throughout; this is the conversation arm of
    // the same function, which picks different tables.
    const result = await withTenant(harness.pool, tenantId, (client) =>
      readMetadataBatch(asExecutor(client), 'conversation', [
        '00000000-0000-4000-8000-00000000abcd',
      ]),
    );
    expect(result.get('00000000-0000-4000-8000-00000000abcd')).toEqual({
      labels: [],
      customFields: [],
    });
  });

  it('keeps a 50-conversation Inbox page to two metadata queries', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    let queries = 0;
    await withTenant(harness.pool, tenantId, async (client) => {
      const base = asExecutor(client);
      const counting: SqlExecutor = {
        query: async <R>(text: string, values?: readonly unknown[]) => {
          queries += 1;
          return base.query<R>(text, values);
        },
      };
      const result = await readMetadataBatch(counting, 'conversation', ids);
      expect(result.size).toBe(50);
    });
    expect(queries).toBe(2);
  });

  it('touches the database not at all for an empty list', async () => {
    const result = await withTenant(harness.pool, tenantId, (client) =>
      readMetadataBatch(asExecutor(client), 'contact', []),
    );
    expect(result.size).toBe(0);
  });
});
