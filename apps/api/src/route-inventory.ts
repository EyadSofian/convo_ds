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

export function registeredApiRoutes(server: FastifyInstance): readonly ApiRoute[] {
  return [...(ROUTES.get(server) ?? [])].sort((left, right) =>
    (left.path + left.method).localeCompare(right.path + right.method),
  );
}
