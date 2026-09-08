import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiBootError,
  bootFailureMessage,
  startApi,
} from '../../apps/api/src/app.js';
import { ApiConfigurationError } from '../../apps/api/src/config.js';
import { asExecutor } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
} from '../support/scratch.js';

function envFor(
  names: DatabaseNames,
  mode: 'saas' | 'self_hosted_single',
  host = '127.0.0.1',
): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_DEPLOYMENT_MODE: mode,
    CONVO_INSTALLATION_NAME: 'Boot Test',
    CONVO_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'boot-test-auth-hash-secret-value-0001',
    CONVO_BOOTSTRAP_TOKEN: 'boot-test-bootstrap-token-value-000001',
    CONVO_IDEMPOTENCY_HASH_SECRET: 'boot-test-idempotency-secret-value-001',
    CONVO_API_HOST: host,
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  };
}

describe('API boot boundary', () => {
  let names: DatabaseNames;
  const apps: Array<Awaited<ReturnType<typeof startApi>>> = [];

  beforeAll(async () => {
    names = await createScratchDatabase('convo_api_boot');
    await migrateScratch(names);
    const pool = scratchRuntimePool(names);
    try {
      await applyInstallationConfig(asExecutor(pool), 'saas');
    } finally {
      await pool.end();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('fails before opening a database pool when configuration is invalid', async () => {
    await expect(startApi({})).rejects.toBeInstanceOf(ApiConfigurationError);
    try {
      await startApi({});
    } catch (error) {
      expect(bootFailureMessage(error)).toContain('api_configuration_invalid');
      expect(bootFailureMessage(error)).toContain('CONVO_PROCESS_ROLE');
    }
  });

  it('fails closed when configured and recorded tenancy modes differ', async () => {
    await expect(startApi(envFor(names, 'self_hosted_single'))).rejects.toMatchObject({
      code: 'installation_mode_mismatch',
    });
  });

  it('closes the initialized app when the listener cannot bind', async () => {
    await expect(startApi(envFor(names, 'saas', 'invalid host name'))).rejects.toBeDefined();
  });

  it('listens successfully and serves the versioned route', async () => {
    const app = await startApi(envFor(names, 'saas'));
    apps.push(app);
    const url = await app.getUrl();
    const response = await fetch(url + '/api/v1/instance');
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      apiVersion: 'v1',
      deploymentMode: 'saas',
    });
  });

  it('formats typed boot errors and hides unknown startup details', () => {
    expect(bootFailureMessage(new ApiBootError('boot_code', 'Safe reason.'))).toBe(
      'boot_code: Safe reason.',
    );
    expect(bootFailureMessage(new Error('password=secret'))).toBe(
      'api_boot_failed: database or application startup failed',
    );
  });

  it('runs the built entry point as a real process and exits on invalid config', async () => {
    const result = await runMain();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('api_configuration_invalid');
    expect(result.stderr).toContain('CONVO_DEPLOYMENT_MODE');
  });
});

function runMain(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
