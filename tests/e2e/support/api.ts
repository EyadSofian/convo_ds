import type { Page, Route } from '@playwright/test';

/**
 * A scripted CONVO API for the browser tests.
 *
 * The Inbox reads everything from the server, so a layout or accessibility test
 * needs a server to read from. This is **not** a simulator of the product: it
 * answers the handful of endpoints the Inbox calls with fixed, obviously-fake
 * fixtures, so the density numbers are measured against a real engine laying
 * out a real screen rather than against an empty state.
 *
 * The shapes here are the pinned OpenAPI's shapes. If one drifts, the contract
 * test in `tests/integration/api-contract.test.ts` fails first — this file is a
 * consumer of the contract, not a second definition of it.
 */

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';
export const CONVERSATION = '55555555-5555-4555-8555-555555555555';
export const CONTACT = '66666666-6666-4666-8666-666666666666';

const NAMES = [
  'سارة عبد الله',
  'محمد الشريف',
  'ليلى منصور',
  'أحمد فؤاد',
  'نور الهدى',
  'يوسف كمال',
  'هبة سالم',
  'كريم عادل',
  'دينا رمزي',
  'طارق حسين',
  'منى خليل',
  'باسم وجدي',
];

function queueCards(): readonly Record<string, unknown>[] {
  return NAMES.map((_name, index) => ({
    id: index === 0 ? CONVERSATION : `cv-${String(index).padStart(2, '0')}`,
    inboxLabel: index % 2 === 0 ? 'خط التسجيل' : 'خط المحاسبة',
    channel: ['whatsapp', 'messenger', 'instagram', 'web_chat'][index % 4],
    maskedLabel: `••••${String(100 + index)}`,
    priority: ['normal', 'high', 'urgent', 'low'][index % 4],
    status: 'open',
    waitingSinceAt: new Date(Date.UTC(2026, 8, 9, 9, 30 - index)).toISOString(),
    claimable: true,
    version: 3,
  }));
}

function mine(): readonly Record<string, unknown>[] {
  return NAMES.slice(0, 9).map((_name, index) => ({
    id: index === 0 ? CONVERSATION : `own-${String(index).padStart(2, '0')}`,
    connectionId: 'cn-1',
    peerIdentity: `1555000${String(index).padStart(4, '0')}`,
    teamId: null,
    assigneeMembershipId: MEMBERSHIP,
    status: 'open',
    priority: ['normal', 'high', 'urgent', 'low'][index % 4],
    version: 4,
    waitingSince: null,
    inboxLabel: 'خط التسجيل',
    channel: ['whatsapp', 'messenger', 'instagram', 'web_chat'][index % 4],
    participantMembershipIds: [MEMBERSHIP],
    contactId: index === 0 ? CONTACT : null,
  }));
}

const BODIES = [
  'مساء الخير، سجّلت ابني في برنامج الصيف ولم تصلني رسالة التأكيد.',
  'رقم الطلب 4817 إن كان يفيدكم.',
  'أهلًا بك، سأتحقق من الطلب الآن.',
  'ظهر الطلب لدينا وقد اكتمل الدفع.',
  'أُرسل التأكيد مرة أخرى إلى نفس الرقم.',
  'وصلني الآن، شكرًا لسرعتكم.',
  'هل يمكن تغيير موعد اللقاء التعريفي؟',
  'بالتأكيد، المواعيد المتاحة يوم الأحد والثلاثاء.',
  'الأحد مناسب.',
  'تم الحجز، وسيصلك تذكير قبلها بيوم.',
];

function timeline(): readonly Record<string, unknown>[] {
  return BODIES.map((body, index) => ({
    id: `m-${String(index).padStart(2, '0')}`,
    direction: index % 2 === 0 ? 'in' : 'out',
    at: new Date(Date.UTC(2026, 8, 9, 8, 30 + index * 5)).toISOString(),
    content_type: 'text',
    text: body,
    attachments: [],
    author_membership_id: index % 2 === 0 ? null : MEMBERSHIP,
    command_state: index % 2 === 0 ? null : 'provider_accepted',
    delivery_state: index % 2 === 0 ? null : index > 4 ? 'read' : 'delivered',
    delivery_anomaly: null,
    provider_message_id: `wamid.${String(index)}`,
  }));
}

/**
 * Two internal notes and one that was deleted.
 *
 * The deleted row is here on purpose: it is the state the panel has to render
 * as *a note was removed* rather than as a gap, and a baseline that never saw
 * one could not catch it disappearing.
 */
function notes(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'note-01',
      conversationId: CONVERSATION,
      authorMembershipId: MEMBERSHIP,
      body: 'اتصلت بالعميلة أمس وأكدت الرقم. لا داعي لإعادة السؤال.',
      createdAt: new Date(Date.UTC(2026, 8, 9, 9, 5)).toISOString(),
      editedAt: null,
      deletedAt: null,
    },
    {
      id: 'note-02',
      conversationId: CONVERSATION,
      authorMembershipId: MEMBERSHIP,
      body: 'الطلب 4817 مدفوع بالكامل — راجعت مع المحاسبة.',
      createdAt: new Date(Date.UTC(2026, 8, 9, 9, 18)).toISOString(),
      editedAt: new Date(Date.UTC(2026, 8, 9, 9, 20)).toISOString(),
      deletedAt: null,
    },
    {
      id: 'note-03',
      conversationId: CONVERSATION,
      authorMembershipId: MEMBERSHIP,
      body: '[deleted]',
      createdAt: new Date(Date.UTC(2026, 8, 9, 9, 22)).toISOString(),
      editedAt: null,
      deletedAt: new Date(Date.UTC(2026, 8, 9, 9, 25)).toISOString(),
    },
  ];
}

/** Two episodes: one closed with a disposition, one still being worked. */
function episodes(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'ep-01',
      seq: 1,
      openedAt: new Date(Date.UTC(2026, 8, 8, 11, 0)).toISOString(),
      openedBy: 'customer_inbound',
      firstInboundAt: new Date(Date.UTC(2026, 8, 8, 11, 0)).toISOString(),
      firstResponseAt: new Date(Date.UTC(2026, 8, 8, 11, 4)).toISOString(),
      closedAt: new Date(Date.UTC(2026, 8, 8, 11, 40)).toISOString(),
      resolution: 'أُرسل التأكيد',
    },
    {
      id: 'ep-02',
      seq: 2,
      openedAt: new Date(Date.UTC(2026, 8, 9, 8, 30)).toISOString(),
      openedBy: 'customer_inbound',
      firstInboundAt: new Date(Date.UTC(2026, 8, 9, 8, 30)).toISOString(),
      firstResponseAt: null,
      closedAt: null,
      resolution: null,
    },
  ];
}

function contacts(): readonly Record<string, unknown>[] {
  return NAMES.slice(0, 6).map((name, index) => ({
    id: index === 0 ? CONTACT : `ct-${String(index).padStart(2, '0')}`,
    displayName: name,
    attributes: index === 0 ? { grade: 'الصف السادس', branch: 'المعادي' } : {},
    createdAt: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
    identities: [
      {
        id: `ci-${String(index)}`,
        kind: ['whatsapp', 'messenger', 'instagram', 'web_chat'][index % 4],
        scopeId: 'cn-1',
        externalId: `1555000${String(index).padStart(4, '0')}`,
        validFrom: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
        validTo: null,
      },
    ],
    consent: [
      {
        channel: 'whatsapp',
        purpose: 'service',
        state: 'granted',
        source: 'customer_message',
        recordedAt: new Date(Date.UTC(2026, 8, 2 + index)).toISOString(),
        actorMembershipId: null,
      },
    ],
    // The first contact has opted out, so the panel's most important rule —
    // a suppression outranks a consent — is on screen in every baseline.
    suppressed: index === 0 ? ['whatsapp'] : [],
  }));
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function paged(rows: readonly unknown[]): unknown {
  return { data: rows, page: { next_cursor: null, has_more: false }, request_id: 'e2e' };
}

/**
 * Installs the scripted API on a page, before it navigates.
 *
 * The stream is held open and silent: a connection that ends is a connection
 * the screen reports as dropped, and a browser reconnecting behind a screenshot
 * is noise rather than coverage. The stream's own behaviour is proved in
 * `apps/web/src/live/realtime.test.ts` and against the real server in
 * `tests/integration/api-realtime.test.ts`.
 */
export async function installApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');

    if (path === '/auth/session') {
      return json(route, { data: { user: { id: 'u1', email: 'hana@digital-school.example' } } });
    }
    if (path === '/me/memberships') {
      return json(route, {
        data: [
          {
            id: MEMBERSHIP,
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'agent-role', key: 'agent', name: 'Agent' },
          },
        ],
      });
    }
    if (path.endsWith('/contacts')) {
      return json(route, paged(contacts()));
    }
    if (path.includes('/contacts/')) {
      const [first] = contacts();
      return json(route, { data: first });
    }
    if (path.endsWith('/conversations/unassigned')) {
      return json(route, { data: queueCards() });
    }
    if (path.endsWith('/conversations')) {
      return json(route, paged(mine()));
    }
    if (path.endsWith('/messages')) {
      return json(route, paged(timeline()));
    }
    if (path.endsWith('/notes')) {
      return json(route, paged(notes()));
    }
    if (path.endsWith('/episodes')) {
      return json(route, paged(episodes()));
    }
    if (path.endsWith('/read')) {
      return json(route, { data: { readThrough: new Date(Date.UTC(2026, 8, 9, 9, 30)).toISOString() } });
    }
    if (path.endsWith('/transitions')) {
      return json(route, { data: { ...mine()[0], status: 'pending', version: 5 } });
    }
    if (path.endsWith('/realtime/stream')) {
      // Left hanging on purpose. A fulfilled response *ends* the stream, which
      // `EventSource` reports as an error and the screen — correctly — reports
      // as "you are looking at a snapshot". These tests are about layout and
      // accessibility, so the connection is held open and says nothing; the
      // stream's own behaviour is proved in the unit and integration suites.
      return new Promise<void>(() => undefined);
    }
    if (path.includes('/conversations/')) {
      const detail = mine()[0];
      return json(route, { data: detail });
    }
    // Anything the Inbox does not call. Answering it with a 404 keeps an
    // accidental new request visible rather than silently satisfied.
    return json(route, { error: { code: 'not_scripted', message: path } }, 404);
  });
}
