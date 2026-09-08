import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root-only option. The integration project asserts on cluster-wide
    // catalogs (pg_roles) and on pooled-connection state, neither of which
    // survives parallel interference, so files run one at a time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
      // `all` counts first-party source that no test imported at all. Without
      // it, deleting the last test for a file makes coverage go up.
      all: true,
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        // Process entry point: one top-level side effect that cannot execute
        // in-process without ending the test runner. Its behaviour is asserted
        // by running it, in tests/integration/cli-process.test.ts.
        // Recorded in docs/testing/coverage-exclusions.md.
        'packages/database/src/bin.ts',
        // API process entry point: starts a listener and mutates process state.
        // The built file is spawned by tests/integration/api-boot.test.ts.
        // Recorded in docs/testing/coverage-exclusions.md.
        'apps/api/src/main.ts',
      ],
      // Gates from docs/testing/strategy.md. Lowering a threshold to make a run
      // pass is forbidden by that document.
      thresholds: {
        lines: 100,
        functions: 100,
        // 100, not 95. A gate set below what the suite achieves lets coverage
        // rot silently down to the threshold; the repository reached 100%
        // branches by deleting unreachable code rather than by tolerating it,
        // so the gate now says so.
        branches: 100,
        statements: 100,
        // Critical modules carry the stricter 100% branch gate (MASTER §13).
        // Today that is tenancy context and the installation/tenancy services;
        // consent, idempotency, dispatch and handoff join this list as they land.
        'packages/database/src/context.ts': { branches: 100 },
        'packages/database/src/transaction.ts': { branches: 100 },
        'packages/domain/src/installation/**': { branches: 100 },
        'apps/api/src/idempotency/**': { branches: 100 },
      },
    },
  },
});
