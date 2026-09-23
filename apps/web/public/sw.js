/* global self, URL */
/* CONVO push worker. No session, credential, transcript, or privileged content
 * is cached here. The app rechecks access through its normal API on open. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLES = {
  new_message: ['رسالة عميل جديدة', 'New customer message'],
  assignment: ['محادثة أُسندت إليك', 'New conversation assigned to you'],
  handoff: ['طلب تسليم محادثة', 'Handoff request'],
  campaign: ['تحديث حملة', 'Campaign update'],
  automation_failure: ['فشل في التشغيل الآلي', 'Automation failure'],
};

function safeRoute(data) {
  if (!data || !UUID.test(data.targetId)) return '/#/inbox';
  const id = encodeURIComponent(data.targetId);
  if (data.targetType === 'conversation' || data.targetType === 'handoff') return `/#/inbox/${id}`;
  if (data.targetType === 'campaign') return `/#/broadcasts?campaign=${id}`;
  if (data.targetType === 'automation') return `/#/automations?edit=${id}`;
  return '/#/inbox';
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = TITLES[data.kind] || ['نشاط جديد في CONVO', 'New CONVO activity'];
  const arabic = (self.navigator.language || '').toLowerCase().startsWith('ar');
  const url = safeRoute(data);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((window) => window.visibilityState === 'visible')) return;
    await self.registration.showNotification(title[arabic ? 0 : 1], {
      body: arabic ? 'افتح CONVO لعرض التفاصيل بعد التحقق من صلاحيتك.' : 'Open CONVO to view details after authorization.',
      icon: '/brand/digital-school-by-berlitz.png',
      tag: UUID.test(data.id || '') ? data.id : 'convo-activity',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const route = typeof raw === 'string' && raw.startsWith('/#/') ? raw : '/#/inbox';
  const target = new URL(route, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((window) => new URL(window.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
