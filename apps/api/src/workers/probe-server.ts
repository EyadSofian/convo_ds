import { createServer, type Server, type ServerResponse } from 'node:http';
import type { WorkerHandle } from './worker-loop.js';

/**
 * A worker's health surface.
 *
 * A worker role binds no port, which used to mean the only way to know whether
 * one was working was to read its logs — and the only signal it emitted was a
 * single line when it stopped. A loop that has quietly wedged on a hung provider
 * call looks exactly like a healthy idle one from outside, forever.
 *
 * So each worker runs this: about forty lines of `node:http`, no framework, no
 * router, three routes.
 *
 * - `/live` is the platform's restart signal. It is **not** "the loop is
 *   advancing" — it is "this process exists". Tying liveness to tick progress
 *   would restart a worker that is legitimately idle because nobody sent a
 *   message, which is most workers most of the time.
 * - `/ready` is "the loop has actually run at least once since boot". A worker
 *   that never completes a first tick is misconfigured, and this is where that
 *   shows.
 * - `/metrics` is the counters: ticks, work handled, errors, the fairness pair,
 *   and the timestamps. Enough to build a queue-depth and throughput view
 *   without giving anything away — there are no ids, no tenants and no content
 *   in any of it.
 *
 * Binding is best-effort. A worker whose probe port is taken must keep draining
 * its queue; refusing to work because nobody can watch it would be the wrong
 * trade in both directions.
 */

export interface ProbeServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly handle: WorkerHandle;
  readonly role: string;
  /** Reported so an operator can tie a running process to a build. */
  readonly startedAt: Date;
  onError?(error: unknown): void;
}

export function startProbeServer(options: ProbeServerOptions): Server {
  const server = createServer((request, response) => {
    /* c8 ignore next -- node always sets url on an inbound HTTP request */
    const path = (request.url ?? '/').split('?')[0];
    const stats = options.handle.stats();

    if (path === '/live') {
      return send(response, 200, { status: 'alive', role: options.role });
    }

    if (path === '/ready') {
      // One completed tick is the whole bar. Anything stricter would take a
      // correctly idle worker out of rotation.
      const ready = stats.ticks > 0 && stats.lastTickAt !== null;
      return send(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        role: options.role,
        last_tick_at: stats.lastTickAt,
      });
    }

    if (path === '/metrics') {
      return send(response, 200, {
        role: options.role,
        started_at: options.startedAt.toISOString(),
        uptime_seconds: Math.floor((Date.now() - options.startedAt.getTime()) / 1000),
        ticks: stats.ticks,
        handled: stats.handled,
        errors: stats.errors,
        // Offered beside achieved. `handled` alone reads the same whether the
        // round served everything asked of it or a tenth of it (ADR-0007).
        offered: stats.offered,
        achieved: stats.achieved,
        last_tick_at: stats.lastTickAt,
        last_error_at: stats.lastErrorAt,
        // The message, not the stack: a stack carries paths and, from a driver,
        // sometimes a connection string.
        last_error: stats.lastErrorMessage,
      });
    }

    return send(response, 404, { error: 'not_found' });
  });

  server.on('error', (error) => {
    // Never fatal. A worker that cannot be observed is worse than one that can,
    // but a worker that refuses to drain its queue is worse than both.
    options.onError?.(error);
  });

  server.listen(options.port, options.host ?? '0.0.0.0');
  // The probe server must not be the reason the process stays alive after the
  // loop has stopped and the pool has closed.
  server.unref();
  return server;
}

function send(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
