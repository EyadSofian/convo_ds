import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { PushOutboxService, classifyPushFailure } from './push-outbox.service.js';

describe('Web Push failure handling', () => {
  it.each([404, 410])('revokes expired subscriptions on HTTP %i', (status) => {
    expect(classifyPushFailure(status, 1)).toEqual({ action: 'revoke', code: 'subscription_expired' });
  });

  it.each([400, 401, 403, 413, 422])('does not retry permanent HTTP %i', (status) => {
    expect(classifyPushFailure(status, 1)).toEqual({ action: 'fail', code: `push_http_${status}` });
  });

  it.each([0, 408, 429, 500, 503])('retries transient status %i, then stops at the attempt cap', (status) => {
    const code = status === 0 ? 'push_network' : `push_http_${status}`;
    expect(classifyPushFailure(status, 1)).toEqual({ action: 'retry', code });
    expect(classifyPushFailure(status, 5)).toEqual({ action: 'fail', code });
  });

  it('keeps worker credentials fail-closed and leaves optional API push disabled', async () => {
    const pool = {} as Pool;
    const config = {
      processRole: 'worker-integration', secrets: { credentialKeys: [], idempotencyHash: 'fingerprint-secret' },
      webPush: { publicKey: 'public', privateKey: 'private', subject: 'mailto:ops@example.test' },
    } as unknown as ApiConfig;
    expect(() => new PushOutboxService(pool, config)).toThrow(/credential encryption/);
    const api = new PushOutboxService(pool, { ...config, processRole: 'api',
      webPush: { publicKey: null, privateKey: null, subject: null } });
    expect(await api.drain(5)).toBe(0);
  });

  it('stops on an empty lease scan and skips a queue row whose delivery vanished', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const config = {
      processRole: 'worker-integration',
      secrets: { credentialKeys: [`v1:${Buffer.alloc(32, 3).toString('base64')}`], idempotencyHash: 'fingerprint-secret' },
      webPush: { publicKey: 'public', privateKey: 'private', subject: 'mailto:ops@example.test' },
    } as unknown as ApiConfig;
    const emptyPool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    expect(await new PushOutboxService(emptyPool, config).drain(1)).toBe(0);
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.includes('app_current_tenant()')
        ? [{ tenant: tenantId }] : [] })), release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: tenantId, tenant_id: tenantId, attempt_count: 1 }] })
      .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const sender = vi.fn();
    expect(await new PushOutboxService(pool, config, sender).drain(1)).toBe(1);
    expect(sender).not.toHaveBeenCalled();
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[1])
      .toEqual([tenantId, 'skipped', 'no_longer_relevant']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
