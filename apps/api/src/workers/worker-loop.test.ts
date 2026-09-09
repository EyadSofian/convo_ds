import { describe, expect, it } from 'vitest';
import { realSleep, runWorkerLoop } from './worker-loop.js';

/**
 * The loop every worker role runs.
 *
 * The behaviour worth defending is what happens when a tick goes wrong: a
 * worker that dies on one bad row stops processing every other company's work
 * too, which turns a single poison message into an outage.
 */

/** A sleep that resolves immediately and records what it was asked to wait. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

const OPTIONS = { role: 'worker-inbound' as const, idleDelayMs: 1000, errorDelayMs: 5000 };

describe('runWorkerLoop', () => {
  it('keeps ticking until it is asked to stop', async () => {
    const clock = fakeSleep();
    let ticks = 0;
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      tick: () => {
        ticks += 1;
        if (ticks >= 3) {
          loop.stop();
        }
        return Promise.resolve({ handled: 2 });
      },
    });
    const summary = await loop.done;
    expect(summary).toEqual({
      role: 'worker-inbound',
      ticks: 3,
      handled: 6,
      errors: 0,
      offered: 0,
      achieved: 0,
    });
    // Busy ticks do not sleep: backing off while there is work is how a queue
    // stops draining.
    expect(clock.waits).toEqual([]);
  });

  it('accumulates what each round was offered and what it achieved', async () => {
    const clock = fakeSleep();
    const rounds = [
      { handled: 4, fairness: { offered: 10, achieved: 4 } },
      { handled: 3, fairness: { offered: 3, achieved: 3 } },
    ];
    let index = 0;
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      tick: () => {
        const round = rounds[index] ?? rounds[0];
        index += 1;
        if (index >= rounds.length) {
          loop.stop();
        }
        return Promise.resolve(round as { handled: number });
      },
    });
    // Readable while it runs, not only at the end: a worker that has to stop
    // before anybody can see whether it is falling behind is not observable.
    const summary = await loop.done;
    expect(loop.stats()).toEqual(summary);
    expect(summary.offered).toBe(13);
    expect(summary.achieved).toBe(7);
    // Thirteen asked for, seven served: `handled` alone cannot say that.
    expect(summary.handled).toBe(7);
  });

  it('backs off when there was nothing to do', async () => {
    const clock = fakeSleep();
    let ticks = 0;
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      tick: () => {
        ticks += 1;
        if (ticks >= 2) {
          loop.stop();
        }
        return Promise.resolve({ handled: 0 });
      },
    });
    await loop.done;
    // Polling flat out against an empty queue is how a background process
    // becomes the database's main load.
    expect(clock.waits).toEqual([1000, 1000]);
  });

  it('survives a tick that throws, and keeps going', async () => {
    const clock = fakeSleep();
    const seen: unknown[] = [];
    let ticks = 0;
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      onError: (error) => seen.push(error),
      tick: () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error('one bad row');
        }
        loop.stop();
        return Promise.resolve({ handled: 1 });
      },
    });
    const summary = await loop.done;
    expect(summary.errors).toBe(1);
    expect(summary.handled).toBe(1);
    expect((seen[0] as Error).message).toBe('one bad row');
    // A longer pause after a failure than after an idle tick: whatever broke is
    // unlikely to be fixed a millisecond later.
    expect(clock.waits).toEqual([5000]);
  });

  it('lets an in-flight tick finish before it stops', async () => {
    // A deploy must not sever a lease mid-write, so stopping is cooperative
    // rather than an abort.
    const clock = fakeSleep();
    let finished = false;
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      tick: async () => {
        loop.stop();
        await Promise.resolve();
        finished = true;
        return { handled: 1 };
      },
    });
    await loop.done;
    expect(finished).toBe(true);
  });

  it('stops before its first tick when asked immediately', async () => {
    const clock = fakeSleep();
    const loop = runWorkerLoop({
      ...OPTIONS,
      sleep: clock.sleep,
      tick: () => Promise.resolve({ handled: 1 }),
    });
    loop.stop();
    const summary = await loop.done;
    // One tick had already begun; nothing after it.
    expect(summary.ticks).toBeLessThanOrEqual(1);
  });
});

describe('realSleep', () => {
  it('waits, and resolves', async () => {
    const before = Date.now();
    await realSleep(5);
    expect(Date.now() - before).toBeGreaterThanOrEqual(1);
  });
});
