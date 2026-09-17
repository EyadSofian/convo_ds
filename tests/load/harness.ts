/**
 * A closed-loop load harness.
 *
 * Deliberately small and deliberately honest about which model it uses. Each
 * virtual user issues a request, waits for the answer, and issues the next one —
 * a **closed** model, which is what an operator UI actually is: a person cannot
 * open a second conversation before the first has rendered. An open-model tool
 * that fires at a fixed arrival rate would report far worse tail latency for the
 * same server, because it queues requests the real client would never have sent.
 *
 * Percentiles are computed from every sample rather than from a reservoir. The
 * sample counts here are tens of thousands, so exactness costs nothing and there
 * is no estimator to explain away when a number looks surprising.
 */

export interface Scenario {
  readonly name: string;
  /** One request. Returns the HTTP status so errors can be counted, not timed away. */
  run(): Promise<number>;
  /** Share of virtual users given to this scenario. Weights need not sum to 1. */
  readonly weight: number;
}

export interface LoadOptions {
  readonly concurrency: number;
  readonly durationMs: number;
  /** Requests issued before measurement starts, to settle pools and plan caches. */
  readonly warmupRequests?: number;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly samples: number;
  readonly errors: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export interface LoadResult {
  readonly concurrency: number;
  readonly durationMs: number;
  readonly totalRequests: number;
  readonly totalErrors: number;
  readonly requestsPerSecond: number;
  readonly errorRate: number;
  readonly scenarios: readonly ScenarioResult[];
}

export async function runLoad(
  scenarios: readonly Scenario[],
  options: LoadOptions,
): Promise<LoadResult> {
  // Warm up off the clock. The first request through a pool pays for a
  // connection handshake and the first plan for every statement, and folding
  // that into p99 measures startup rather than steady state.
  for (let index = 0; index < (options.warmupRequests ?? 20); index += 1) {
    const scenario = scenarios[index % scenarios.length];
    if (scenario !== undefined) {
      await scenario.run().catch(() => 0);
    }
  }

  const timings = new Map<string, number[]>();
  const errors = new Map<string, number>();
  for (const scenario of scenarios) {
    timings.set(scenario.name, []);
    errors.set(scenario.name, 0);
  }

  const assignment = assign(scenarios, options.concurrency);
  const deadline = Date.now() + options.durationMs;
  const started = Date.now();

  await Promise.all(
    assignment.map(async (scenario) => {
      while (Date.now() < deadline) {
        const begin = performance.now();
        let status = 0;
        try {
          status = await scenario.run();
        } catch {
          status = 0;
        }
        const elapsed = performance.now() - begin;
        // A failed request is counted *and* timed. Dropping its duration is how
        // a server that fails fast under load appears to get faster.
        timings.get(scenario.name)?.push(elapsed);
        if (status < 200 || status >= 400) {
          errors.set(scenario.name, (errors.get(scenario.name) ?? 0) + 1);
        }
      }
    }),
  );

  const elapsedMs = Date.now() - started;
  const results: ScenarioResult[] = [];
  let totalRequests = 0;
  let totalErrors = 0;

  for (const scenario of scenarios) {
    const samples = [...(timings.get(scenario.name) ?? [])].sort((left, right) => left - right);
    const failed = errors.get(scenario.name) ?? 0;
    totalRequests += samples.length;
    totalErrors += failed;
    results.push({
      scenario: scenario.name,
      samples: samples.length,
      errors: failed,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      max: samples.length === 0 ? 0 : round(samples[samples.length - 1] ?? 0),
      mean: samples.length === 0 ? 0 : round(samples.reduce((a, b) => a + b, 0) / samples.length),
    });
  }

  return {
    concurrency: options.concurrency,
    durationMs: elapsedMs,
    totalRequests,
    totalErrors,
    requestsPerSecond: round((totalRequests / elapsedMs) * 1000),
    errorRate: totalRequests === 0 ? 0 : round((totalErrors / totalRequests) * 100, 3),
    scenarios: results,
  };
}

/**
 * Which scenario each virtual user runs.
 *
 * Deterministic rather than random, so two runs at the same concurrency compare
 * like for like. A random assignment makes every comparison include the noise of
 * a different mix.
 */
function assign(scenarios: readonly Scenario[], concurrency: number): Scenario[] {
  const total = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  const users: Scenario[] = [];
  for (const scenario of scenarios) {
    const share = Math.max(1, Math.round((scenario.weight / total) * concurrency));
    for (let index = 0; index < share && users.length < concurrency; index += 1) {
      users.push(scenario);
    }
  }
  // Rounding can leave the last few unassigned; give them to the heaviest.
  const heaviest = [...scenarios].sort((left, right) => right.weight - left.weight)[0];
  while (users.length < concurrency && heaviest !== undefined) {
    users.push(heaviest);
  }
  return users;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  // Nearest-rank. No interpolation, so a reported p99 is a duration that was
  // actually observed rather than one between two that were.
  const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return round(sorted[Math.max(0, rank)] ?? 0);
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
