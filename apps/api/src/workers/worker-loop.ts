import type { ProcessRole } from '../config.js';

/**
 * The shape every worker role shares.
 *
 * A worker is a loop that asks for work, does some, and sleeps if there was
 * none. What differs between the six roles is only which work — so the loop
 * lives here once, with the failure behaviour that matters:
 *
 * - **A tick that throws does not stop the loop.** A worker that dies on one
 *   bad row stops processing every other company's work too, which turns a
 *   single poison message into an outage.
 * - **Backoff when idle, not when busy.** Polling flat out against an empty
 *   queue is how a background process becomes the database's main load.
 * - **Stopping is cooperative and observable.** `stop()` lets an in-flight tick
 *   finish, so a deploy does not sever a lease mid-write.
 */

export interface WorkerTick {
  /** Work done this tick. Zero means the loop may sleep. */
  readonly handled: number;
  /**
   * What the round was asked for and what it handed out, for the roles that
   * schedule one. Absent for the roles that do not (ADR-0007).
   */
  readonly fairness?: { readonly offered: number; readonly achieved: number };
}

export interface WorkerLoopOptions {
  readonly role: ProcessRole;
  /** Milliseconds to wait after an empty tick. */
  readonly idleDelayMs: number;
  /** Milliseconds to wait after a tick that threw. */
  readonly errorDelayMs: number;
  tick(): Promise<WorkerTick>;
  /** Injected so a test can drive the clock rather than wait on it. */
  sleep(ms: number): Promise<void>;
  onError?(error: unknown): void;
}

export interface WorkerHandle {
  /** Resolves when the loop has finished its current tick and stopped. */
  readonly done: Promise<WorkerSummary>;
  /** The totals so far, readable while the loop is still running. */
  stats(): WorkerSummary;
  stop(): void;
}

export interface WorkerSummary {
  readonly role: ProcessRole;
  readonly ticks: number;
  readonly handled: number;
  readonly errors: number;
  /**
   * Running totals of what was offered and what was achieved.
   *
   * The two together are the only way to see starvation: `handled` alone looks
   * identical whether a round served everything asked of it or a tenth of it.
   */
  readonly offered: number;
  readonly achieved: number;
  /**
   * When the last tick completed, and when the last one failed.
   *
   * A worker with no port cannot be asked "are you working". These two answer
   * it: a `lastTickAt` that stopped advancing is a stuck loop, which looks
   * exactly like a healthy idle one from every other angle.
   */
  readonly lastTickAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorMessage: string | null;
}

export function runWorkerLoop(options: WorkerLoopOptions): WorkerHandle {
  let running = true;
  const summary = {
    role: options.role,
    ticks: 0,
    handled: 0,
    errors: 0,
    offered: 0,
    achieved: 0,
    lastTickAt: null as string | null,
    lastErrorAt: null as string | null,
    lastErrorMessage: null as string | null,
  };

  const done = (async (): Promise<WorkerSummary> => {
    while (running) {
      summary.ticks += 1;
      try {
        const tick = await options.tick();
        summary.handled += tick.handled;
        summary.offered += tick.fairness?.offered ?? 0;
        summary.achieved += tick.fairness?.achieved ?? 0;
        summary.lastTickAt = new Date().toISOString();
        if (tick.handled === 0) {
          await options.sleep(options.idleDelayMs);
        }
      } catch (error) {
        // One bad row must not take the loop down: every other company's work
        // is still waiting behind it.
        summary.errors += 1;
        summary.lastErrorAt = new Date().toISOString();
        summary.lastErrorMessage = error instanceof Error ? error.message : 'unknown worker failure';
        options.onError?.(error);
        await options.sleep(options.errorDelayMs);
      }
    }
    return summary;
  })();

  return {
    done,
    stats: () => ({ ...summary }),
    stop: () => {
      running = false;
    },
  };
}

/** Real sleeping, kept out of the loop so tests never wait on a clock. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
