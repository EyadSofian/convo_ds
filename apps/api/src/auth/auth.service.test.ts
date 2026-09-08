import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import type { PasswordHasher } from '../tokens.js';
import type { AuthRateLimiter } from './auth-rate-limiter.js';
import { AuthService } from './auth.service.js';

const CONFIG = {
  publicBaseUrl: 'http://127.0.0.1:3000',
  secrets: { authHash: 'unit-auth-hash-secret-value-0000000001' },
} as ApiConfig;

function serviceWith(
  query: ReturnType<typeof vi.fn>,
  verify: ReturnType<typeof vi.fn>,
): AuthService {
  const rateLimiter = {
    consume: vi.fn().mockResolvedValue({ status: 'allowed', remaining: 4 }),
    reset: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthRateLimiter;
  return new AuthService(
    CONFIG,
    { query } as unknown as Pool,
    { hash: vi.fn(), verify } as unknown as PasswordHasher,
    rateLimiter,
  );
}

describe('AuthService defensive authentication paths', () => {
  it('fails closed when PostgreSQL does not return the inserted session', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'owner@example.test',
            password_hash: 'stored-hash',
            status: 'active',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWith(query, vi.fn().mockResolvedValue(true));

    await expect(
      service.login(
        { email: 'owner@example.test', password: 'password' },
        '127.0.0.1',
        undefined,
      ),
    ).rejects.toThrow('Session insert did not return the created row');
    expect(query.mock.calls[1]?.[1]?.[5]).toBeNull();
    expect(service.secureCookies).toBe(false);
  });

  it('maps a corrupt password hash and an inactive account to the generic failure', async () => {
    const activeQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'owner@example.test',
          password_hash: 'corrupt',
          status: 'active',
        },
      ],
    });
    await expect(
      serviceWith(activeQuery, vi.fn().mockRejectedValue(new Error('corrupt hash'))).login(
        { email: 'owner@example.test', password: 'password' },
        '127.0.0.1',
        'browser',
      ),
    ).rejects.toMatchObject({ code: 'credentials_invalid' });

    const suspendedQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'owner@example.test',
          password_hash: 'stored-hash',
          status: 'suspended',
        },
      ],
    });
    await expect(
      serviceWith(suspendedQuery, vi.fn().mockResolvedValue(true)).login(
        { email: 'owner@example.test', password: 'password' },
        '127.0.0.1',
        'browser',
      ),
    ).rejects.toMatchObject({ code: 'credentials_invalid' });
  });
});
