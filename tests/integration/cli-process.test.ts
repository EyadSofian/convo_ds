import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMES } from '../support/cluster.js';
import { clusterCredentials, scratchDatabaseName } from '../support/scratch.js';

/**
 * `bin.ts` is the only file outside the coverage gate (see
 * docs/testing/coverage-exclusions.md): its single statement is a top-level
 * side effect that cannot run in-process without ending the test runner. So it
 * is verified the way an operator experiences it -- by running it and reading
 * the exit code and the stream each message landed on.
 */
const BIN = fileURLToPath(new URL('../../packages/database/src/bin.ts', import.meta.url));

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBin(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function envFor(database: string): Record<string, string> {
  const cluster = clusterCredentials();
  return {
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_SUPERUSER: cluster.superUser,
    CONVO_PG_SUPERPASSWORD: cluster.superPassword,
    CONVO_PG_DATABASE: database,
    CONVO_PG_MIGRATION_ROLE: NAMES.migrationRole,
    CONVO_PG_MIGRATION_PASSWORD: NAMES.migrationPassword,
    CONVO_PG_RUNTIME_ROLE: NAMES.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: NAMES.runtimePassword,
  };
}

describe('convo-db entry point', () => {
  it('exits 2 and prints usage on stderr with no command', async () => {
    const run = await runBin([]);
    expect(run.code).toBe(2);
    expect(run.stderr.trim()).toBe('usage: convo-db <bootstrap|migrate>');
    expect(run.stdout).toBe('');
  }, 120_000);

  it('exits 2 on an unknown command', async () => {
    const run = await runBin(['rollback'], envFor('convo_test'));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('usage: convo-db');
  }, 120_000);

  it('exits 2 and names the missing variable when the environment is incomplete', async () => {
    const env = envFor('convo_test');
    delete env['CONVO_PG_DATABASE'];
    const run = await runBin(['migrate'], env);
    expect(run.code).toBe(2);
    expect(run.stderr.trim()).toBe('Missing required environment variable: CONVO_PG_DATABASE');
  }, 120_000);

  it('exits 1 when the database is unreachable', async () => {
    const run = await runBin(['migrate'], { ...envFor('convo_test'), CONVO_PG_PORT: '1' });
    expect(run.code).toBe(1);
    expect(run.stderr.trim()).not.toBe('');
    expect(run.stdout).toBe('');
  }, 120_000);

  it('bootstraps and then migrates a database end to end', async () => {
    const database = scratchDatabaseName('convo_cli');
    const env = envFor(database);

    const bootstrap = await runBin(['bootstrap'], env);
    expect(bootstrap.stderr).toBe('');
    expect(bootstrap.code).toBe(0);
    expect(bootstrap.stdout.trim()).toBe('bootstrap complete');

    const first = await runBin(['migrate'], env);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split('\n')).toEqual([
      'applied 0001_foundation.sql',
      'applied 0002_rls.sql',
      'applied 0003_permission_catalogue.sql',
      'applied 0004_installation_mode.sql',
      'applied 0005_idempotency.sql',
      'applied 0006_auth_sessions.sql',
      'applied 0007_role_matrix.sql',
      'applied 0008_invitations.sql',
      'applied 0009_people_admin.sql',
    ]);

    const second = await runBin(['migrate'], env);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe('no pending migrations');
  }, 180_000);
});
