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
import type { RegisterChannelAppInput, RegisteredChannelApp } from './channel-app.js';
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
  readonly registerCalls: Array<[ClusterCredentials, DatabaseNames, RegisterChannelAppInput]>;
  readonly deps: CliDeps;
}

function harness(
  options: {
    readonly applied?: AppliedMigration[];
    readonly bootstrapError?: Error;
    readonly migrateError?: unknown;
    readonly registered?: Partial<RegisteredChannelApp>;
    readonly registerError?: unknown;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const bootstrapCalls: Array<[ClusterCredentials, DatabaseNames]> = [];
  const migrateCalls: Array<[ClusterCredentials, DatabaseNames]> = [];
  const registerCalls: Array<[ClusterCredentials, DatabaseNames, RegisterChannelAppInput]> = [];
  return {
    out,
    err,
    bootstrapCalls,
    migrateCalls,
    registerCalls,
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
      async registerChannelApp(cluster, names, input) {
        registerCalls.push([cluster, names, input]);
        if (options.registerError !== undefined) {
          throw options.registerError;
        }
        return await Promise.resolve({
          id: '7f1d2c3b-4a59-4e6f-8b7c-0d1e2f3a4b5c',
          provider: input.provider,
          externalAppId: input.externalAppId,
          secretRef: input.secretRef,
          graphVersion: input.graphVersion,
          created: true,
          ...options.registered,
        });
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
      expect(h.err).toEqual(['usage: convo-db <bootstrap|migrate|register-channel-app>']);
      expect(h.out).toEqual([]);
      expect(h.migrateCalls).toEqual([]);
      expect(h.bootstrapCalls).toEqual([]);
      expect(h.registerCalls).toEqual([]);
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

  describe('register-channel-app', () => {
    const secrets = {
      CONVO_CHANNEL_SECRET_META_APP: 'app-secret-value',
      CONVO_CHANNEL_VERIFY_TOKEN_META_APP: 'verify-token-value',
    } as const;
    const env = { ...fullEnv, ...secrets };
    const args = ['register-channel-app', '--external-app-id', '123456789012345', '--secret-ref', 'META_APP'];

    it('registers the app and prints the webhook path the operator needs next', async () => {
      const h = harness();
      await expect(runCli(args, env, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.out).toEqual([
        'registered channel app 7f1d2c3b-4a59-4e6f-8b7c-0d1e2f3a4b5c',
        'provider=meta external_app_id=123456789012345 secret_ref=META_APP graph_version=v21.0',
        'webhook path: /api/v1/webhooks/meta/7f1d2c3b-4a59-4e6f-8b7c-0d1e2f3a4b5c',
      ]);
      expect(h.err).toEqual([]);
    });

    it('says it rotated, not registered, when the row already existed', async () => {
      const h = harness({ registered: { created: false } });
      await expect(runCli(args, env, h.io, h.deps)).resolves.toBe(EXIT_OK);
      expect(h.out[0]).toBe('rotated channel app 7f1d2c3b-4a59-4e6f-8b7c-0d1e2f3a4b5c');
    });

    it('reads both secrets from the environment and never echoes them', async () => {
      const h = harness();
      await runCli(args, env, h.io, h.deps);
      expect(h.registerCalls).toHaveLength(1);
      expect(h.registerCalls[0]?.[2]).toEqual({
        provider: 'meta',
        externalAppId: '123456789012345',
        secretRef: 'META_APP',
        graphVersion: 'v21.0',
        appSecret: 'app-secret-value',
        verifyToken: 'verify-token-value',
      });
      const printed = [...h.out, ...h.err].join('\n');
      expect(printed).not.toContain('app-secret-value');
      expect(printed).not.toContain('verify-token-value');
    });

    it('connects as the migration role, like migrate does', async () => {
      const h = harness();
      await runCli(args, env, h.io, h.deps);
      expect(h.registerCalls[0]?.[0]).toMatchObject({ host: 'db.internal', port: 5432 });
      expect(h.registerCalls[0]?.[1]).toMatchObject({ migrationRole: 'convo_migrator', migrationPassword: 'm' });
    });

    it('accepts an explicit provider and the pinned graph version', async () => {
      const h = harness();
      await expect(runCli(
        [...args, '--provider', 'meta', '--graph-version', 'v21.0'], env, h.io, h.deps,
      )).resolves.toBe(EXIT_OK);
      expect(h.registerCalls).toHaveLength(1);
    });

    it.each([
      ['a missing app id', ['register-channel-app', '--secret-ref', 'META_APP'], '--external-app-id must be the numeric Meta App ID, 1 to 32 digits.'],
      ['a non-numeric app id', ['register-channel-app', '--external-app-id', 'my-app', '--secret-ref', 'META_APP'], '--external-app-id must be the numeric Meta App ID, 1 to 32 digits.'],
      ['a missing secret ref', ['register-channel-app', '--external-app-id', '1'], '--secret-ref must be 3 to 64 characters of A-Z, 0-9 and underscore, starting with a letter, e.g. META_APP.'],
      ['a lowercase secret ref', ['register-channel-app', '--external-app-id', '1', '--secret-ref', 'meta_app'], '--secret-ref must be 3 to 64 characters of A-Z, 0-9 and underscore, starting with a letter, e.g. META_APP.'],
      ['an unknown flag', [...['register-channel-app', '--external-app-id', '1', '--secret-ref', 'META_APP'], '--app-secret', 'oops'], 'Unknown flag: --app-secret'],
      ['a repeated flag', ['register-channel-app', '--external-app-id', '1', '--external-app-id', '2'], '--external-app-id was given twice.'],
      ['a flag with no value', ['register-channel-app', '--external-app-id'], '--external-app-id needs a value.'],
      ['a flag whose value is another flag', ['register-channel-app', '--external-app-id', '--secret-ref'], '--external-app-id needs a value.'],
      ['a bare argument', ['register-channel-app', '123456'], 'Expected a --flag, found: 123456'],
      ['a malformed graph version', ['register-channel-app', '--external-app-id', '1', '--secret-ref', 'META_APP', '--graph-version', '21'], '--graph-version must look like v21.0.'],
    ])('refuses %s with a usage code', async (_label, argv, message) => {
      const h = harness();
      await expect(runCli(argv, env, h.io, h.deps)).resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toBe(message);
      expect(h.err[1]).toContain('usage: convo-db register-channel-app');
      expect(h.registerCalls).toEqual([]);
    });

    it('refuses a provider that does not use an app registration', async () => {
      const h = harness();
      await expect(runCli([...args, '--provider', 'web_chat'], env, h.io, h.deps)).resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toContain('Website Chat and Custom channels do not use an app registration');
      expect(h.registerCalls).toEqual([]);
    });

    it('refuses a graph version this build is not pinned to, because bumping it is a code change', async () => {
      const h = harness();
      await expect(runCli([...args, '--graph-version', 'v22.0'], env, h.io, h.deps)).resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toContain("must match this build's pinned version, v21.0");
      expect(h.registerCalls).toEqual([]);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('names CONVO_CHANNEL_SECRET_<REF> when it is %s, and attempts nothing', async (_label, value) => {
      const h = harness();
      await expect(runCli(args, { ...env, CONVO_CHANNEL_SECRET_META_APP: value }, h.io, h.deps))
        .resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toBe('Missing required environment variable: CONVO_CHANNEL_SECRET_META_APP');
      expect(h.registerCalls).toEqual([]);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('names CONVO_CHANNEL_VERIFY_TOKEN_<REF> when it is %s', async (_label, value) => {
      const h = harness();
      await expect(runCli(args, { ...env, CONVO_CHANNEL_VERIFY_TOKEN_META_APP: value }, h.io, h.deps))
        .resolves.toBe(EXIT_USAGE);
      expect(h.err[0]).toBe('Missing required environment variable: CONVO_CHANNEL_VERIFY_TOKEN_META_APP');
      expect(h.registerCalls).toEqual([]);
    });

    it('derives the secret variables from the ref it was given', async () => {
      const h = harness();
      await expect(runCli(
        ['register-channel-app', '--external-app-id', '99', '--secret-ref', 'SCHOOL_APP'],
        { ...fullEnv, CONVO_CHANNEL_SECRET_SCHOOL_APP: 's', CONVO_CHANNEL_VERIFY_TOKEN_SCHOOL_APP: 'v' },
        h.io, h.deps,
      )).resolves.toBe(EXIT_OK);
      expect(h.registerCalls[0]?.[2]).toMatchObject({ secretRef: 'SCHOOL_APP', appSecret: 's', verifyToken: 'v' });
    });

    it('reports a database failure on stderr with a failure exit code', async () => {
      const h = harness({ registerError: new Error('permission denied for table channel_apps') });
      await expect(runCli(args, env, h.io, h.deps)).resolves.toBe(EXIT_FAILED);
      expect(h.err).toEqual(['permission denied for table channel_apps']);
      expect(h.out).toEqual([]);
    });

    it('still reports a non-Error rejection rather than printing "undefined"', async () => {
      const h = harness({ registerError: 'connection terminated' });
      await expect(runCli(args, env, h.io, h.deps)).resolves.toBe(EXIT_FAILED);
      expect(h.err).toEqual(['connection terminated']);
    });
  });

  it('wires the real implementations in productionDeps', () => {
    expect(productionDeps.bootstrapCluster).toBeTypeOf('function');
    expect(productionDeps.migrate).toBeTypeOf('function');
    expect(productionDeps.registerChannelApp).toBeTypeOf('function');
  });
});
