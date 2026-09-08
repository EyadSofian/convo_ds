import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import { AuthRateLimiter } from './auth-rate-limiter.js';

const CONFIG = {
  secrets: { authHash: 'rate-limit-auth-secret-value-000000001' },
} as ApiConfig;

function poolWith(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows } as QueryResult);
  return { pool: { query } as unknown as Pool, query };
}

describe('AuthRateLimiter', () => {
  it('allows attempts through the configured threshold', async () => {
    const fake = poolWith([{ attempt_count: 5, retry_after_seconds: 700 }]);
    await expect(new AuthRateLimiter(CONFIG, fake.pool).consume('login', 'subject')).resolves.toEqual(
      { status: 'allowed' },
    );
    expect(fake.query.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      900,
    ]);
  });

  it('blocks excess attempts with the database-calculated retry delay', async () => {
    const fake = poolWith([{ attempt_count: 6, retry_after_seconds: 640 }]);
    await expect(new AuthRateLimiter(CONFIG, fake.pool).consume('login', 'subject')).resolves.toEqual(
      { status: 'blocked', retryAfterSeconds: 640 },
    );
  });

  it('fails closed if the atomic counter returns no row', async () => {
    await expect(
      new AuthRateLimiter(CONFIG, poolWith([]).pool).consume('login', 'subject'),
    ).rejects.toThrow('Rate limit counter did not return a result');
  });

  it('resets only the keyed bucket', async () => {
    const fake = poolWith([]);
    await new AuthRateLimiter(CONFIG, fake.pool).reset('login', 'subject');
    expect(fake.query.mock.calls[0]?.[0]).toContain('DELETE FROM auth_rate_limits');
    expect(fake.query.mock.calls[0]?.[1]?.[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
