import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'portal.spec.js',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
