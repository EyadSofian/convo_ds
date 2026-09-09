import type { ErrorDetail } from '@convo/contracts';
import {
  type ConfigurationError,
  parseInstallationConfig,
  type EnvironmentSource,
  type InstallationConfig,
} from '@convo/domain';

/**
 * The process roles one artifact can start as (DEP-01).
 *
 * One build, seven jobs. They are separate roles rather than flags on a single
 * process because they have genuinely different failure modes and concurrency
 * needs: an ingress that must answer in 200 ms should not share a pool with a
 * campaign worker draining a million recipients (ADR-0005, ADR-0007).
 */
export const PROCESS_ROLES = [
  'api',
  'ingress',
  'realtime',
  'worker-inbound',
  'worker-interactive',
  'worker-campaign',
  'worker-integration',
] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

/** The roles that serve HTTP. The rest run loops and expose only probes. */
export const HTTP_ROLES: readonly ProcessRole[] = ['api', 'ingress', 'realtime'];

export interface ApiConfig extends InstallationConfig {
  readonly processRole: ProcessRole;
  readonly secrets: {
    readonly authHash: string;
    readonly bootstrapToken: string;
    readonly idempotencyHash: string;
    /**
     * `version:base64` entries, newest first. New credentials are sealed with
     * the first; the rest stay configured so records written under an older key
     * remain readable through a rotation.
     */
    readonly credentialKeys: readonly string[];
  };
  /**
   * Provider app secrets, by the reference name stored on `channel_apps`.
   *
   * They live in configuration, never in a column: an app secret belongs to the
   * installation, and rotating it should be an operations act rather than a
   * database write. Read from `CONVO_CHANNEL_SECRET_<REF>`.
   */
  readonly channelSecrets: Readonly<Record<string, string>>;
  /** Concurrency for a worker role. Ignored by the HTTP roles. */
  readonly workerConcurrency: number;
  readonly host: string;
  readonly port: number;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
  };
}

export class ApiConfigurationError extends Error {
  readonly code = 'api_configuration_invalid';
  readonly issues: readonly ErrorDetail[];

  constructor(issues: readonly ErrorDetail[]) {
    super(
      'API configuration is invalid: ' +
        issues.map((item) => item.field + ' (' + item.code + ')').join(', '),
    );
    this.name = 'ApiConfigurationError';
    this.issues = issues;
  }
}

export function parseApiConfig(env: EnvironmentSource): ApiConfig {
  const issues: ErrorDetail[] = [];
  let installation: InstallationConfig | undefined;
  try {
    installation = parseInstallationConfig(env);
  } catch (error) {
    issues.push(...(error as ConfigurationError).issues);
  }

  const processRole = readProcessRole(env, issues);
  const authHash = readSecret(env, 'CONVO_AUTH_HASH_SECRET', issues);
  const bootstrapToken = readSecret(env, 'CONVO_BOOTSTRAP_TOKEN', issues);
  const idempotencyHash = readSecret(env, 'CONVO_IDEMPOTENCY_HASH_SECRET', issues);
  const credentialKeys = readCredentialKeys(env, issues);
  const channelSecrets = readChannelSecrets(env);
  const workerConcurrency = readConcurrency(env, issues);
  const host = optional(env, 'CONVO_API_HOST') ?? '0.0.0.0';
  const port = readPort(env, 'CONVO_API_PORT', 3000, true, issues);
  const databaseHost = required(env, 'CONVO_PG_HOST', issues);
  const databasePort = readPort(env, 'CONVO_PG_PORT', undefined, false, issues);
  const databaseName = required(env, 'CONVO_PG_DATABASE', issues);
  const databaseUser = required(env, 'CONVO_PG_RUNTIME_ROLE', issues);
  const databasePassword = required(env, 'CONVO_PG_RUNTIME_PASSWORD', issues);

  if (issues.length > 0 || installation === undefined) {
    throw new ApiConfigurationError(issues);
  }

  return Object.freeze({
    ...installation,
    processRole,
    secrets: Object.freeze({ authHash, bootstrapToken, idempotencyHash, credentialKeys }),
    channelSecrets: Object.freeze(channelSecrets),
    workerConcurrency,
    host,
    port,
    database: Object.freeze({
      host: databaseHost,
      port: databasePort,
      name: databaseName,
      user: databaseUser,
      password: databasePassword,
    }),
  });
}

function readSecret(env: EnvironmentSource, field: string, issues: ErrorDetail[]): string {
  const value = required(env, field, issues);
  if (value !== '' && Buffer.byteLength(value, 'utf8') < 32) {
    issues.push(issue(field, 'too_short', field + ' must contain at least 32 bytes.'));
  }
  return value;
}

function readProcessRole(env: EnvironmentSource, issues: ErrorDetail[]): ProcessRole {
  const value = optional(env, 'CONVO_PROCESS_ROLE');
  if (value !== undefined && (PROCESS_ROLES as readonly string[]).includes(value)) {
    return value as ProcessRole;
  }
  issues.push(
    issue(
      'CONVO_PROCESS_ROLE',
      value === undefined ? 'required' : 'unsupported_value',
      `The process role must be one of: ${PROCESS_ROLES.join(', ')}.`,
    ),
  );
  return 'api';
}

/**
 * Credential encryption keys, newest first.
 *
 * Optional: an installation with no channel connections needs none, and
 * demanding one would make every existing deployment fail to boot over a
 * feature it does not use. The credential service refuses to seal anything when
 * the list is empty, which is the honest place for that failure — at the point
 * of use, naming the missing configuration.
 */
function readCredentialKeys(env: EnvironmentSource, issues: ErrorDetail[]): readonly string[] {
  const raw = optional(env, 'CONVO_CREDENTIAL_KEYS');
  if (raw === undefined) {
    return [];
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    issues.push(
      issue('CONVO_CREDENTIAL_KEYS', 'malformed', 'Provide at least one "version:base64" key.'),
    );
  }
  return entries;
}

const CHANNEL_SECRET_PREFIX = 'CONVO_CHANNEL_SECRET_';

function readChannelSecrets(env: EnvironmentSource): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(CHANNEL_SECRET_PREFIX)) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      secrets[name.slice(CHANNEL_SECRET_PREFIX.length)] = trimmed;
    }
  }
  return secrets;
}

function readConcurrency(env: EnvironmentSource, issues: ErrorDetail[]): number {
  const raw = optional(env, 'CONVO_WORKER_CONCURRENCY');
  if (raw === undefined) {
    return 4;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 256) {
    issues.push(
      issue('CONVO_WORKER_CONCURRENCY', 'out_of_range', 'Concurrency is an integer from 1 to 256.'),
    );
    return 4;
  }
  return value;
}

function required(env: EnvironmentSource, field: string, issues: ErrorDetail[]): string {
  const value = optional(env, field);
  if (value === undefined) {
    issues.push(issue(field, 'required', field + ' must be configured.'));
    return '';
  }
  return value;
}

function readPort(
  env: EnvironmentSource,
  field: string,
  fallback: number | undefined,
  allowZero: boolean,
  issues: ErrorDetail[],
): number {
  const raw = optional(env, field);
  if (raw === undefined && fallback !== undefined) {
    return fallback;
  }
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65535) {
    issues.push(
      issue(
        field,
        'not_a_port',
        field + ' must be an integer between ' + minimum + ' and 65535.',
      ),
    );
    return fallback ?? minimum;
  }
  return value;
}

function optional(env: EnvironmentSource, field: string): string | undefined {
  const value = env[field]?.trim();
  return value === '' ? undefined : value;
}

function issue(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
