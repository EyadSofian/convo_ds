import { describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  productionDeps,
  runCli,
  type CliDeps,
  type CliIo,
} from './cli.js';
import type { AppliedMigration, ClusterCredentials, DatabaseNames } from './types.js';

const fullEnv = {
  CONVO_PG_HOST: 'db.internal',
  CONVO_PG_PORT: '5432',
  CONVO_PG_SUPERUSER: 'postgres',
  CONVO_PG_SUPERPASSWORD: 'super',
  CONVO_PG_DATABASE: 'convo',
  CONVO_PG_MIGRATION_ROLE: 'convo_migrator',
  CONVO_PG_MIGRATION_PASSWORD: 'm',
  CONVO_PG_RUNTIME_ROLE: 'convo_app',
  CONVO_PG_RUNTIME_PASSWORD: 'r',
} as const;

interface Harness {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly bootstrapCalls: Array<[ClusterCredentials, DatabaseNames]>;
  readonly migrateCalls: Array<[ClusterCredentials, DatabaseNames]>;
  readonly deps: CliDeps;
}

function harness(
  options: {
    readonly applied?: AppliedMigration[];
    readonly bootstrapError?: Error;
    readonly migrateError?: unknown;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const bootstrapCalls: Array<[ClusterCredentials, DatabaseNames]> = [];
  const migrateCalls: Array<[ClusterCredentials, DatabaseNames]> = [];
  return {
    out,
    err,
    bootstrapCalls,
    migrateCalls,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    deps: {
      async bootstrapCluster(cluster, names) {
        bootstrapCalls.push([cluster, names]);
        if (options.bootstrapError !== undefined) {
          throw options.bootstrapError;
        }
        return await Promise.resolve();
      },
      async migrate(cluster, names) {
        migrateCalls.push([cluster, names]);
        if (options.migrateError !== undefined) {
          throw options.migrateError;
        }
        return await Promise.resolve(options.applied ?? []);
      },
    },
  };
}

const migration = (name: string): AppliedMigration => ({
  name,
  checksum: 'c'.repeat(64),
  appliedAt: new Date('2026-09-08T00:00:00Z'),
});

describe('runCli', () => {
  describe('argument handling', () => {
    it.each([
      ['no command', []],
      ['an unknown command', ['rollback']],
      ['a near miss', ['migrations']],
    ])('exits with a usage code and prints usage for %s', async (_label, argv) => {
      const h = harness();
      await expect(runCli(argv, fullEnv, h.io, h.deps)).resolves.toBe(EXIT_USAGE);
      expect(h.err).toEqual(['usage: convo-db <bootstrap|migrate>']);
      expect(h.out).toEqual([]);
      expect(h.migrateCalls).toEqual([]);
      expect(h.bootstrapCalls).toEqual([]);
    });
  });

  describe('environment validation', () => {
    it.each([
      'CONVO_PG_HOST',
      'CONVO_PG_PORT',
      'CONVO_PG_DATABASE',
      'CONVO_PG_MIGRATION_ROLE',
      'CONVO_PG_MIGRATION_PASSWORD',
      'CONVO_PG_RUNTIME_ROLE',
      'CONVO_PG_RUNTIME_PASSWORD',
    ])('refuses to run when %s is missing', async (name) => {
      const h = harness();
      const env: Record<string, string | undefined> = { ...fullEnv };
      delete env[name];
      await expect(runCli(['migrate'], env, h.io, h.deps)).resolves.toBe(EXIT_USAGE);
      expect(h.err).toEqual([`Missing required environment variable: ${name}`]);
      expect(h.migrateCalls).toEqual([]);
    });

    it('treats an empty string as missing', async () => {
      const h = harness();
      await expect(
        runCli(['migrate'], { ...fullEnv, CONVO_PG_DATABASE: '' }, h.io, h.deps),
      ).resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toContain('CONVO_PG_DATABASE');
    });

    it.each(['not-a-number', '0', '70000', '5432.5', '-1'])(
      'rejects the port value %s',
      async (port) => {
        const h = harness();
        await expect(
          runCli(['migrate'], { ...fullEnv, CONVO_PG_PORT: port }, h.io, h.deps),
        ).resolves.toBe(EXIT_USAGE);
        expect(h.err).toEqual(['CONVO_PG_PORT must be an integer between 1 and 65535']);
      },
    );

    it('allows superuser credentials to be absent for a migrate-only deployment', async () => {
      const h = harness();
      const env: Record<string, string | undefined> = { ...fullEnv };
      delete env['CONVO_PG_SUPERUSER'];
      delete env['CONVO_PG_SUPERPASSWORD'];
      await expect(runCli(['migrate'], env, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.migrateCalls[0]?.[0]).toMatchObject({ superUser: '', superPassword: '' });
    });

    it('passes the parsed credentials through unchanged', async () => {
      const h = harness();
      await runCli(['migrate'], fullEnv, h.io, h.deps);
      expect(h.migrateCalls[0]?.[0]).toEqual({
        host: 'db.internal',
        port: 5432,
        superUser: 'postgres',
        superPassword: 'super',
      });
      expect(h.migrateCalls[0]?.[1]).toEqual({
        database: 'convo',
        migrationRole: 'convo_migrator',
        migrationPassword: 'm',
        runtimeRole: 'convo_app',
        runtimePassword: 'r',
      });
    });
  });

  describe('bootstrap', () => {
    it('reports success', async () => {
      const h = harness();
      await expect(runCli(['bootstrap'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.out).toEqual(['bootstrap complete']);
      expect(h.bootstrapCalls).toHaveLength(1);
    });

    it('reports a failure on stderr with a failure exit code', async () => {
      const h = harness({ bootstrapError: new Error('role convo_app already owns a table') });
      await expect(runCli(['bootstrap'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_FAILED);
      expect(h.err).toEqual(['role convo_app already owns a table']);
      expect(h.out).toEqual([]);
    });
  });

  describe('migrate', () => {
    it('says so when there is nothing to apply', async () => {
      const h = harness({ applied: [] });
      await expect(runCli(['migrate'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.out).toEqual(['no pending migrations']);
    });

    it('lists each applied migration', async () => {
      const h = harness({ applied: [migration('0001_foundation.sql'), migration('0002_rls.sql')] });
      await expect(runCli(['migrate'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.out).toEqual(['applied 0001_foundation.sql', 'applied 0002_rls.sql']);
    });

    it('surfaces a checksum-drift failure verbatim', async () => {
      const h = harness({ migrateError: new Error('Migration 0002_rls.sql changed after it was applied') });
      await expect(runCli(['migrate'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_FAILED);
      expect(h.err).toEqual(['Migration 0002_rls.sql changed after it was applied']);
    });

    it('still reports a non-Error rejection rather than printing "undefined"', async () => {
      const h = harness({ migrateError: 'connection terminated' });
      await expect(runCli(['migrate'], fullEnv, h.io, h.deps)).resolves.toBe(EXIT_FAILED);
      expect(h.err).toEqual(['connection terminated']);
    });
  });

  it('wires the real implementations in productionDeps', () => {
    expect(productionDeps.bootstrapCluster).toBeTypeOf('function');
    expect(productionDeps.migrate).toBeTypeOf('function');
  });
});
