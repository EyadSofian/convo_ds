import type { ErrorDetail } from '@convo/contracts';
import {
  type ConfigurationError,
  parseInstallationConfig,
  type EnvironmentSource,
  type InstallationConfig,
} from '@convo/domain';

export interface ApiConfig extends InstallationConfig {
  readonly processRole: 'api';
  readonly secrets: {
    readonly authHash: string;
    readonly bootstrapToken: string;
    readonly idempotencyHash: string;
  };
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

  const processRole = readApiRole(env, issues);
  const authHash = readSecret(env, 'CONVO_AUTH_HASH_SECRET', issues);
  const bootstrapToken = readSecret(env, 'CONVO_BOOTSTRAP_TOKEN', issues);
  const idempotencyHash = readSecret(env, 'CONVO_IDEMPOTENCY_HASH_SECRET', issues);
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
    secrets: Object.freeze({ authHash, bootstrapToken, idempotencyHash }),
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

function readApiRole(env: EnvironmentSource, issues: ErrorDetail[]): 'api' {
  const value = optional(env, 'CONVO_PROCESS_ROLE');
  if (value !== 'api') {
    issues.push(
      issue(
        'CONVO_PROCESS_ROLE',
        value === undefined ? 'required' : 'unsupported_value',
        'The API process role must be exactly "api".',
      ),
    );
  }
  return 'api';
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
