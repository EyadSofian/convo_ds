import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Runtime globals declared explicitly rather than pulled from the `globals`
// package, which pnpm does not hoist here. `no-undef` is off for TypeScript
// files (typescript-eslint's recommended config turns it off, because the
// compiler already checks this), so these only matter for plain .js/.mjs.
const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  console: 'readonly',
};

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

export default tseslint.config(
  {
    // Generated and scratch output. These are already in .gitignore; eslint 9's
    // flat config does not read that file, so the list is repeated here.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.research-cache/**',
      'research/**',
      'tmp/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
      'deliverables/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['apps/proposal/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
);
