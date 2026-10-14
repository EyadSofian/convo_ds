import { bootstrapCluster } from './bootstrap.js';
import {
  parseRegisterChannelApp,
  registerChannelApp,
  secretVariableOf,
  verifyTokenVariableOf,
} from './channel-app.js';
import type { RegisterChannelAppInput, RegisteredChannelApp } from './channel-app.js';
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
  readonly registerChannelApp: (
    cluster: ClusterCredentials,
    names: DatabaseNames,
    input: RegisterChannelAppInput,
  ) => Promise<RegisteredChannelApp>;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const productionDeps: CliDeps = { bootstrapCluster, migrate, registerChannelApp };

const COMMANDS = ['bootstrap', 'migrate', 'register-channel-app'] as const;
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

    if (command === 'register-channel-app') {
      return await register(argv.slice(1), env, io, deps, cluster, names);
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

const REGISTER_USAGE =
  'usage: convo-db register-channel-app --external-app-id <numeric Meta App ID> --secret-ref <REF> [--provider meta] [--graph-version vNN.N]';

/**
 * Registers the Meta app a channel is connected through.
 *
 * Separated from `runCli`'s body because it has three distinct refusals an
 * operator needs told apart — a malformed flag, an unset secret variable, and a
 * database failure — and folding them into one `catch` would answer all three
 * with the same exit code.
 *
 * The two secrets are read here rather than passed as flags; `channel-app.ts`
 * says why. A missing one is a usage error, not a failure: nothing was
 * attempted, and the fix is in the operator's environment.
 */
async function register(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps,
  cluster: ClusterCredentials,
  names: DatabaseNames,
): Promise<number> {
  const parsed = parseRegisterChannelApp(argv);
  if (!parsed.ok) {
    io.err(parsed.error);
    io.err(REGISTER_USAGE);
    return EXIT_USAGE;
  }

  const secretVariable = secretVariableOf(parsed.value.secretRef);
  const verifyVariable = verifyTokenVariableOf(parsed.value.secretRef);
  const appSecret = env[secretVariable];
  const verifyToken = env[verifyVariable];
  // Named individually. "One of two variables is missing" would send an
  // operator to check both, and these are the two values that are least
  // convenient to go and look up again.
  if (appSecret === undefined || appSecret === '') {
    io.err(`Missing required environment variable: ${secretVariable}`);
    io.err('It must hold the Meta app secret, and is the same variable the API reads at runtime.');
    return EXIT_USAGE;
  }
  if (verifyToken === undefined || verifyToken === '') {
    io.err(`Missing required environment variable: ${verifyVariable}`);
    io.err('It must hold the webhook verify token you will enter in the Meta webhook configuration.');
    return EXIT_USAGE;
  }

  const app = await deps.registerChannelApp(cluster, names, {
    provider: parsed.value.provider,
    externalAppId: parsed.value.externalAppId,
    secretRef: parsed.value.secretRef,
    graphVersion: parsed.value.graphVersion,
    appSecret,
    verifyToken,
  });

  io.out(app.created ? `registered channel app ${app.id}` : `rotated channel app ${app.id}`);
  io.out(`provider=${app.provider} external_app_id=${app.externalAppId} secret_ref=${app.secretRef} graph_version=${app.graphVersion}`);
  // The id is the webhook path segment, so it is printed as the path rather
  // than as a bare uuid the operator has to work out what to do with.
  io.out(`webhook path: /api/v1/webhooks/meta/${app.id}`);
  return EXIT_OK;
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
