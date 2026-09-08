import { bootstrapCluster } from './bootstrap.js';
import { migrate } from './migrate.js';
import type { AppliedMigration, ClusterCredentials, DatabaseNames } from './types.js';

/**
 * Argument, environment and exit-code logic for the database CLI.
 *
 * All of it is a pure function of `argv` and `env` writing through injected
 * sinks, so the operator-visible behaviour -- which exit code, which message,
 * which stream -- is asserted directly instead of inferred from a process that
 * happened not to crash. `bin.ts` is the only thing that touches `process`.
 */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CliDeps {
  readonly bootstrapCluster: (
    cluster: ClusterCredentials,
    names: DatabaseNames,
  ) => Promise<void>;
  readonly migrate: (
    cluster: ClusterCredentials,
    names: DatabaseNames,
  ) => Promise<AppliedMigration[]>;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const productionDeps: CliDeps = { bootstrapCluster, migrate };

const COMMANDS = ['bootstrap', 'migrate'] as const;
type Command = (typeof COMMANDS)[number];

export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const command = argv[0];
  if (!isCommand(command)) {
    io.err(`usage: convo-db <${COMMANDS.join('|')}>`);
    return EXIT_USAGE;
  }

  let cluster: ClusterCredentials;
  let names: DatabaseNames;
  try {
    cluster = readCluster(env);
    names = readNames(env);
  } catch (error) {
    io.err(messageOf(error));
    return EXIT_USAGE;
  }

  try {
    if (command === 'bootstrap') {
      await deps.bootstrapCluster(cluster, names);
      io.out('bootstrap complete');
      return EXIT_OK;
    }

    const applied = await deps.migrate(cluster, names);
    if (applied.length === 0) {
      io.out('no pending migrations');
    } else {
      for (const migration of applied) {
        io.out(`applied ${migration.name}`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    io.err(messageOf(error));
    return EXIT_FAILED;
  }
}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function readCluster(env: Readonly<Record<string, string | undefined>>): ClusterCredentials {
  const port = Number(required(env, 'CONVO_PG_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CONVO_PG_PORT must be an integer between 1 and 65535');
  }
  return {
    host: required(env, 'CONVO_PG_HOST'),
    port,
    // Only `bootstrap` needs superuser credentials; `migrate` connects as the
    // migration role, so an empty value here is a legitimate migrate-only
    // deployment rather than a misconfiguration.
    superUser: env['CONVO_PG_SUPERUSER'] ?? '',
    superPassword: env['CONVO_PG_SUPERPASSWORD'] ?? '',
  };
}

function readNames(env: Readonly<Record<string, string | undefined>>): DatabaseNames {
  return {
    database: required(env, 'CONVO_PG_DATABASE'),
    migrationRole: required(env, 'CONVO_PG_MIGRATION_ROLE'),
    migrationPassword: required(env, 'CONVO_PG_MIGRATION_PASSWORD'),
    runtimeRole: required(env, 'CONVO_PG_RUNTIME_ROLE'),
    runtimePassword: required(env, 'CONVO_PG_RUNTIME_PASSWORD'),
  };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
