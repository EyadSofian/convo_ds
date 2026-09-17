import type { FastifyInstance } from 'fastify';

export interface ApiRoute {
  readonly method: string;
  readonly path: string;
}

const ROUTES = new WeakMap<object, ApiRoute[]>();

export function attachRouteInventory(server: FastifyInstance): void {
  const routes: ApiRoute[] = [];
  ROUTES.set(server, routes);
  server.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') {
        routes.push({ method, path: route.url });
      }
    }
  });
}

/**
 * The operational probes, which are not part of the versioned API contract.
 *
 * `/live` and `/ready` are addressed by the platform, not by a client. They sit
 * outside `/api/v1` deliberately — a health check that moves with the API
 * version starts returning 404 on the next major, and every probe reads a 404 as
 * unhealthy — so they cannot be expressed in an OpenAPI document whose server
 * URL *is* `/api/v1`.
 *
 * Listed one by one rather than matched by a prefix, so adding an unversioned
 * route stays a deliberate edit here and cannot quietly escape the contract test
 * that compares registered routes against the spec in both directions. They are
 * documented in docs/runbooks/RAILWAY_PRODUCTION.md instead.
 */
const OPERATIONAL_PATHS: readonly string[] = ['/live', '/ready'];

export function registeredApiRoutes(server: FastifyInstance): readonly ApiRoute[] {
  return [...(ROUTES.get(server) ?? [])]
    .filter((route) => !OPERATIONAL_PATHS.includes(route.path))
    .sort((left, right) => (left.path + left.method).localeCompare(right.path + right.method));
}

/** The probes, so a test can assert they exist rather than only that they are excluded. */
export function registeredOperationalRoutes(server: FastifyInstance): readonly ApiRoute[] {
  /* c8 ignore next -- the inventory is attached before any route is registered */
  return [...(ROUTES.get(server) ?? [])]
    .filter((route) => OPERATIONAL_PATHS.includes(route.path))
    .sort((left, right) => (left.path + left.method).localeCompare(right.path + right.method));
}
