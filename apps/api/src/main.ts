import 'reflect-metadata';
import { bootFailureMessage, brokerConfigured, requiresBroker, startApi } from './app.js';
import { BROKER } from './tokens.js';
import type { BrokerPort } from './broker/broker.port.js';
import { HTTP_ROLES, parseApiConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import type { WorkerRole } from './workers/worker-roles.js';
import { tickFor } from './workers/worker-roles.js';
import { startProbeServer } from './workers/probe-server.js';
import { realSleep, runWorkerLoop } from './workers/worker-loop.js';

/**
 * The one process entry point, for all nine roles.
 *
 * A role that serves HTTP listens and stays up. A worker role starts the same
 * application context — same configuration, same pool, same services — runs a
 * loop instead of binding the API port, and binds a small probe port so the
 * platform and an operator can both see whether it is working.
 *
 * A worker that is configured with a durable broker **fails closed** when it
 * cannot reach one. It no longer fails closed merely because no broker was ever
 * configured: that distinction is ADR-0018, and conflating the two is what kept
 * automation scheduling out of production entirely.
 */
async function main(): Promise<void> {
  const config = parseApiConfig(process.env);
  const log = createLogger({
    service: 'convo',
    processRole: config.processRole,
    level: config.logLevel,
  });

  const startedAt = new Date();
  const app = await startApi(process.env);
  log.info('process_started', {
    role: config.processRole,
    email_provider: config.email.provider,
    trusted_proxy_hops: config.trustedProxyHops,
  });

  if (HTTP_ROLES.includes(config.processRole)) {
    return;
  }

  if (requiresBroker(config.processRole, brokerConfigured(process.env))) {
    const broker = app.get<BrokerPort>(BROKER);
    if (!(await broker.healthy())) {
      log.error('broker_unavailable', { role: config.processRole });
      await app.close();
      throw new Error(
        `broker_unavailable: ${config.processRole} is configured with a durable broker and cannot reach it.`,
      );
    }
  }

  const loop = runWorkerLoop({
    role: config.processRole,
    idleDelayMs: 1000,
    errorDelayMs: 5000,
    tick: tickFor(config.processRole as WorkerRole, {
      app,
      concurrency: config.workerConcurrency,
    }),
    sleep: realSleep,
    onError: (error) => {
      log.error('worker_tick_failed', {
        worker_role: config.processRole,
        error_code: error instanceof Error ? error.name : 'unknown',
        cause: error,
      });
    },
  });

  // A worker binds no API port, so without this it is unobservable: a loop
  // wedged on a hung provider call looks exactly like a healthy idle one.
  const probe = startProbeServer({
    port: config.port,
    host: config.host,
    handle: loop,
    role: config.processRole,
    startedAt,
    onError: (error) => {
      // Never fatal. Being unwatchable is bad; refusing to drain the queue is
      // worse.
      log.warn('probe_server_unavailable', { cause: error });
    },
  });

  // A deploy signals; the loop finishes its current tick and stops, so a lease
  // is never severed mid-write.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('worker_stopping', { signal });
      loop.stop();
    });
  }

  const summary = await loop.done;
  probe.close();
  log.info('worker_stopped', {
    worker_role: summary.role,
    ticks: summary.ticks,
    handled: summary.handled,
    errors: summary.errors,
    // Offered beside achieved: `handled` alone reads the same whether the round
    // kept up or quietly fell behind (ADR-0007).
    offered: summary.offered,
    achieved: summary.achieved,
    last_tick_at: summary.lastTickAt,
  });
  await app.close();
}

void main().catch((error: unknown) => {
  // The logger may not exist yet — a configuration failure happens before it is
  // built — so boot failure is the one place that writes directly. It is still
  // one JSON line, so a collector parses it like every other.
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'convo',
      event: 'boot_failed',
      error_code: bootFailureMessage(error),
    })}\n`,
  );
  process.exitCode = 1;
});
