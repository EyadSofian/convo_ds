import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { INSTALLATION_IDEMPOTENCY_CONTEXT_ID } from '../../apps/api/src/instance/instance.service.js';
import {
  asExecutor,
  enableInstallationContext,
  withTenant,
} from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import {
  clusterCredentials,
  createScratchDatabase,
  migrateScratch,
  scratchMigrationPool,
  scratchRuntimePool,
} from '../support/scratch.js';

const BOOTSTRAP_TOKEN = 'rollback-bootstrap-token-value-00000001';

function bootstrapHeaders(requestId: string) {
  return {
    'x-bootstrap-token': BOOTSTRAP_TOKEN,
    'idempotency-key': 'atomic-1',
    'x-request-id': requestId,
  };
}

function configFor(names: DatabaseNames) {
  const cluster = clusterCredentials();
  return parseApiConfig({
    CONVO_DEPLOYMENT_MODE: 'self_hosted_single',
    CONVO_INSTALLATION_NAME: 'Rollback Test',
    CONVO_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    CONVO_PROCESS_ROLE: 'api',
    CONVO_AUTH_HASH_SECRET: 'rollback-auth-hash-secret-value-00001',
    CONVO_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    CONVO_IDEMPOTENCY_HASH_SECRET: 'rollback-idempotency-secret-value-0001',
    CONVO_API_PORT: '0',
    CONVO_PG_HOST: cluster.host,
    CONVO_PG_PORT: String(cluster.port),
    CONVO_PG_DATABASE: names.database,
    CONVO_PG_RUNTIME_ROLE: names.runtimeRole,
    CONVO_PG_RUNTIME_PASSWORD: names.runtimePassword,
  });
}

describe('idempotency transaction atomicity', () => {
  it('rolls the bootstrap effect and key back when result persistence fails', async () => {
    const names = await createScratchDatabase('convo_api_atomic');
    await migrateScratch(names);
    const pool = scratchRuntimePool(names);
    const migration = scratchMigrationPool(names);
    let app: NestFastifyApplication | undefined;
    try {
      const config = configFor(names);
      await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
      await migration.query(
        "CREATE FUNCTION fail_idempotency_completion() RETURNS trigger LANGUAGE plpgsql AS $$ " +
          "BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'forced completion failure'; " +
          'END IF; RETURN NEW; END; $$',
      );
      await migration.query(
        'CREATE TRIGGER fail_idempotency_completion BEFORE UPDATE ON idempotency_records ' +
          'FOR EACH ROW EXECUTE FUNCTION fail_idempotency_completion()',
      );

      app = await createApiApplication(config, pool);
      const server = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
      const payload = {
        companyName: 'Atomic Co',
        companySlug: 'atomic-co',
        ownerEmail: 'owner@atomic.test',
        ownerPassword: 'a sufficiently long password',
      };
      const failed = await server.inject({
        method: 'POST',
        url: '/api/v1/instance/bootstrap',
        headers: bootstrapHeaders('atomic-failed'),
        payload,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        error: { code: 'internal_error', request_id: 'atomic-failed' },
      });
      expect(failed.body).not.toContain('forced completion failure');

      const afterFailure = await withTenant(
        pool,
        INSTALLATION_IDEMPOTENCY_CONTEXT_ID,
        async (client) => {
          await enableInstallationContext(asExecutor(client));
          return client.query<{
            users: string;
            keys: string;
            bootstrap_state: string;
          }>(
            "SELECT (SELECT count(*) FROM users)::text AS users, " +
              '(SELECT count(*) FROM idempotency_records)::text AS keys, ' +
              '(SELECT bootstrap_state FROM installations WHERE singleton IS TRUE) AS bootstrap_state',
          );
        },
      );
      expect(afterFailure.rows[0]).toEqual({
        users: '0',
        keys: '0',
        bootstrap_state: 'pending',
      });

      await migration.query('DROP TRIGGER fail_idempotency_completion ON idempotency_records');
      await migration.query('DROP FUNCTION fail_idempotency_completion()');
      const retry = await server.inject({
        method: 'POST',
        url: '/api/v1/instance/bootstrap',
        headers: bootstrapHeaders('atomic-retry'),
        payload,
      });
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toMatchObject({ request_id: 'atomic-retry' });
    } finally {
      if (app !== undefined) {
        await app.close();
      } else {
        await pool.end();
      }
      await migration.end();
    }
  }, 180_000);
});
