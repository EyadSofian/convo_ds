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
      // Gates from docs/testing/strategy.md. Lowering a threshold to make a run
      // pass is forbidden by that document.
      thresholds: { lines: 100, functions: 100, branches: 95, statements: 100 },
    },
  },
});
