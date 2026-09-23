import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from './client.js';
import { NotificationsApi } from './notifications.js';

describe('NotificationsApi', () => {
  it('uses paginated member-scoped routes and keeps subscription secrets in the request body', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(new Response(JSON.stringify({ data: [], nextCursor: null, hasMore: false }), { status: 200 }));
    };
    const api = new NotificationsApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => 'csrf' }));
    await api.list('tenant');
    await api.list('tenant', 'page/2');
    await api.unreadCount('tenant');
    await api.markRead('tenant', 'notice');
    await api.markAllRead('tenant');
    await api.pushConfig('tenant');
    const subscription = { endpoint: 'https://fcm.googleapis.com/example', keys: { p256dh: 'key', auth: 'auth' } };
    await api.registerDevice('tenant', 'device', subscription);
    const signal = new AbortController().signal;
    await api.revokeDevice('tenant', 'device', signal);
    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
      ['GET', '/api/v1/tenants/tenant/notifications?limit=25'],
      ['GET', '/api/v1/tenants/tenant/notifications?limit=25&cursor=page%2F2'],
      ['GET', '/api/v1/tenants/tenant/notifications/unread-count'],
      ['POST', '/api/v1/tenants/tenant/notifications/notice/read'],
      ['POST', '/api/v1/tenants/tenant/notifications/read-all'],
      ['GET', '/api/v1/tenants/tenant/notifications/push-config'],
      ['POST', '/api/v1/tenants/tenant/notifications/devices/device'],
      ['POST', '/api/v1/tenants/tenant/notifications/devices/device/revoke'],
    ]);
    expect(JSON.parse(String(calls[6]?.init.body))).toEqual({ subscription });
    expect(calls[7]?.init.signal).toBe(signal);
    expect(calls[6]?.path).not.toContain('auth');
  });
});
