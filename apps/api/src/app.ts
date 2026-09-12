import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { asExecutor } from '@convo/database';
import { applyInstallationConfig } from '@convo/domain';
import pg from 'pg';
import { ApiModule } from './api.module.js';
import type { RecoveryDeliveryPort } from './auth/recovery-delivery.js';
import type { BrokerPort } from './broker/broker.port.js';
import type { ChannelTransportPort } from './channels/channel-transport.js';
import { attachRawBodyParser } from './channels/raw-body.js';
import type { InvitationDeliveryPort } from './people/invitation-delivery.js';
import { ApiConfigurationError, HTTP_ROLES, parseApiConfig } from './config.js';
import type { ApiConfig, ProcessRole } from './config.js';
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
  readonly channelTransport?: ChannelTransportPort | undefined;
  readonly broker?: BrokerPort | undefined;
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
  // Our own JSON parser, and Nest's turned off. The webhook routes authenticate
  // on the exact bytes, and Nest's parser hands a route a parsed object with the
  // bytes already discarded — so there is one parser, ours, and it decides per
  // route whether to parse or to keep the buffer.
  attachRawBodyParser(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.register(config, pool, adapters),
    adapter,
    { logger: false, bodyParser: false },
  );
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiErrorFilter());
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  await app.init();
  return app;
}

/**
 * Starts this process in whichever role it was configured for.
 *
 * One artifact, eight roles. The HTTP roles listen; the five worker roles run a
 * loop and never bind a port. Which one this is comes from configuration alone,
 * so a deployment scales a role by starting more copies of the same image with a
 * different `CONVO_PROCESS_ROLE` (DEP-01).
 */
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
    // A worker's appetite is its concurrency; an HTTP role's is its traffic.
    // Sharing one number would make a campaign worker either starved or
    // wasteful depending on which role it was chosen for.
    max: HTTP_ROLES.includes(config.processRole) ? 10 : Math.max(4, config.workerConcurrency),
  });
  let app: NestFastifyApplication | undefined;
  try {
    const state = await applyInstallationConfig(asExecutor(pool), config.deploymentMode);
    if (state.status === 'mismatch') {
      throw new ApiBootError(state.code, state.message);
    }
    app = await createApiApplication(config, pool);
    if (HTTP_ROLES.includes(config.processRole)) {
      await app.listen(config.port, config.host);
    }
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

/**
 * Whether this role must have a durable broker before it may run.
 *
 * The integration worker exists to publish to one, so starting it without one
 * would be a process whose only job is impossible. Everything else degrades
 * without a broker — the outbox simply grows — so nothing else fails closed on
 * its absence.
 */
export function requiresBroker(role: ProcessRole): boolean {
  return role === 'worker-integration';
}

export function bootFailureMessage(error: unknown): string {
  if (error instanceof ApiConfigurationError || error instanceof ApiBootError) {
    return error.code + ': ' + error.message;
  }
  return 'api_boot_failed: database or application startup failed';
}
