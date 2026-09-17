import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['tests/support/global-setup.ts'],
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  },
  {
    test: {
      name: 'property',
      include: ['tests/property/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    // The restore drill. Its own project rather than an integration test
    // because it builds and tears down two whole installations and is slow
    // enough that nobody would run the integration suite if it were in there —
    // and a recovery test nobody runs is a recovery test that does not exist.
    test: {
      name: 'recovery',
      include: ['tests/recovery/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['tests/support/global-setup.ts'],
      testTimeout: 180_000,
      hookTimeout: 300_000,
    },
  },
  {
    // The load run. Its own project because it takes minutes and seeds tens of
    // thousands of rows; folding it into the integration suite would make that
    // suite too slow to run, and a load test nobody runs is one that does not
    // exist. It reuses the integration fixture so it measures the same schema.
    test: {
      name: 'load',
      include: ['tests/load/**/*.test.ts'],
      environment: 'node',
      globalSetup: ['tests/support/global-setup.ts'],
      testTimeout: 900_000,
      hookTimeout: 300_000,
    },
  },
]);
