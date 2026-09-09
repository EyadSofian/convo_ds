import { defineConfig } from 'vite';

/**
 * The browser and the API share an origin in production, so every request the
 * client makes is the same-origin path `/api/v1/...`. In development the two
 * are separate processes, and this proxy is what keeps that one code path true
 * instead of introducing a second base URL that only exists locally — and with
 * it a class of CORS and cookie bugs that never appear in the deployed build.
 *
 * `CONVO_API_ORIGIN` overrides the target for anyone running the API elsewhere.
 */
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env['CONVO_API_ORIGIN'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: process.env['CONVO_API_ORIGIN'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
});
