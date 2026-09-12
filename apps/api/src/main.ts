import 'reflect-metadata';
import { bootFailureMessage, requiresBroker, startApi } from './app.js';
import { BROKER } from './tokens.js';
import type { BrokerPort } from './broker/broker.port.js';
import { HTTP_ROLES, parseApiConfig } from './config.js';
import type { WorkerRole } from './workers/worker-roles.js';
import { tickFor } from './workers/worker-roles.js';
import { realSleep, runWorkerLoop } from './workers/worker-loop.js';

/**
 * The one process entry point, for all eight roles.
 *
 * A role that serves HTTP listens and stays up. A worker role starts the same
 * application context — same configuration, same pool, same services — and runs
 * a loop instead of binding a port.
 *
 * A worker that requires a durable broker **fails closed** when one is not
 * reachable. Falling back to an in-memory queue would leave a process that
 * looks healthy, reports throughput, and loses everything it was holding the
 * moment it restarts.
 */
async function main(): Promise<void> {
  const config = parseApiConfig(process.env);
  const app = await startApi(process.env);

  if (HTTP_ROLES.includes(config.processRole)) {
    return;
  }

  if (requiresBroker(config.processRole)) {
    const broker = app.get<BrokerPort>(BROKER);
    if (!(await broker.healthy())) {
      await app.close();
      throw new Error(
        `broker_unavailable: ${config.processRole} requires a durable broker and none is reachable.`,
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
      console.error(`worker_tick_failed: ${describe(error)}`);
    },
  });

  // A deploy signals; the loop finishes its current tick and stops, so a lease
  // is never severed mid-write.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      loop.stop();
    });
  }
  const summary = await loop.done;
  // The only place these numbers are visible today. `offered` beside `achieved`
  // is what says whether the round was keeping up or quietly falling behind;
  // `handled` alone reads the same either way. There is no metrics endpoint on
  // a worker role yet — it binds no port — so this is the honest surface.
  console.log(
    `worker_stopped role=${summary.role} ticks=${String(summary.ticks)} ` +
      `handled=${String(summary.handled)} errors=${String(summary.errors)} ` +
      `offered=${String(summary.offered)} achieved=${String(summary.achieved)}`,
  );
  await app.close();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown worker failure';
}

void main().catch((error: unknown) => {
  console.error(bootFailureMessage(error));
  process.exitCode = 1;
});
