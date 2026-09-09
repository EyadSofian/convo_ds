import { describe, expect, it } from 'vitest';
import { ApiConfigurationError, parseApiConfig } from './config.js';

function validEnv(): Record<string, string> {
  return {
    CONVO_DEPLOYMENT_MODE: 'saas',
    CONVO_INSTALLATION_NAME: 'Convo Test',
    CONVO_PUBLIC_BASE_URL: 'https://convo.example',
    CONVO_DEFAULT_LOCALE: 'ar',
    CONVO_SUPPORTED_LOCALES: 'ar,en',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'auth-hash-secret-value-longer-than-32-bytes',
    CONVO_BOOTSTRAP_TOKEN: 'bootstrap-token-value-longer-than-32-bytes',
    CONVO_IDEMPOTENCY_HASH_SECRET: 'idempotency-secret-longer-than-32-bytes',
    CONVO_PG_HOST: '127.0.0.1',
    CONVO_PG_PORT: '5432',
    CONVO_PG_DATABASE: 'convo',
    CONVO_PG_RUNTIME_ROLE: 'convo_app',
    CONVO_PG_RUNTIME_PASSWORD: 'secret',
  };
}

describe('parseApiConfig', () => {
  it('returns a frozen API config with safe listener defaults', () => {
    const config = parseApiConfig(validEnv());

    expect(config.processRole).toBe('api');
    expect(config.secrets).toEqual({
      authHash: 'auth-hash-secret-value-longer-than-32-bytes',
      bootstrapToken: 'bootstrap-token-value-longer-than-32-bytes',
      idempotencyHash: 'idempotency-secret-longer-than-32-bytes',
      // Empty and not an error: an installation with no channel connections
      // needs no encryption key, and refusing to boot over an unused feature
      // would be worse than refusing at the point of use.
      credentialKeys: [],
    });
    expect(config.channelSecrets).toEqual({});
    expect(config.workerConcurrency).toBe(4);
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.database).toEqual({
      host: '127.0.0.1',
      port: 5432,
      name: 'convo',
      user: 'convo_app',
      password: 'secret',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.secrets)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it.each(['ingress', 'realtime', 'worker-inbound', 'worker-campaign'])(
    'accepts %s as a process role',
    (role) => {
      // One artifact, seven jobs (DEP-01). A role the build does not know is
      // still refused, which is the next case.
      expect(parseApiConfig({ ...validEnv(), CONVO_PROCESS_ROLE: role }).processRole).toBe(role);
    },
  );

  it('reads channel app secrets from the environment, by reference name', () => {
    // The secret lives in configuration and never in a column: rotating it is
    // an operations act, and a database reader learns nothing.
    const config = parseApiConfig({
      ...validEnv(),
      CONVO_CHANNEL_SECRET_META_APP: ' the-app-secret ',
      CONVO_CHANNEL_SECRET_EMPTY: '   ',
      CONVO_NOT_A_CHANNEL_SECRET: 'ignored',
    });
    expect(config.channelSecrets).toEqual({ META_APP: 'the-app-secret' });
  });

  it('reads credential keys newest-first and refuses an empty list', () => {
    const config = parseApiConfig({ ...validEnv(), CONVO_CREDENTIAL_KEYS: ' v2:aaa , v1:bbb ' });
    expect(config.secrets.credentialKeys).toEqual(['v2:aaa', 'v1:bbb']);
    expect(() => parseApiConfig({ ...validEnv(), CONVO_CREDENTIAL_KEYS: ' , ' })).toThrow(
      /CONVO_CREDENTIAL_KEYS/,
    );
  });

  it('bounds worker concurrency', () => {
    expect(parseApiConfig({ ...validEnv(), CONVO_WORKER_CONCURRENCY: '16' }).workerConcurrency).toBe(
      16,
    );
    for (const value of ['0', '257', 'many', '2.5']) {
      expect(() => parseApiConfig({ ...validEnv(), CONVO_WORKER_CONCURRENCY: value })).toThrow(
        /CONVO_WORKER_CONCURRENCY/,
      );
    }
  });

  it('accepts a trimmed host and an ephemeral API port', () => {
    const config = parseApiConfig({
      ...validEnv(),
      CONVO_API_HOST: ' 127.0.0.1 ',
      CONVO_API_PORT: '0',
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(0);
  });

  it('aggregates installation, role, port, and database errors', () => {
    const env = {
      CONVO_DEPLOYMENT_MODE: 'wrong',
      CONVO_INSTALLATION_NAME: ' ',
      CONVO_PUBLIC_BASE_URL: 'file:///tmp/convo',
      CONVO_PROCESS_ROLE: 'worker',
      CONVO_API_PORT: '65536',
      CONVO_PG_PORT: '0',
      CONVO_PG_HOST: '',
    };

    expect(() => parseApiConfig(env)).toThrow(ApiConfigurationError);
    try {
      parseApiConfig(env);
    } catch (error) {
      const fields = (error as ApiConfigurationError).issues.map((item) => item.field);
      expect(fields).toEqual(
        expect.arrayContaining([
          'CONVO_DEPLOYMENT_MODE',
          'CONVO_INSTALLATION_NAME',
          'CONVO_PUBLIC_BASE_URL',
          'CONVO_PROCESS_ROLE',
          'CONVO_AUTH_HASH_SECRET',
          'CONVO_BOOTSTRAP_TOKEN',
          'CONVO_IDEMPOTENCY_HASH_SECRET',
          'CONVO_API_PORT',
          'CONVO_PG_PORT',
          'CONVO_PG_HOST',
          'CONVO_PG_DATABASE',
          'CONVO_PG_RUNTIME_ROLE',
          'CONVO_PG_RUNTIME_PASSWORD',
        ]),
      );
      expect((error as ApiConfigurationError).code).toBe('api_configuration_invalid');
      expect((error as Error).message).toContain('CONVO_PROCESS_ROLE');
    }
  });

  it('reports a missing process role and a non-numeric required database port', () => {
    const env: Record<string, string | undefined> = {
      ...validEnv(),
      CONVO_PROCESS_ROLE: undefined,
      CONVO_PG_PORT: 'five',
    };
    expect(() => parseApiConfig(env)).toThrow(/CONVO_PROCESS_ROLE.*CONVO_PG_PORT/);
  });

  it('rejects configured bootstrap and idempotency secrets shorter than 32 bytes', () => {
    expect(() =>
      parseApiConfig({
        ...validEnv(),
        CONVO_AUTH_HASH_SECRET: 'tiny',
        CONVO_BOOTSTRAP_TOKEN: 'short',
        CONVO_IDEMPOTENCY_HASH_SECRET: 'also-short',
      }),
    ).toThrow(/CONVO_AUTH_HASH_SECRET.*CONVO_BOOTSTRAP_TOKEN.*CONVO_IDEMPOTENCY_HASH_SECRET/);
  });
});
