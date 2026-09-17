import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config.js';
import { HealthService } from './health.service.js';

/**
 * The readiness check's two failure shapes.
 *
 * They are reported separately because they mean different things to whoever is
 * woken up: `unavailable` is "the database refused us", `timeout` is "the
 * database never answered", and the second usually means saturation rather than
 * an outage. Neither ever carries the driver's own message, which names the
 * host, port and role it tried.
 */

function serviceWith(query: () => Promise<unknown>): HealthService {
  return new HealthService({ query } as unknown as Pool, {
    processRole: 'api',
  } as unknown as ApiConfig);
}

describe('readiness', () => {
  it('is ready when the database answers', async () => {
    const report = await serviceWith(() => Promise.resolve({ rows: [] })).readiness();
    expect(report.ready).toBe(true);
    expect(report.role).toBe('api');
    expect(report.checks[0]).toMatchObject({ name: 'database', ok: true });
    expect(report.checks[0]?.code).toBeUndefined();
  });

  it('reports `unavailable` when the database refuses', async () => {
    const report = await serviceWith(() =>
      Promise.reject(new Error('connection to 10.0.0.5:5432 refused')),
    ).readiness();
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('never repeats the driver message, which names the host and role', async () => {
    const report = await serviceWith(() =>
      Promise.reject(new Error('password authentication failed for user "convo_app"')),
    ).readiness();
    expect(JSON.stringify(report)).not.toContain('convo_app');
  });

  it('reports `timeout` when the database never answers', async () => {
    // Distinguished from a refusal because it usually means saturation rather
    // than an outage, and the operator action differs.
    const report = await serviceWith(() => new Promise(() => undefined)).readiness();
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({ ok: false, code: 'timeout' });
    // The check is bounded: a readiness probe that can hang reports nothing.
    expect(report.checks[0]?.durationMs).toBeGreaterThanOrEqual(1_900);
  }, 10_000);

  it('survives a rejection that is not an Error at all', async () => {
    const report = await serviceWith(() => Promise.reject('a bare string')).readiness();
    expect(report.checks[0]).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
