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
]);
