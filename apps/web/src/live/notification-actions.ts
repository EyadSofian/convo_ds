import type { Notification } from '../api/notifications.js';
import type { LiveContext } from './actions.js';
import { openConversation } from './inbox-actions.js';
import { currentTenantId, failed, LOADING, ready } from './store.js';
import { routeParamsWithLanguage } from '../state.js';

const DEVICE_KEY = 'convo.push.deviceId';
function syncAppBadge(count: number): void {
  if (typeof navigator === 'undefined') return;
  const app = navigator as Navigator & { setAppBadge?: (value: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0 && app.setAppBadge !== undefined) void app.setAppBadge(count).catch(() => undefined);
  else if (count === 0 && app.clearAppBadge !== undefined) void app.clearAppBadge().catch(() => undefined);
}
function deviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function applicationServerKey(raw: string): Uint8Array {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function enableBrowserPush(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const api = context.live.notificationsApi;
  if (tenantId === null || api === null) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    context.live.pushStatus = 'unavailable'; context.refresh(); return;
  }
  const publicKey = context.live.pushPublicKey;
  if (publicKey === null) {
    context.live.pushStatus = 'unavailable'; context.refresh(); return;
  }
  context.live.pushStatus = 'enabling'; context.refresh();
  try {
    // This function is reached only from the explicit Enable button. Never
    // request OS permission at boot, on drawer open, or from an SSE event.
    // There must be no network await before this call: the browser's transient
    // user activation from the click is needed by some Push implementations.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      context.live.pushStatus = 'denied'; context.refresh(); return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey),
    });
    const result = await api.registerDevice(tenantId, deviceId(), subscription.toJSON());
    context.live.pushStatus = result.ok ? 'enabled' : 'error';
  } catch {
    context.live.pushStatus = 'error';
  }
  context.refresh();
}

async function loadPushConfig(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const api = context.live.notificationsApi;
  if (tenantId === null || api === null || context.live.pushStatus === 'enabled' ||
      context.live.pushStatus === 'enabling' || context.live.pushStatus === 'checking') return;
  context.live.pushStatus = 'checking'; context.refresh();
  const result = await api.pushConfig(tenantId);
  if (currentTenantId(context.live) !== tenantId) return;
  context.live.pushPublicKey = result.ok ? result.data.publicKey : null;
  const status = result.ok ? (result.data.publicKey === null ? 'unavailable' : await existingPushState(api, tenantId)) : 'error';
  if (currentTenantId(context.live) !== tenantId) return;
  context.live.pushStatus = status;
  context.refresh();
}

/**
 * What this browser already agreed to, read without asking again.
 *
 * After a reload, or in a window a push tap opened, the drawer used to offer
 * "Enable device alerts" to a browser that was already receiving them, and the
 * same button to one whose permission was blocked. A live subscription is
 * re-registered — idempotent on the server, and it keeps the stored endpoint
 * current — and only a server acknowledgement is reported as enabled. Nothing
 * here prompts: permission is still requested only by the explicit click.
 */
async function existingPushState(api: NonNullable<LiveContext['live']['notificationsApi']>, tenantId: string): Promise<'idle' | 'enabled' | 'denied' | 'error'> {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'idle';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'idle';
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription === null || subscription === undefined) return 'idle';
    const registered = await api.registerDevice(tenantId, deviceId(), subscription.toJSON());
    return registered.ok ? 'enabled' : 'error';
  } catch {
    return 'idle';
  }
}

/** Explicit logout stops this browser receiving even generic lock-screen hints. */
export async function disableBrowserPush(context: LiveContext): Promise<void> {
  syncAppBadge(0);
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    const tenantId = currentTenantId(context.live);
    if (tenantId !== null && context.live.notificationsApi !== null) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try { await context.live.notificationsApi.revokeDevice(tenantId, deviceId(), controller.signal); }
      finally { clearTimeout(timeout); }
    }
  } catch {
    // Logging out must not be trapped behind a failed push service. The local
    // subscription was attempted first; the server prunes expired endpoints.
  }
}

/** Server records, never SSE payloads, are the notification source of truth. */
export async function loadNotifications(context: LiveContext, keep = false): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const api = context.live.notificationsApi;
  if (tenantId === null || api === null) return;
  const previous = keep && context.live.notifications.status === 'ready'
    ? context.live.notifications.value : null;
  const previousCursor = keep ? context.live.notificationNextCursor : null;
  if (!keep) context.live.notifications = LOADING;
  const [page, count] = await Promise.all([api.list(tenantId), api.unreadCount(tenantId)]);
  if (currentTenantId(context.live) !== tenantId) return;
  if (page.ok) {
    const latest = page.data.data;
    const latestIds = new Set(latest.map((entry) => entry.id));
    context.live.notifications = ready(previous === null ? latest :
      [...latest, ...previous.filter((entry) => !latestIds.has(entry.id))], context.now());
    context.live.notificationNextCursor = previous === null ? page.data.nextCursor : previousCursor;
  } else if (previous === null) {
    context.live.notifications = failed(page.error);
    context.live.notificationNextCursor = null;
  }
  context.live.notificationUnreadCount = count.ok ? ready(count.data.count, context.now()) : failed(count.error);
  if (count.ok) syncAppBadge(count.data.count);
  context.refresh();
}

export async function refreshNotificationCount(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const api = context.live.notificationsApi;
  if (tenantId === null || api === null) return;
  const result = await api.unreadCount(tenantId);
  if (currentTenantId(context.live) !== tenantId) return;
  context.live.notificationUnreadCount = result.ok ? ready(result.data.count, context.now()) : failed(result.error);
  if (result.ok) syncAppBadge(result.data.count);
  context.refresh();
}

async function loadMore(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const api = context.live.notificationsApi;
  const cursor = context.live.notificationNextCursor;
  if (tenantId === null || api === null || cursor === null || context.live.busy !== null) return;
  context.live.busy = 'notification-more';
  context.refresh();
  const result = await api.list(tenantId, cursor);
  context.live.busy = null;
  if (currentTenantId(context.live) !== tenantId) return;
  if (result.ok) {
    const current = context.live.notifications.status === 'ready' ? context.live.notifications.value : [];
    const seen = new Set(current.map((entry) => entry.id));
    context.live.notifications = ready([...current, ...result.data.data.filter((entry) => !seen.has(entry.id))], context.now());
    context.live.notificationNextCursor = result.data.nextCursor;
  } else context.live.error = result.error;
  context.refresh();
}

function targetOf(notification: Notification): { screen: 'inbox' | 'broadcasts' | 'automations'; conversationId: string | null; params: Record<string, string> } {
  if (notification.targetType === 'conversation' || notification.targetType === 'handoff') {
    return { screen: 'inbox', conversationId: notification.targetId, params: {} };
  }
  if (notification.targetType === 'campaign') return { screen: 'broadcasts', conversationId: null, params: { campaign: notification.targetId } };
  return { screen: 'automations', conversationId: null, params: { edit: notification.targetId } };
}

export function runNotificationAction(context: LiveContext, name: string, arg: string): Promise<void> | null {
  if (name === 'notification-enable-push') return enableBrowserPush(context);
  if (name === 'notification-toggle') {
    context.state.openMenu = context.state.openMenu === 'notifications' ? null : 'notifications';
    context.refresh();
    if (context.state.openMenu === 'notifications') {
      return Promise.all([loadNotifications(context), loadPushConfig(context)]).then(() => undefined);
    }
    return Promise.resolve();
  }
  if (name === 'notification-more') return loadMore(context);
  if (name === 'notification-read-all') {
    return (async () => {
      const tenantId = currentTenantId(context.live);
      if (tenantId === null || context.live.notificationsApi === null) return;
      const result = await context.live.notificationsApi.markAllRead(tenantId);
      if (result.ok) {
        if (context.live.notifications.status === 'ready') {
          const readAt = new Date().toISOString();
          context.live.notifications = ready(context.live.notifications.value.map((entry) =>
            entry.readAt === null ? { ...entry, readAt } : entry), context.now());
        }
        await loadNotifications(context, true);
      }
      else { context.live.error = result.error; context.refresh(); }
    })();
  }
  if (name === 'notification-open') {
    return (async () => {
      const notification = context.live.notifications.status === 'ready'
        ? context.live.notifications.value.find((entry) => entry.id === arg) : undefined;
      const tenantId = currentTenantId(context.live);
      if (notification === undefined || tenantId === null || context.live.notificationsApi === null) return;
      if (notification.readAt === null) {
        const result = await context.live.notificationsApi.markRead(tenantId, notification.id);
        if (!result.ok) { context.live.error = result.error; context.refresh(); return; }
      }
      context.state.openMenu = null;
      const target = targetOf(notification);
      const wasInbox = context.state.route.screen === 'inbox';
      context.state.route = { ...target, params: routeParamsWithLanguage(context.state, target.params) };
      context.refresh();
      if (wasInbox && target.screen === 'inbox' && target.conversationId !== null) {
        await openConversation(context, target.conversationId);
      }
      await refreshNotificationCount(context);
    })();
  }
  return null;
}
