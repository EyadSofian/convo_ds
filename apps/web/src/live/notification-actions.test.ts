/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification, NotificationsApi } from '../api/notifications.js';
import type { ConversationsApi } from '../api/conversations.js';
import type { LiveContext } from './actions.js';
import { createState } from '../state.js';
import { ready } from './store.js';
import { disableBrowserPush, loadNotifications, refreshNotificationCount, runNotificationAction } from './notification-actions.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TARGET = '55555555-5555-4555-8555-555555555555';
const ERROR = { code: 'network', message: 'unavailable', requestId: null, status: null, details: [] };
const record = (id: string, readAt: string | null = null): Notification => ({
  id, kind: 'new_message', targetType: 'conversation', targetId: TARGET,
  createdAt: '2026-09-09T09:29:00.000Z', readAt,
});
const page = (data: readonly Notification[], nextCursor: string | null = null) =>
  ({ ok: true as const, data: { data, nextCursor, hasMore: nextCursor !== null } });

function setup() {
  const state = createState(new Date('2026-09-09T09:30:00.000Z'));
  const api = {
    list: vi.fn().mockResolvedValue(page([])),
    unreadCount: vi.fn().mockResolvedValue({ ok: true, data: { count: 0 } }),
    markRead: vi.fn().mockResolvedValue({ ok: true, data: { read: true } }),
    markAllRead: vi.fn().mockResolvedValue({ ok: true, data: { changed: 0 } }),
    pushConfig: vi.fn().mockResolvedValue({ ok: true, data: { publicKey: null } }),
    registerDevice: vi.fn().mockResolvedValue({ ok: true, data: { registered: true } }),
    revokeDevice: vi.fn().mockResolvedValue({ ok: true, data: { revoked: true } }),
  };
  Object.assign(state.live, { notificationsApi: api as unknown as NotificationsApi });
  state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: TENANT };
  state.route = { screen: 'channels', conversationId: null, params: {} };
  const context: LiveContext = {
    state, live: state.live, refresh: vi.fn(), now: () => Date.parse('2026-09-09T09:30:00.000Z'),
    newKey: () => 'test', endSession: vi.fn(), switchWorkspace: vi.fn(),
  };
  return { context, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('durable notification browser actions', () => {
  it('loads server records and unread count, then updates the app badge', async () => {
    const { context, api } = setup();
    const setBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setBadge });
    api.list.mockResolvedValue(page([record('aaa')], 'next'));
    api.unreadCount.mockResolvedValue({ ok: true, data: { count: 1 } });
    await loadNotifications(context);
    expect(context.live.notifications).toMatchObject({ status: 'ready', value: [{ id: 'aaa' }] });
    expect(context.live.notificationNextCursor).toBe('next');
    expect(context.live.notificationUnreadCount).toMatchObject({ status: 'ready', value: 1 });
    expect(setBadge).toHaveBeenCalledWith(1);
    Reflect.deleteProperty(navigator, 'setAppBadge');
  });

  it('keeps already-paged history on realtime refresh and appends cursor pages without duplicates', async () => {
    const { context, api } = setup();
    context.live.notifications = ready([record('old'), record('older')], context.now());
    context.live.notificationNextCursor = 'after-older';
    api.list.mockResolvedValueOnce(page([record('new'), record('old', '2026-09-09T09:31:00.000Z')], 'after-old'));
    await loadNotifications(context, true);
    expect(context.live.notifications.status === 'ready' && context.live.notifications.value.map((entry) => entry.id))
      .toEqual(['new', 'old', 'older']);
    expect(context.live.notificationNextCursor).toBe('after-older');
    api.list.mockResolvedValueOnce(page([record('older'), record('oldest')], null));
    await runNotificationAction(context, 'notification-more', '');
    expect(api.list).toHaveBeenLastCalledWith(TENANT, 'after-older');
    expect(context.live.notifications.status === 'ready' && context.live.notifications.value.map((entry) => entry.id))
      .toEqual(['new', 'old', 'older', 'oldest']);
    expect(context.live.notificationNextCursor).toBeNull();
  });

  it('shows read failures and refuses to navigate on a failed mark-read', async () => {
    const { context, api } = setup();
    context.live.notifications = ready([record('notice')], context.now());
    api.markRead.mockResolvedValue({ ok: false, error: ERROR });
    await runNotificationAction(context, 'notification-open', 'notice');
    expect(context.state.route.screen).toBe('channels');
    expect(context.live.error).toEqual(ERROR);
    api.unreadCount.mockResolvedValue({ ok: false, error: ERROR });
    await refreshNotificationCount(context);
    expect(context.live.notificationUnreadCount.status).toBe('error');
  });

  it('navigates to the exact conversation only after server acknowledgement, preserving language', async () => {
    const { context, api } = setup();
    context.state.lang = 'en';
    context.live.notifications = ready([record('notice')], context.now());
    await runNotificationAction(context, 'notification-open', 'notice');
    expect(api.markRead).toHaveBeenCalledWith(TENANT, 'notice');
    expect(context.state.route).toMatchObject({ screen: 'inbox', conversationId: TARGET, params: { lang: 'en' } });
    expect(context.state.openMenu).toBeNull();
    expect(api.unreadCount).toHaveBeenCalledWith(TENANT);
  });

  it('marks every loaded page read and reloads server state, but preserves errors', async () => {
    const { context, api } = setup();
    context.live.notifications = ready([record('one'), record('two', '2026-09-09T09:00:00.000Z')], context.now());
    context.live.notificationNextCursor = 'after-two';
    api.list.mockResolvedValue(page([record('one', '2026-09-09T09:31:00.000Z')], 'after-one'));
    await runNotificationAction(context, 'notification-read-all', '');
    expect(api.markAllRead).toHaveBeenCalledWith(TENANT);
    expect(context.live.notifications.status === 'ready' && context.live.notifications.value.every((entry) => entry.readAt !== null)).toBe(true);
    expect(context.live.notificationNextCursor).toBe('after-two');
    api.markAllRead.mockResolvedValue({ ok: false, error: ERROR });
    await runNotificationAction(context, 'notification-read-all', '');
    expect(context.live.error).toEqual(ERROR);
  });

  it('loads the public push key on drawer open without requesting permission', async () => {
    const { context, api } = setup();
    const permission = vi.fn();
    vi.stubGlobal('Notification', { requestPermission: permission });
    api.pushConfig.mockResolvedValue({ ok: true, data: { publicKey: 'public-test-key' } });
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.state.openMenu).toBe('notifications');
    expect(context.live.pushPublicKey).toBe('public-test-key');
    expect(context.live.pushStatus).toBe('idle');
    expect(permission).not.toHaveBeenCalled();
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.state.openMenu).toBeNull();
  });

  it('reports a browser that already receives alerts as enabled after a reload, without prompting', async () => {
    const { context, api } = setup();
    const permission = vi.fn();
    const toJSON = vi.fn().mockReturnValue({ endpoint: 'https://push.example.test/e', keys: { p256dh: 'p', auth: 'a' } });
    const getSubscription = vi.fn().mockResolvedValue({ toJSON });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription } }),
    } });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: permission });
    api.pushConfig.mockResolvedValue({ ok: true, data: { publicKey: 'public-test-key' } });
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('enabled');
    expect(api.registerDevice).toHaveBeenCalledTimes(1);
    expect(permission).not.toHaveBeenCalled();

    // Only the server's acknowledgement counts as enabled.
    api.registerDevice.mockResolvedValue({ ok: false, error: ERROR });
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('error');

    // Granted, but this browser holds no subscription (or no worker yet).
    getSubscription.mockResolvedValue(null);
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('idle');
    (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('idle');
    (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no worker'));
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('idle');
  });

  it('says blocked instead of offering a prompt the browser will refuse, and stays quiet elsewhere', async () => {
    const { context, api } = setup();
    api.pushConfig.mockResolvedValue({ ok: true, data: { publicKey: 'public-test-key' } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn() } });
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('denied');

    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('idle');

    vi.stubGlobal('Notification', undefined);
    context.live.pushStatus = 'idle';
    context.state.openMenu = null;
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('idle');
    expect(api.registerDevice).not.toHaveBeenCalled();
  });

  it('drops a push-state answer that arrives after the workspace changed', async () => {
    const { context, api } = setup();
    api.pushConfig.mockResolvedValue({ ok: true, data: { publicKey: 'public-test-key' } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockImplementation(async () => {
        context.state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'other-tenant' };
        return undefined;
      }),
    } });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('checking');
  });

  it('requires explicit push permission and registers only after the click', async () => {
    const { context, api } = setup();
    const publicKey = Buffer.alloc(65, 5).toString('base64url');
    context.live.pushPublicKey = publicKey;
    const subscription = { toJSON: () => ({ endpoint: 'opaque', keys: { p256dh: 'x', auth: 'y' } }) };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const register = vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
    vi.stubGlobal('PushManager', class {});
    const permission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('Notification', { requestPermission: permission });
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(permission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(api.registerDevice).toHaveBeenCalledWith(TENANT, expect.any(String), subscription.toJSON());
    expect(context.live.pushStatus).toBe('enabled');
  });

  it('does not register a device when browser permission is denied', async () => {
    const { context, api } = setup();
    context.live.pushPublicKey = 'public';
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(context.live.pushStatus).toBe('denied');
    expect(api.registerDevice).not.toHaveBeenCalled();
  });

  it('unsubscribes and revokes the current device on logout', async () => {
    const { context, api } = setup();
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue({ unsubscribe }) } }),
    } });
    await disableBrowserPush(context);
    expect(unsubscribe).toHaveBeenCalled();
    expect(api.revokeDevice).toHaveBeenCalledWith(TENANT, expect.any(String), expect.any(AbortSignal));
  });

  it('shows server list failures without replacing a previously loaded page', async () => {
    const { context, api } = setup();
    api.list.mockResolvedValue({ ok: false, error: ERROR });
    await loadNotifications(context);
    expect(context.live.notifications.status).toBe('error');
    expect(context.live.notificationNextCursor).toBeNull();
    context.live.notifications = ready([record('old')], context.now());
    context.live.notificationNextCursor = 'after-old';
    await loadNotifications(context, true);
    expect(context.live.notifications).toMatchObject({ status: 'ready', value: [{ id: 'old' }] });
    expect(context.live.notificationNextCursor).toBe('after-old');
  });

  it('guards missing sessions, busy pages and failed next-page requests', async () => {
    const { context, api } = setup();
    context.live.notificationNextCursor = 'page-2';
    context.live.busy = 'another-action';
    await runNotificationAction(context, 'notification-more', '');
    expect(api.list).not.toHaveBeenCalled();
    context.live.busy = null;
    api.list.mockResolvedValue({ ok: false, error: ERROR });
    await runNotificationAction(context, 'notification-more', '');
    expect(context.live.error).toEqual(ERROR);
    expect(context.live.busy).toBeNull();
    context.live.session = { status: 'signed_out', error: null };
    await loadNotifications(context);
    await refreshNotificationCount(context);
    await runNotificationAction(context, 'notification-more', '');
    await runNotificationAction(context, 'notification-read-all', '');
    await runNotificationAction(context, 'notification-open', 'missing');
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('opens campaign and automation deep links without fabricating a conversation', async () => {
    const { context, api } = setup();
    context.live.notifications = ready([
      { ...record('campaign', '2026-09-09T09:30:00.000Z'), targetType: 'campaign', kind: 'campaign' },
      { ...record('automation', '2026-09-09T09:30:00.000Z'), targetType: 'automation', kind: 'automation_failure' },
      { ...record('handoff', '2026-09-09T09:30:00.000Z'), targetType: 'handoff', kind: 'handoff' },
    ], context.now());
    await runNotificationAction(context, 'notification-open', 'campaign');
    expect(context.state.route).toMatchObject({ screen: 'broadcasts', conversationId: null, params: { campaign: TARGET } });
    await runNotificationAction(context, 'notification-open', 'automation');
    expect(context.state.route).toMatchObject({ screen: 'automations', conversationId: null, params: { edit: TARGET } });
    await runNotificationAction(context, 'notification-open', 'handoff');
    expect(context.state.route).toMatchObject({ screen: 'inbox', conversationId: TARGET });
    expect(api.markRead).not.toHaveBeenCalled();
    expect(runNotificationAction(context, 'unrelated-action', '')).toBeNull();
  });

  it('reports unsupported, unconfigured and failed Web Push registration safely', async () => {
    const { context, api } = setup();
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(context.live.pushStatus).toBe('unavailable');
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: vi.fn() } });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(context.live.pushStatus).toBe('unavailable');
    context.live.pushPublicKey = Buffer.alloc(65, 6).toString('base64url');
    (navigator.serviceWorker.register as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private provider detail'));
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(context.live.pushStatus).toBe('error');
    expect(context.live.error).toBeNull();
    (navigator.serviceWorker.register as ReturnType<typeof vi.fn>).mockResolvedValue({ pushManager: {
      getSubscription: vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: 'opaque' }) }),
    } });
    api.registerDevice.mockResolvedValue({ ok: false, error: ERROR });
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(context.live.pushStatus).toBe('error');
  });

  it('keeps the source of truth on unread-count and push-config errors', async () => {
    const { context, api } = setup();
    const clearBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearBadge });
    await refreshNotificationCount(context);
    expect(clearBadge).toHaveBeenCalled();
    api.pushConfig.mockResolvedValue({ ok: false, error: ERROR });
    await runNotificationAction(context, 'notification-toggle', '');
    expect(context.live.pushStatus).toBe('error');
    expect(context.live.pushPublicKey).toBeNull();
    Reflect.deleteProperty(navigator, 'clearAppBadge');
  });

  it('reloads an Inbox conversation through its authorized API when already in Inbox', async () => {
    const { context } = setup();
    const read = vi.fn().mockResolvedValue({ ok: false, error: ERROR });
    Object.assign(context.live, { conversationsApi: { read } as unknown as ConversationsApi });
    context.state.route = { screen: 'inbox', conversationId: null, params: {} };
    context.live.notifications = ready([record('notice')], context.now());
    await runNotificationAction(context, 'notification-open', 'notice');
    expect(read).toHaveBeenCalledWith(TENANT, TARGET);
    expect(context.live.openConversation.status).toBe('error');
  });

  it('does not block logout when the browser Push API fails and uses a fresh device identity', async () => {
    const { context, api } = setup();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied'); });
    const getRegistration = vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration,
    } });
    await disableBrowserPush(context);
    expect(api.revokeDevice).toHaveBeenCalledWith(TENANT, expect.any(String), expect.any(AbortSignal));
    getRegistration.mockRejectedValue(new Error('unavailable'));
    await expect(disableBrowserPush(context)).resolves.toBeUndefined();
    getItem.mockRestore();
  });

  it('uses an existing device ID and never treats an invalid stored ID as trusted', async () => {
    const { context, api } = setup();
    const id = '44444444-4444-4444-8444-444444444444';
    context.live.pushPublicKey = Buffer.alloc(65, 7).toString('base64url');
    const subscription = { toJSON: () => ({ endpoint: 'opaque' }) };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: vi.fn().mockResolvedValue({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    }) } });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
    window.localStorage.setItem('convo.push.deviceId', id);
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(api.registerDevice).toHaveBeenLastCalledWith(TENANT, id, subscription.toJSON());
    window.localStorage.setItem('convo.push.deviceId', 'invalid');
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(api.registerDevice.mock.lastCall?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.registerDevice.mock.lastCall?.[1]).not.toBe('invalid');
  });

  it('drops stale asynchronous results when the operator changes workspace', async () => {
    const { context, api } = setup();
    let releaseList: ((value: ReturnType<typeof page>) => void) | null = null;
    api.list.mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve; }));
    const loading = loadNotifications(context);
    context.live.session = { ...context.live.session, tenantId: '22222222-2222-4222-8222-222222222222' } as typeof context.live.session;
    releaseList!(page([record('other')]));
    await loading;
    expect(context.live.notifications.status).toBe('loading');
    context.live.session = { ...context.live.session, tenantId: TENANT } as typeof context.live.session;
    let releaseCount: ((value: { ok: true; data: { count: number } }) => void) | null = null;
    api.unreadCount.mockImplementationOnce(() => new Promise((resolve) => { releaseCount = resolve; }));
    const counting = refreshNotificationCount(context);
    context.live.session = { ...context.live.session, tenantId: '22222222-2222-4222-8222-222222222222' } as typeof context.live.session;
    releaseCount!({ ok: true, data: { count: 99 } });
    await counting;
    expect(context.live.notificationUnreadCount.status).not.toBe('ready');
  });

  it('does not append a stale page and tolerates a page request before the first list is ready', async () => {
    const { context, api } = setup();
    context.live.notificationNextCursor = 'next';
    api.list.mockResolvedValueOnce(page([record('page-two')]));
    await runNotificationAction(context, 'notification-more', '');
    expect(context.live.notifications).toMatchObject({ status: 'ready', value: [{ id: 'page-two' }] });
    context.live.notificationNextCursor = 'next';
    let release: ((value: ReturnType<typeof page>) => void) | null = null;
    api.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const loading = runNotificationAction(context, 'notification-more', '');
    context.live.session = { ...context.live.session, tenantId: '22222222-2222-4222-8222-222222222222' } as typeof context.live.session;
    release!(page([record('wrong-tenant')]));
    await loading;
    expect(context.live.notifications.status === 'ready' && context.live.notifications.value.map((row) => row.id)).toEqual(['page-two']);
  });

  it('keeps server unread state even when browser Badging is unavailable', async () => {
    const { context, api } = setup();
    api.unreadCount.mockResolvedValue({ ok: true, data: { count: 4 } });
    vi.stubGlobal('navigator', undefined);
    await refreshNotificationCount(context);
    expect(context.live.notificationUnreadCount).toMatchObject({ status: 'ready', value: 4 });
  });

  it('guards push config for the active workspace and does not reuse a stale response', async () => {
    const { context, api } = setup();
    for (const status of ['enabled', 'enabling', 'checking'] as const) {
      context.live.pushStatus = status;
      await runNotificationAction(context, 'notification-toggle', '');
      await runNotificationAction(context, 'notification-toggle', '');
    }
    expect(api.pushConfig).not.toHaveBeenCalled();
    context.live.pushStatus = 'idle';
    let release: ((value: { ok: true; data: { publicKey: string } }) => void) | null = null;
    api.pushConfig.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const opening = runNotificationAction(context, 'notification-toggle', '');
    context.live.session = { ...context.live.session, tenantId: '22222222-2222-4222-8222-222222222222' } as typeof context.live.session;
    release!({ ok: true, data: { publicKey: 'wrong-workspace' } });
    await opening;
    expect(context.live.pushPublicKey).toBeNull();
    context.live.session = { status: 'signed_out', error: null };
    await runNotificationAction(context, 'notification-enable-push', '');
    expect(api.registerDevice).not.toHaveBeenCalled();
  });

  it('renders a list when unread count fails, without inventing a badge', async () => {
    const { context, api } = setup();
    api.list.mockResolvedValue(page([record('notice')]));
    api.unreadCount.mockResolvedValue({ ok: false, error: ERROR });
    await loadNotifications(context);
    expect(context.live.notifications).toMatchObject({ status: 'ready', value: [{ id: 'notice' }] });
    expect(context.live.notificationUnreadCount.status).toBe('error');
  });

  it('does nothing when the notification API was not composed', async () => {
    const { context } = setup();
    Object.assign(context.live, { notificationsApi: null });
    await loadNotifications(context);
    await refreshNotificationCount(context);
    await runNotificationAction(context, 'notification-enable-push', '');
    await runNotificationAction(context, 'notification-more', '');
    await runNotificationAction(context, 'notification-read-all', '');
    await runNotificationAction(context, 'notification-open', 'notice');
    expect(context.live.notifications.status).toBe('idle');
  });
});
