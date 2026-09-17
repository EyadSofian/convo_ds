import { describe, expect, it } from 'vitest';
import { runLoadTest } from './run.js';

/**
 * The load run, driven by the test runner.
 *
 * It is a test only in the sense that it needs the same PostgreSQL fixture
 * every other suite does, and that it has an assertion worth failing on: **the
 * API must not produce errors under the load it is given.** A load run that
 * reports throughput while quietly 500ing a tenth of its requests is measuring
 * how fast the server can fail.
 *
 * Everything else it produces is measurement rather than assertion, and lands in
 * `docs/evidence/load-test-latest.json` for
 * `docs/audit/LOAD_TEST_REPORT.md` to quote. Thresholds on the latency numbers
 * are deliberately absent: they would be thresholds on *this machine*, and the
 * first time CI ran on a busier one somebody would lower them rather than
 * investigate.
 */
describe('load', () => {
  it('serves the operator read path under concurrency without errors', async () => {
    const report = await runLoadTest();
    expect(report.runs.length).toBeGreaterThan(0);
    for (const run of report.runs) {
      expect(run.totalRequests).toBeGreaterThan(0);
      expect(
        run.totalErrors,
        `concurrency ${String(run.concurrency)} produced ${String(run.totalErrors)} failed requests`,
      ).toBe(0);
    }
  });
});
