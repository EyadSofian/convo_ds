import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registeredApiRoutes } from './route-inventory.js';

describe('registeredApiRoutes', () => {
  it('returns an empty immutable snapshot for a server that was not attached', () => {
    const first = registeredApiRoutes({} as FastifyInstance);
    expect(first).toEqual([]);
  });
});
