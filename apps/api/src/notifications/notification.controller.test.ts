import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/auth.service.js';
import type { NotificationService } from './notification.service.js';
import type { NotificationDeviceService } from './device.service.js';
import { NotificationController } from './notification.controller.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

function harness() {
  const session = { id: 'session' };
  const auth = { authenticate: vi.fn().mockResolvedValue(session), requireCsrf: vi.fn() };
  const notifications = {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    unreadCount: vi.fn().mockResolvedValue(0), markRead: vi.fn(), markAllRead: vi.fn().mockResolvedValue(0),
  };
  const devices = { publicKey: vi.fn().mockReturnValue('public'), list: vi.fn().mockResolvedValue([]),
    register: vi.fn(), revoke: vi.fn() };
  const controller = new NotificationController(auth as unknown as AuthService,
    notifications as unknown as NotificationService, devices as unknown as NotificationDeviceService);
  const request = { id: 'request', headers: { cookie: 'session-cookie' } } as unknown as FastifyRequest;
  return { controller, auth, notifications, devices, request, session };
}

describe('notification HTTP boundary', () => {
  it('closes the list query and returns only authenticated paginated records', async () => {
    const { controller, notifications, request, session } = harness();
    for (const query of [{ other: 'x' }, { cursor: ['bad'] }, { limit: 4 }]) {
      await expect(controller.list(TENANT, query, request)).rejects.toMatchObject({ status: 400 });
    }
    const page = await controller.list(TENANT, { cursor: 'cursor', limit: '25' }, request);
    expect(notifications.list).toHaveBeenCalledWith(session, TENANT, 'cursor', '25');
    expect(page).toMatchObject({ data: [], page: { next_cursor: null, has_more: false } });
    expect(await controller.unreadCount(TENANT, request)).toMatchObject({ data: { count: 0 } });
  });

  it('checks membership for public push config and keeps device material out of responses', async () => {
    const { controller, notifications, devices, request, session } = harness();
    expect(await controller.pushConfig(TENANT, request)).toEqual({ data: { publicKey: 'public' }, request_id: 'request' });
    expect(notifications.unreadCount).toHaveBeenCalledWith(session, TENANT);
    expect(await controller.devicesList(TENANT, request)).toEqual({ data: [], request_id: 'request' });
    const subscription = { endpoint: 'opaque', keys: { p256dh: 'secret', auth: 'secret' } };
    expect(await controller.registerDevice(TENANT, DEVICE, { subscription }, 'csrf', request))
      .toEqual({ data: { registered: true }, request_id: 'request' });
    expect(devices.register).toHaveBeenCalledWith(session, TENANT, DEVICE, subscription);
    await controller.registerDevice(TENANT, DEVICE, null, 'csrf', request);
    expect(devices.register).toHaveBeenLastCalledWith(session, TENANT, DEVICE, undefined);
    expect(await controller.revokeDevice(TENANT, DEVICE, 'csrf', request))
      .toEqual({ data: { revoked: true }, request_id: 'request' });
    expect(devices.revoke).toHaveBeenCalledWith(session, TENANT, DEVICE);
  });

  it('requires CSRF for every mutation and delegates read state to the durable service', async () => {
    const { controller, auth, notifications, request, session } = harness();
    expect(await controller.markRead(TENANT, 'notice', 'csrf', request))
      .toEqual({ data: { read: true }, request_id: 'request' });
    expect(notifications.markRead).toHaveBeenCalledWith(session, TENANT, 'notice');
    expect(await controller.markAllRead(TENANT, 'csrf', request))
      .toEqual({ data: { changed: 0 }, request_id: 'request' });
    expect(auth.requireCsrf).toHaveBeenCalledWith(session, request.headers.cookie, 'csrf');
    expect(auth.requireCsrf).toHaveBeenCalledTimes(2);
  });
});
