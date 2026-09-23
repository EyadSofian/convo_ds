import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { NotificationDeviceService, parseWebPushSubscription } from './device.service.js';

const valid = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/opaque',
  keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
};

describe('Web Push subscription boundary', () => {
  it('accepts a supported HTTPS push service without returning extra fields', () => {
    expect(parseWebPushSubscription({ ...valid, privateData: 'must-not-survive' })).toEqual(valid);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://127.0.0.1/private',
    'https://fcm.googleapis.com.evil.test/send',
    'https://user:pass@fcm.googleapis.com/send',
    'https://fcm.googleapis.com/send#fragment',
    `https://fcm.googleapis.com/send/${'x'.repeat(2048)}`,
  ])('rejects an unsafe delivery endpoint: %s', (endpoint) => {
    expect(() => parseWebPushSubscription({ ...valid, endpoint })).toThrow();
  });

  it('rejects malformed encryption keys', () => {
    expect(() => parseWebPushSubscription({ ...valid, keys: { ...valid.keys, auth: 'short' } })).toThrow();
  });

  it('rejects malformed bodies, keys, credentials in URLs and explicit ports', () => {
    for (const body of [null, [], 'not-an-object', {}, { ...valid, keys: null },
      { ...valid, keys: [] }, { ...valid, keys: {} },
      { ...valid, endpoint: '::::' },
      { ...valid, endpoint: 'https://fcm.googleapis.com:444/send' },
      { ...valid, keys: { ...valid.keys, p256dh: '*'.repeat(65) } },
      { ...valid, keys: { ...valid.keys, p256dh: 'short' } },
      { ...valid, keys: { ...valid.keys, auth: '*'.repeat(16) } },
    ]) expect(() => parseWebPushSubscription(body)).toThrow();
  });
});

describe('notification devices', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const membershipId = '33333333-3333-4333-8333-333333333333';
  const session = {} as AuthenticatedSession;
  const config = {
    secrets: { credentialKeys: [`v1:${Buffer.alloc(32, 3).toString('base64')}`], idempotencyHash: 'fingerprint-secret' },
    webPush: { publicKey: Buffer.alloc(65, 4).toString('base64url') },
  } as unknown as ApiConfig;
  function service(rows: readonly Record<string, unknown>[] = []) {
    const query = vi.fn().mockResolvedValue({ rows });
    const authorization = { withPrincipal: async (_session: unknown, _tenantId: string, callback: (scope: unknown) => Promise<unknown>) =>
      callback({ sql: { query }, principal: { membershipId } }) } as unknown as AuthorizationService;
    return { device: new NotificationDeviceService(authorization, config), query };
  }

  it('encrypts subscriptions, retires a prior active endpoint and returns only public metadata', async () => {
    const { device, query } = service([{
      device_id: deviceId, platform: 'web_push', created_at: new Date('2026-01-01'),
      last_seen_at: new Date('2026-01-02'), enabled: true,
    }]);
    expect(device.publicKey()).toBe(config.webPush.publicKey);
    await device.register(session, tenantId, deviceId, valid);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('UPDATE notification_devices');
    const write = query.mock.calls[1];
    expect(write?.[0]).toContain('INSERT INTO notification_devices');
    expect(write?.[1]).toContain(tenantId);
    expect(write?.[1]).not.toContain(valid.endpoint);
    expect(await device.list(session, tenantId)).toEqual([{
      deviceId, platform: 'web_push', createdAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-02T00:00:00.000Z', enabled: true,
    }]);
    await device.revoke(session, tenantId, deviceId);
    expect(query.mock.lastCall?.[0]).toContain('UPDATE notification_devices');
    expect(query.mock.lastCall?.[1]).toEqual([membershipId, deviceId]);
  });

  it('fails closed for invalid device IDs and absent encryption configuration', async () => {
    const { device } = service();
    await expect(device.register(session, tenantId, 'bad', valid)).rejects.toThrow();
    await expect(device.revoke(session, tenantId, 'bad')).rejects.toThrow();
    const authorization = { withPrincipal: vi.fn() } as unknown as AuthorizationService;
    const unconfigured = new NotificationDeviceService(authorization, {
      ...config, secrets: { ...config.secrets, credentialKeys: [] }, webPush: { ...config.webPush, publicKey: null },
    });
    expect(unconfigured.publicKey()).toBeNull();
    await expect(unconfigured.register(session, tenantId, deviceId, valid)).rejects.toMatchObject({ status: 503 });
    expect((authorization.withPrincipal as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
