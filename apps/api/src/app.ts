import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { asExecutor } from '@convo/database';
import { applyInstallationConfig } from '@convo/domain';
import pg from 'pg';
import { ApiModule } from './api.module.js';
import type { RecoveryDeliveryPort } from './auth/recovery-delivery.js';
import type { InvitationDeliveryPort } from './people/invitation-delivery.js';
import { ApiConfigurationError, parseApiConfig, type ApiConfig } from './config.js';
import { ApiErrorFilter } from './error.filter.js';
import { requestIdFor } from './request-id.js';
import { attachRouteInventory } from './route-inventory.js';

const { Pool } = pg;

export class ApiBootError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiBootError';
    this.code = code;
  }
}

/**
 * Adapters chosen at the composition root.
 *
 * This is where an outbound integration is selected, which is the only place
 * that should know which one is in use. Omitted entries fall back to the
 * default adapter in `ApiModule`.
 */
export interface ApiAdapters {
  readonly recoveryDelivery?: RecoveryDeliveryPort | undefined;
  readonly invitationDelivery?: InvitationDeliveryPort | undefined;
}

export async function createApiApplication(
  config: ApiConfig,
  pool: InstanceType<typeof Pool>,
  adapters: ApiAdapters = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    genReqId: requestIdFor,
  });
  attachRouteInventory(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.register(config, pool, adapters),
    adapter,
    { logger: false },
  );
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiErrorFilter());
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  await app.init();
  return app;
}

export async function startApi(
  env: Readonly<Record<string, string | undefined>>,
): Promise<INestApplication> {
  const config = parseApiConfig(env);
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    max: 10,
  });
  let app: NestFastifyApplication | undefined;
  try {
    const state = await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
    if (state.status === 'mismatch') {
      throw new ApiBootError(state.code, state.message);
    }
    app = await createApiApplication(config, pool);
    await app.listen(config.port, config.host);
    return app;
  } catch (error) {
    if (app === undefined) {
      await pool.end();
    } else {
      await app.close();
    }
    throw error;
  }
}

export function bootFailureMessage(error: unknown): string {
  if (error instanceof ApiConfigurationError || error instanceof ApiBootError) {
    return error.code + ': ' + error.message;
  }
  return 'api_boot_failed: database or application startup failed';
}
