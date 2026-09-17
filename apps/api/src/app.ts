import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { asExecutor } from '@convo/database';
import { applyInstallationConfig } from '@convo/domain';
import pg from 'pg';
import { ApiModule } from './api.module.js';
import type { RecoveryDeliveryPort } from './auth/recovery-delivery.js';
import type { BrokerPort } from './broker/broker.port.js';
import type { ChannelTransportPort } from './channels/channel-transport.js';
import type { EmailProviderPort } from './email/email-provider.port.js';
import { attachRawBodyParser } from './channels/raw-body.js';
import type { InvitationDeliveryPort } from './people/invitation-delivery.js';
import { trustProxyHops } from './client-address.js';
import { ApiConfigurationError, HTTP_ROLES, parseApiConfig } from './config.js';
import type { ApiConfig, ProcessRole } from './config.js';
import { ApiErrorFilter } from './error.filter.js';
import { requestIdFor } from './request-id.js';
import { attachRouteInventory } from './route-inventory.js';
import { createLogger, type Logger } from './observability/logger.js';

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
  readonly emailProvider?: EmailProviderPort | undefined;
  /** Injected so a test can read request lines instead of a process's stdout. */
  readonly logger?: Logger | undefined;
}

export async function createApiApplication(
  config: ApiConfig,
  pool: InstanceType<typeof Pool>,
  adapters: ApiAdapters = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    // Which hop's address is this request's client. Zero by default; on
    // Railway it is the edge plus our own web proxy. See client-address.ts:
    // getting this wrong locks out every user or exempts every attacker.
    trustProxy: trustProxyHops(config.trustedProxyHops),
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
  // The probes stay off the versioned prefix: they are addressed by the
  // platform, and a health check that moves with the API version starts
  // returning 404 on the next major — which every probe reads as unhealthy.
  app.setGlobalPrefix('api/v1', { exclude: ['live', 'ready'] });
  app.useGlobalFilters(new ApiErrorFilter());
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  attachRequestLog(adapter.getInstance() as unknown as FastifyInstance, config, adapters.logger);
  await app.init();
  return app;
}

/**
 * One line per completed request.
 *
 * `routerPath` rather than `url`, deliberately: the url carries ids, and a log
 * keyed on `/api/v1/tenants/:tenantId/conversations` is both safer and far more
 * useful than a million distinct strings nobody can aggregate. The request id is
 * the same value the response carries in `x-request-id`, so a user reporting a
 * failure hands over the exact key to find it.
 *
 * Nothing else about the request is read. No headers, no body, no query — see
 * the note at the top of observability/logger.ts for why that is a structural
 * rule here rather than a deny-list.
 */
function attachRequestLog(
  server: FastifyInstance,
  config: ApiConfig,
  injected: Logger | undefined,
): void {
  const log =
    injected ??
    createLogger({
      service: 'convo-api',
      processRole: config.processRole,
      level: config.logLevel,
    });
  server.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    log[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info']('request_completed', {
      request_id: String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status,
      duration_ms: Math.round(reply.elapsedTime),
    });
  });
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
 * Whether this role must reach a durable broker before it may run.
 *
 * This used to be "the integration worker always must", and that single line
 * kept the whole automation engine out of production: schedule materialization
 * had been added to the integration worker's tick, the installation has no
 * broker, so the process failed closed at boot and was simply never deployed.
 * Automation scheduling then ran nowhere at all (ADR-0018).
 *
 * The rule now distinguishes the two things that were conflated:
 *
 * - **The broker relay** genuinely cannot work without a broker. But "no broker
 *   is configured" is a fact about the installation, not a failure: the relay
 *   skips, its outbox grows visibly, and the rest of the worker's jobs — email
 *   delivery above all — carry on.
 * - **A broker that is configured and unreachable** is a failure, and this is
 *   where failing closed earns its keep: the process refuses to start rather
 *   than reporting healthy while events pile up unsent.
 *
 * So the check is conditional on configuration, and `worker-automation` — which
 * owns scheduling and touches no broker — never consults it.
 */
export function requiresBroker(role: ProcessRole, brokerConfigured: boolean): boolean {
  return role === 'worker-integration' && brokerConfigured;
}

/**
 * Whether this installation has been given a durable broker at all.
 *
 * Presence of configuration, not reachability. Reachability is the health check
 * above, and confusing the two is how "we never configured one" becomes
 * indistinguishable from "ours is down".
 */
export function brokerConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['CONVO_BROKER_URL'] ?? '').trim() !== '';
}

export function bootFailureMessage(error: unknown): string {
  if (error instanceof ApiConfigurationError || error instanceof ApiBootError) {
    return error.code + ': ' + error.message;
  }
  return 'api_boot_failed: database or application startup failed';
}
