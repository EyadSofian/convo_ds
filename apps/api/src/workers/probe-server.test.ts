import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startProbeServer } from './probe-server.js';
import type { WorkerHandle, WorkerSummary } from './worker-loop.js';

/**
 * A worker's only outward surface.
 *
 * The property worth defending is the distinction between the two probes: a
 * worker that is legitimately idle — which is most workers most of the time —
 * must report **alive**, or the platform restarts it forever. `/ready` is
 * allowed to be stricter because nothing restarts on it.
 */

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function summary(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    role: 'worker-inbound',
    ticks: 0,
    handled: 0,
    errors: 0,
    offered: 0,
    achieved: 0,
    lastTickAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function handleFor(stats: WorkerSummary): WorkerHandle {
  return {
    done: Promise.resolve(stats),
    stats: () => stats,
    stop: () => undefined,
  };
}

async function probe(stats: WorkerSummary, path: string) {
  const server = startProbeServer({
    port: 0,
    host: '127.0.0.1',
    handle: handleFor(stats),
    role: stats.role,
    startedAt: new Date(Date.now() - 5_000),
  });
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('liveness', () => {
  it('is alive before the first tick has ever completed', async () => {
    // Tying liveness to tick progress would restart every correctly idle worker.
    const result = await probe(summary(), '/live');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'alive', role: 'worker-inbound' });
  });

  it('is alive after an error', async () => {
    const result = await probe(
      summary({ ticks: 5, errors: 3, lastErrorAt: '2026-09-17T10:00:00.000Z' }),
      '/live',
    );
    expect(result.status).toBe(200);
  });
});

describe('readiness', () => {
  it('is not ready until a tick has completed', async () => {
    const result = await probe(summary(), '/ready');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 'not_ready', last_tick_at: null });
  });

  it('is not ready when ticks were counted but none finished', async () => {
    // `ticks` increments at the top of the loop; `lastTickAt` only on success.
    const result = await probe(summary({ ticks: 1 }), '/ready');
    expect(result.status).toBe(503);
  });

  it('is ready once one tick has completed', async () => {
    const result = await probe(
      summary({ ticks: 1, lastTickAt: '2026-09-17T10:00:00.000Z' }),
      '/ready',
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'ready',
      role: 'worker-inbound',
      last_tick_at: '2026-09-17T10:00:00.000Z',
    });
  });
});

describe('metrics', () => {
  it('reports the counters an operator needs, including the fairness pair', async () => {
    const result = await probe(
      summary({
        role: 'worker-campaign',
        ticks: 12,
        handled: 340,
        errors: 2,
        offered: 400,
        achieved: 340,
        lastTickAt: '2026-09-17T10:00:00.000Z',
        lastErrorAt: '2026-09-17T09:59:00.000Z',
        lastErrorMessage: 'provider refused',
      }),
      '/metrics',
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      role: 'worker-campaign',
      ticks: 12,
      handled: 340,
      errors: 2,
      // Offered beside achieved: `handled` alone reads the same whether the
      // round kept up or fell behind.
      offered: 400,
      achieved: 340,
      last_tick_at: '2026-09-17T10:00:00.000Z',
      last_error_at: '2026-09-17T09:59:00.000Z',
      last_error: 'provider refused',
    });
    expect(result.body['uptime_seconds']).toBeGreaterThanOrEqual(4);
  });
});

describe('anything else', () => {
  it('is a 404 rather than an accidental surface', async () => {
    const result = await probe(summary(), '/../../etc/passwd');
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'not_found' });
  });

  it('ignores a query string when matching', async () => {
    const result = await probe(summary(), '/live?from=railway');
    expect(result.status).toBe(200);
  });
});

describe('when the port cannot be bound', () => {
  it('reports the failure and never throws', async () => {
    // A worker that cannot be observed is bad; a worker that refuses to drain
    // its queue because nobody can watch it is worse.
    const first = startProbeServer({
      port: 0,
      host: '127.0.0.1',
      handle: handleFor(summary()),
      role: 'worker-inbound',
      startedAt: new Date(),
    });
    servers.push(first);
    await new Promise((resolve) => first.once('listening', resolve));
    const { port } = first.address() as AddressInfo;

    const errors: unknown[] = [];
    const second = startProbeServer({
      port,
      host: '127.0.0.1',
      handle: handleFor(summary()),
      role: 'worker-inbound',
      startedAt: new Date(),
      onError: (error) => errors.push(error),
    });
    servers.push(second);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toHaveLength(1);
    expect((errors[0] as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  });

  it('survives a bind failure with no error handler supplied', async () => {
    const first = startProbeServer({
      port: 0,
      host: '127.0.0.1',
      handle: handleFor(summary()),
      role: 'worker-inbound',
      startedAt: new Date(),
    });
    servers.push(first);
    await new Promise((resolve) => first.once('listening', resolve));
    const { port } = first.address() as AddressInfo;

    const second = startProbeServer({
      port,
      host: '127.0.0.1',
      handle: handleFor(summary()),
      role: 'worker-inbound',
      startedAt: new Date(),
    });
    servers.push(second);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.listening).toBe(false);
  });

  it('binds every interface when no host is given', async () => {
    // Which is what a container needs: the platform reaches it from outside the
    // process's own loopback.
    const server = startProbeServer({
      port: 0,
      handle: handleFor(summary({ ticks: 1, lastTickAt: new Date().toISOString() })),
      role: 'worker-report',
      startedAt: new Date(),
    });
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe('0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${String(port)}/ready`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });
});
