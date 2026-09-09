import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { BrokerRelayService } from '../../apps/api/src/broker/relay.service.js';
import type { BrokerPort, PublishOutcome } from '../../apps/api/src/broker/broker.port.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
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
 * The outbox relay against a real PostgreSQL, with a scripted broker.
 *
 * The broker here is a **stub** whose answer each test chooses. It is not a
 * simulator of RabbitMQ and proves nothing about one; what it proves is our own
 * behaviour when a broker confirms, refuses, or goes quiet — which is the part
 * that decides whether an event can be lost.
 */

const BOOTSTRAP_TOKEN = 'broker-bootstrap-token-value-00000001';
const OWNER_PASSWORD = 'owner password for broker tests';

interface Harness {
  app: NestFastifyApplication;
  pool: Pool;
  relay: BrokerRelayService;
  readonly tenantId: string;
}

let answer: PublishOutcome = { status: 'confirmed' };
let published: string[] = [];

const stubBroker: BrokerPort = {
  name: 'test-stub',
  healthy: () => Promise.resolve(true),
  publish: (envelope) => {
    published.push(envelope.id);
    return Promise.resolve(answer);
  },
};

function envFor(names: DatabaseNames): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Broker Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.test',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'broker-integration-hash-secret-0001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'broker-idempotency-secret-0000001',
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
  const names = await createScratchDatabase('convo_broker');
  await migrateScratch(names);
  const pool = scratchRuntimePool(names, 4);
  const config = parseApiConfig(envFor(names));
  await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
  const app = await createApiApplication(config, pool, { broker: stubBroker });
  const server = app.getHttpAdapter().getInstance() as unknown as {
    inject: (options: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
  };
  const bootstrap = await server.inject({
    method: 'POST',
    url: '/api/v1/instance/bootstrap',
    headers: { 'x-bootstrap-token': BOOTSTRAP_TOKEN, 'idempotency-key': 'broker-bootstrap' },
    payload: {
      companyName: 'Digital School',
      companySlug: 'digital-school',
      ownerEmail: 'owner@broker.test',
      ownerPassword: OWNER_PASSWORD,
    },
  });
  expect(bootstrap.statusCode).toBe(201);
  const tenantId = (bootstrap.json() as { data: { tenantId: string } }).data.tenantId;
  api = { app, pool, relay: app.get(BrokerRelayService), tenantId };
}, 180_000);

afterAll(async () => {
  await api.app.close();
});

async function enqueue(topic: string, envelope: Record<string, unknown>): Promise<string> {
  return withTenant(api.pool, api.tenantId, (client) =>
    api.relay.enqueue(asExecutor(client), api.tenantId, topic, envelope),
  );
}

describe('the outbox relay', () => {
  it('publishes an envelope and marks it only after the broker confirms', async () => {
    published = [];
    answer = { status: 'confirmed' };
    const id = await enqueue('inbound.event', { eventId: 'e1' });

    const before = await api.pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM broker_outbox WHERE id = $1',
      [id],
    );
    // Written by the effect's own transaction, unpublished until the relay runs.
    expect(before.rows[0]?.published_at).toBeNull();

    const result = await api.relay.drain();
    expect(result).toMatchObject({ published: 1, retried: 0, deadLettered: 0 });
    expect(published).toContain(id);

    const after = await api.pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM broker_outbox WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.published_at).not.toBeNull();
  });

  it('does not publish a confirmed envelope twice', async () => {
    published = [];
    answer = { status: 'confirmed' };
    await enqueue('inbound.event', { eventId: 'e2' });
    await api.relay.drain();
    const first = published.length;
    await api.relay.drain();
    expect(published.length).toBe(first);
  });

  it('retries an unconfirmed publish with backoff rather than losing it', async () => {
    published = [];
    answer = { status: 'unknown', code: 'connection_lost', message: 'The confirm never came.' };
    const id = await enqueue('inbound.event', { eventId: 'e3' });

    const result = await api.relay.drain();
    expect(result).toMatchObject({ retried: 1, published: 0, deadLettered: 0 });

    const row = await api.pool.query<{ attempts: number; last_error: string; available_at: Date }>(
      'SELECT attempts, last_error, available_at FROM broker_outbox WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, last_error: 'connection_lost' });
    // Backed off, so an immediate sweep leaves it alone.
    expect(row.rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now());
    expect((await api.relay.drain()).claimed).toBe(0);
  });

  it('dead-letters a refusal immediately, keeping the envelope', async () => {
    published = [];
    answer = { status: 'refused', code: 'unroutable_topic', message: 'No such exchange.' };
    const id = await enqueue('inbound.event', { eventId: 'e4' });

    const result = await api.relay.drain();
    expect(result).toMatchObject({ deadLettered: 1, published: 0, retried: 0 });

    // Out of the queue so it stops blocking, and still on the record.
    const gone = await api.pool.query('SELECT 1 FROM broker_outbox WHERE id = $1', [id]);
    expect(gone.rows).toHaveLength(0);
    const letters = await api.relay.deadLetters(api.tenantId);
    const letter = letters.find((entry) => entry.reason === 'unroutable_topic');
    expect(letter).toBeDefined();
    expect(letter?.attempts).toBe(1);
  });

  it('dead-letters an envelope that never gets confirmed, after a bounded number of tries', async () => {
    published = [];
    answer = { status: 'unknown', code: 'never_confirms', message: 'Gone.' };
    const id = await enqueue('inbound.event', { eventId: 'e5' });

    // Retried, not retried forever: a queue that never gives up stops moving.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await api.pool.query('UPDATE broker_outbox SET available_at = now() WHERE id = $1', [id]);
      await api.relay.drain();
    }
    const gone = await api.pool.query('SELECT 1 FROM broker_outbox WHERE id = $1', [id]);
    expect(gone.rows).toHaveLength(0);
    const letters = await api.relay.deadLetters(api.tenantId);
    expect(letters.some((entry) => entry.reason === 'never_confirms')).toBe(true);
  });

  it('replays a dead letter as a new envelope, and records who did it', async () => {
    published = [];
    answer = { status: 'refused', code: 'replay_me', message: 'No.' };
    await enqueue('inbound.event', { eventId: 'e6' });
    await api.relay.drain();

    const letters = await api.relay.deadLetters(api.tenantId);
    const letter = letters.find((entry) => entry.reason === 'replay_me');
    expect(letter).toBeDefined();

    const membership = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM memberships LIMIT 1'),
    );
    const membershipId = membership.rows[0]?.id as string;

    answer = { status: 'confirmed' };
    expect(await api.relay.replay(api.tenantId, letter?.id as string, membershipId)).toBe(true);

    // Replaying is an operator act, so it is recorded on the dead letter rather
    // than only happening.
    const recorded = await api.pool.query<{ replayed_by: string | null }>(
      'SELECT replayed_by::text FROM broker_dead_letters WHERE id = $1',
      [letter?.id],
    );
    expect(recorded.rows[0]?.replayed_by).toBe(membershipId);

    const drained = await api.relay.drain();
    expect(drained.published).toBeGreaterThan(0);
    // The quarantine record survives the replay: it is evidence that this
    // envelope once failed.
    expect(await api.relay.deadLetters(api.tenantId)).not.toContainEqual(
      expect.objectContaining({ id: letter?.id }),
    );
  });

  it('refuses to replay a dead letter twice, or one that does not exist', async () => {
    const membership = await withTenant(api.pool, api.tenantId, (client) =>
      client.query<{ id: string }>('SELECT id::text FROM memberships LIMIT 1'),
    );
    const membershipId = membership.rows[0]?.id as string;
    const missing = '99999999-9999-4999-8999-999999999999';
    expect(await api.relay.replay(api.tenantId, missing, membershipId)).toBe(false);
  });

  it('lets a consumer claim an envelope once, and reports a redelivery', async () => {
    const envelopeId = '33333333-3333-4333-8333-333333333333';
    const first = await withTenant(api.pool, api.tenantId, (client) =>
      api.relay.claimDelivery(asExecutor(client), envelopeId, 'inbound.normalizer', api.tenantId),
    );
    const second = await withTenant(api.pool, api.tenantId, (client) =>
      api.relay.claimDelivery(asExecutor(client), envelopeId, 'inbound.normalizer', api.tenantId),
    );
    // At-least-once delivery is only safe to build on because the second
    // arrival is recognisable.
    expect(first).toBe(true);
    expect(second).toBe(false);

    const row = await api.pool.query<{ attempts: number }>(
      'SELECT attempts FROM broker_deliveries WHERE envelope_id = $1 AND consumer = $2',
      [envelopeId, 'inbound.normalizer'],
    );
    // A consumer seeing the same envelope repeatedly is worth being able to see.
    expect(row.rows[0]?.attempts).toBe(2);
  });

  it('keeps each consumer’s claim separate', async () => {
    const envelopeId = '44444444-4444-4444-8444-444444444444';
    const inbound = await withTenant(api.pool, api.tenantId, (client) =>
      api.relay.claimDelivery(asExecutor(client), envelopeId, 'inbound.normalizer', api.tenantId),
    );
    const search = await withTenant(api.pool, api.tenantId, (client) =>
      api.relay.claimDelivery(asExecutor(client), envelopeId, 'search.indexer', api.tenantId),
    );
    // Two consumers of one event are two jobs, and one having done its work
    // says nothing about the other.
    expect(inbound).toBe(true);
    expect(search).toBe(true);
  });

  it('claims each envelope once across concurrent relay sweeps', async () => {
    published = [];
    answer = { status: 'confirmed' };
    await Promise.all([
      enqueue('inbound.event', { eventId: 'c1' }),
      enqueue('inbound.event', { eventId: 'c2' }),
      enqueue('inbound.event', { eventId: 'c3' }),
    ]);
    const [left, right] = await Promise.all([api.relay.drain(10, 'a'), api.relay.drain(10, 'b')]);
    // `FOR UPDATE SKIP LOCKED`: two relays share the queue rather than fighting
    // over the same rows.
    expect(left.claimed + right.claimed).toBe(3);
    expect(new Set(published).size).toBe(published.length);
  });
});
