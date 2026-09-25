import { defineConfig, devices } from '@playwright/test';

const previewPort = Number(process.env['CONVO_E2E_PORT'] ?? '4173');
const previewUrl = `http://127.0.0.1:${String(previewPort)}`;

/**
 * End-to-end and layout-acceptance runner.
 *
 * These tests exist because "looks better" is not verification. The density
 * numbers in docs/execution/CLAUDE-LIVE-MVP-TASK.md §3 are asserted here against
 * a real engine that actually lays the page out — happy-dom computes no
 * geometry, so a unit test can never prove a row is 68px or that eight of them
 * fit on a 768px screen.
 *
 * Two viewports are mandated: 1440×900 and 1366×768. Direction and theme are
 * driven per-test through the app's own controls rather than extra projects, so
 * one run covers Arabic RTL / English LTR and light / dark.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  reporter: process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      /*
       * What this ratio can and cannot catch, measured rather than assumed.
       *
       * Arabic glyph rasterisation varies run to run on the same machine by
       * about 1.4% of the pixels of a text-dense screen — the diff is a
       * scattering of subpixel edges with identical text. Replacing the
       * Channels screen wholesale, four cards of demo data becoming one state
       * box, moved about 2%. Those two numbers are too close for a ratio to
       * separate, because most of both screens is near-white on near-white and
       * only glyph pixels ever count.
       *
       * So this stays at 2%: it catches a colour token drifting, a control
       * losing its border, a layout collapsing — real work, and all it can
       * honestly claim. "This screen is no longer the same screen" is caught by
       * the structural snapshots in visual.spec.ts instead, which compare a DOM
       * skeleton and involve no rasterisation at all.
       */
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: previewUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'desktop-1366',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer: {
    // The built bundle, not the dev server: layout evidence should describe
    // what ships. `--strictPort` so a stale server never silently serves an
    // older build to a passing test.
    command: `pnpm --filter @convo/web exec vite preview --port ${String(previewPort)} --strictPort --host 127.0.0.1`,
    url: previewUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
