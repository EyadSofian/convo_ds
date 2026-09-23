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
export const CONNECTION = '77777777-7777-4777-8777-777777777777';
export const TEST_RECIPIENT = '88888888-8888-4888-8888-888888888888';

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
    connectionId: index === 0 ? CONNECTION : 'cn-1',
    peerIdentity: `1555000${String(index).padStart(4, '0')}`,
    teamId: null,
    assigneeMembershipId: MEMBERSHIP,
    status: 'open',
    priority: ['normal', 'high', 'urgent', 'low'][index % 4],
    version: 4,
    waitingSince: null,
    inboxLabel: 'خط التسجيل',
    channel: ['whatsapp', 'messenger', 'instagram', 'web_chat'][index % 4],
    serviceWindow: index % 4 === 0
      ? { status: 'open', lastCustomerInboundAt: new Date(Date.UTC(2026, 8, 9, 9, 0)).toISOString(), serviceWindowExpiresAt: new Date(Date.UTC(2026, 8, 10, 9, 0)).toISOString() }
      : { status: 'not_applicable', lastCustomerInboundAt: null, serviceWindowExpiresAt: null },
    participantMembershipIds: [MEMBERSHIP],
    contactId: index === 0 ? CONTACT : null,
    pendingReason: null,
    snoozedUntil: null,
    snoozeTimezone: null,
    resolution: null,
    resolvedAt: null,
    lastActivityAt: new Date(Date.UTC(2026, 8, 9, 9, 15 - index)).toISOString(),
    ownerState: 'human_active',
    ownerVersion: 1,
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

function campaigns(): readonly Record<string, unknown>[] {
  const common = {
    connection_id: CONNECTION, version: 3, revision: 1,
    created_at: new Date(Date.UTC(2026, 8, 7, 9, 0)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 8, 9, 9, 0)).toISOString(),
  };
  return [
    {
      ...common, id: 'campaign-intake', name: 'دفعة الخريف', objective: 'تأكيد التسجيل قبل بداية الدراسة',
      state: 'ready', revision_id: 'revision-intake', revision_hash: 'a'.repeat(64), approved: true,
      content: { text: 'Welcome' }, variables: {}, audience_filter: {}, timezone: 'UTC', expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
      audience: { total: 1280, eligible: 1146, excluded: 134 }, execution: null,
    },
    {
      ...common, id: 'campaign-reminder', name: 'تذكير المحاضرة المباشرة', objective: 'رفع نسبة الحضور',
      state: 'running', revision_id: 'revision-reminder', revision_hash: 'b'.repeat(64), approved: true,
      content: { text: 'Reminder' }, variables: {}, audience_filter: {}, timezone: 'UTC', expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
      audience: { total: 640, eligible: 618, excluded: 22 },
      execution: { id: 'execution-reminder', state: 'running', scheduled_for: null },
    },
    {
      ...common, id: 'campaign-followup', name: 'متابعة المهتمين', objective: null,
      state: 'draft', revision_id: 'revision-followup', revision_hash: 'c'.repeat(64), approved: false,
      content: { text: 'Follow up' }, variables: {}, audience_filter: {}, timezone: 'UTC', expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
      audience: null, execution: null,
    },
  ];
}

function campaignReport(): Record<string, unknown> {
  const fresh = new Date(Date.UTC(2026, 8, 9, 9, 15)).toISOString();
  return {
    generated_at: fresh, fresh_through: fresh, timezone: 'UTC',
    filters: { from: null, to: null, channel: null, campaign_id: null },
    definitions: { campaigns: 3, executions: 1 },
    audience: { denominator: 1920, eligible: 1764, excluded: 156 },
    current: { denominator: 618, planned: 38, queued: 42, in_flight: 8, accepted: 101, delivered: 214, read: 187, failed: 19, skipped: 7, cancelled: 0, outcome_unknown: 2 },
    milestones: { denominator: 618, accepted: 502, delivered: 401, read: 187 },
    trend: [
      { day: '2026-09-05', recipients: 96, accepted: 81, delivered: 66, read: 34, failed: 3 },
      { day: '2026-09-06', recipients: 140, accepted: 117, delivered: 95, read: 44, failed: 5 },
      { day: '2026-09-07', recipients: 118, accepted: 96, delivered: 77, read: 36, failed: 4 },
      { day: '2026-09-08', recipients: 152, accepted: 125, delivered: 101, read: 47, failed: 4 },
      { day: '2026-09-09', recipients: 112, accepted: 83, delivered: 62, read: 26, failed: 3 },
    ],
    costs: [{ currency: 'USD', estimated_amount_minor: '30.900000', committed_amount_minor: '25.200000', reconciled_amount_minor: '24.650000' }],
    channels: [
      { kind: 'whatsapp', denominator: 500, accepted: 422, delivered: 358, read: 170, delivery_receipts: true, read_receipts: true },
      { kind: 'instagram', denominator: 118, accepted: 82, delivered: 43, read: 17, delivery_receipts: false, read_receipts: false },
    ],
    errors: [{ code: 'provider_rejected', count: 12 }, { code: 'marketing_consent_missing', count: 7 }, { code: 'attempt_never_completed', count: 2 }],
    campaigns: [
      { id: 'campaign-reminder', name: 'تذكير المحاضرة المباشرة', state: 'running', denominator: 618, pending: 88, accepted: 502, delivered: 401, read: 187, failed: 19, outcome_unknown: 2, included: 618, excluded: 22, fresh_through: fresh },
      { id: 'campaign-intake', name: 'دفعة الخريف', state: 'ready', denominator: 0, pending: 0, accepted: 0, delivered: 0, read: 0, failed: 0, outcome_unknown: 0, included: null, excluded: null, fresh_through: fresh },
    ],
  };
}

function channelCapabilities(kind = 'whatsapp'): Record<string, unknown> {
  return {
    kind, version: 'v21.0', host: 'graph.facebook.com',
    inboundEvents: ['message', 'delivery', 'read'], outboundTypes: ['text', 'template'],
    attachmentTypes: ['image', 'document'], textLimit: { characters: 4096, bytes: 16384 },
    windowHours: 24, businessInitiated: true, templates: true,
    deliveryReceipts: true, readReceipts: true,
  };
}

function channelConnections(): readonly Record<string, unknown>[] {
  const observedAt = new Date(Date.UTC(2026, 8, 9, 8, 0)).toISOString();
  const evidence = (satisfied: number): readonly Record<string, unknown>[] =>
    ['asset_verified', 'credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'].map((kind, index) => ({
      kind, satisfied: index < satisfied, observed_at: index < satisfied ? observedAt : null,
    }));
  return [
    {
      id: CONNECTION, kind: 'whatsapp', provider: 'meta', display_name: 'Digital School Admissions',
      external_asset_id: '109876543210', provider_app_id: '123456789012345', status: 'healthy',
      capabilities: channelCapabilities(), evidence: evidence(5),
      missing_evidence: [], last_error_code: null, last_error_at: null,
      created_at: observedAt, disconnected_at: null, credential_held: true,
      credential_fingerprint: 'a'.repeat(64),
    },
    {
      id: 'cn-instagram-01', kind: 'instagram', provider: 'meta', display_name: 'Digital School Instagram',
      external_asset_id: '17841400000000001', provider_app_id: '123456789012345', status: 'authorization_needed',
      capabilities: channelCapabilities('instagram'), evidence: evidence(1),
      missing_evidence: ['credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'],
      last_error_code: 'provider_not_connected', last_error_at: observedAt,
      created_at: observedAt, disconnected_at: null, credential_held: true,
      credential_fingerprint: 'b'.repeat(64),
    },
  ];
}

function channelCatalogue(): readonly Record<string, unknown>[] {
  return [
    { kind: 'whatsapp', provider: 'meta', implemented: true, capabilities: channelCapabilities() },
    { kind: 'messenger', provider: 'meta', implemented: true, capabilities: channelCapabilities('messenger') },
    { kind: 'instagram', provider: 'meta', implemented: true, capabilities: channelCapabilities('instagram') },
    { kind: 'web_chat', provider: 'web_chat', implemented: true, capabilities: { ...channelCapabilities('web_chat'), templates: false, windowHours: null } },
    { kind: 'custom', provider: 'custom', implemented: true, capabilities: { ...channelCapabilities('custom'), templates: false, windowHours: null } },
  ];
}

function testRecipients(): readonly Record<string, unknown>[] {
  return [{
    id: TEST_RECIPIENT, connection_id: CONNECTION, identity_id: '99999999-9999-4999-8999-999999999999',
    peer_identity: '201000000000', display_name: 'QA Owner', label: 'Owner phone',
    authorized_at: new Date(Date.UTC(2026, 8, 9, 8, 15)).toISOString(),
  }];
}

function people(): readonly Record<string, unknown>[] {
  return [{
    membership_id: MEMBERSHIP, email: 'hana@digital-school.example', status: 'active',
    role: { id: 'agent-role', key: 'agent', name: 'Agent' }, scopes: [],
  }];
}

function roles(): readonly Record<string, unknown>[] {
  return [{
    id: 'agent-role', key: 'agent', name: 'Agent', is_builtin: true,
    grants: [
      { permission_key: 'conversation.read', scope_level: 'own' },
      { permission_key: 'conversation.reply', scope_level: 'own' },
    ],
  }];
}

function teams(): readonly Record<string, unknown>[] {
  return [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Admissions', member_count: 1,
    archived: false, members: [{ membership_id: MEMBERSHIP, email: 'hana@digital-school.example' }],
  }];
}

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
    version: 1,
    labels: index % 3 === 0 ? [{ id: `lb-${String(index)}`, name: index === 0 ? 'ولي أمر' : 'مهتم', color: '#6558d9', state: 'active', version: 1 }] : [],
    customFields: [],
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

/** The keys the built-in Admin role holds, as `/me/memberships` returns them. */
export const ADMIN_PERMISSIONS: readonly string[] = [
  'conversation.read', 'conversation.unassigned.preview', 'conversation.reply', 'conversation.note',
  'conversation.claim', 'conversation.assign', 'conversation.handoff.request', 'conversation.close',
  'contact.read', 'contact.edit', 'consent.read', 'consent.record',
  'campaign.read', 'campaign.draft', 'campaign.approve', 'campaign.launch', 'campaign.control',
  'channel.manage', 'member.manage', 'role.manage', 'report.read',
  'automation.read', 'automation.create', 'automation.edit', 'automation.activate',
];

function automationWorkflow(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { type: 'schedule', config: {} },
    target: { type: 'dynamic_audience', config: {} },
    steps: [
      { id: 'step-1', type: 'send_whatsapp_template', config: {} },
      { id: 'step-2', type: 'delay', config: { minutes: 30 } },
    ],
    schedule: { kind: 'daily', time: '09:00' },
    safety: { approvalRequired: true, duplicateWindowSeconds: 3600 },
  };
}

function automationTemplates(): readonly Record<string, unknown>[] {
  return [
    { key: 'class-reminder', category: 'academic', name: 'تذكير الحصة', description: 'ذكّر الطلاب قبل بدء الحصة.', preset: automationWorkflow() },
    { key: 'lead-follow-up', category: 'sales', name: 'متابعة المهتمين', description: 'تابع مع العميل بعد تسجيل اهتمامه.', preset: { ...automationWorkflow(), trigger: { type: 'contact_created', config: {} } } },
    { key: 'welcome', category: 'marketing', name: 'رسالة ترحيب', description: 'أرسل رسالة ترحيب منضبطة للمشترك الجديد.', preset: { ...automationWorkflow(), trigger: { type: 'contact_created', config: {} } } },
    { key: 'operations-check', category: 'operations', name: 'فحص تشغيلي', description: 'أنشئ متابعة داخلية للحالات المتأخرة.', preset: automationWorkflow() },
  ];
}

function automations(): readonly Record<string, unknown>[] {
  return [{
    id: 'automation-1', name: 'تذكير الحصة الصباحية', description: 'تذكير يومي قبل الحصة', templateKey: 'class-reminder',
    state: 'draft', workflow: automationWorkflow(), timezone: 'Africa/Cairo', nextRunAt: null, lastRunAt: null, version: 1,
  }];
}

function sessions(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001', current: true,
      created_at: new Date(Date.UTC(2026, 8, 9, 8, 0)).toISOString(),
      last_seen_at: new Date(Date.UTC(2026, 8, 9, 9, 29)).toISOString(),
      expires_at: new Date(Date.UTC(2026, 8, 23, 8, 0)).toISOString(),
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002', current: false,
      created_at: new Date(Date.UTC(2026, 8, 4, 14, 0)).toISOString(),
      last_seen_at: new Date(Date.UTC(2026, 8, 8, 17, 12)).toISOString(),
      expires_at: new Date(Date.UTC(2026, 8, 18, 14, 0)).toISOString(),
    },
  ];
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
export interface ApiOptions {
  /** Whether the browser starts with a session. Sign-in and sign-out change it. */
  readonly signedIn?: boolean;
  readonly notifications?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly createdAt: string;
    readonly readAt: string | null;
  }[];
}

/** The one password the scripted sign-in accepts. */
export const PASSWORD = 'correct horse battery staple';
export const EMAIL = 'hana@digital-school.example';

const USER = { data: { user: { id: 'u1', email: EMAIL } } };
const FROZEN_NOTIFICATION_READ_AT = '2026-09-09T09:30:00.000Z';
const UNAUTHENTICATED = { error: { code: 'unauthenticated', message: 'Sign in to continue.', request_id: 'e2e' } };

export async function installApi(page: Page, options: ApiOptions = {}): Promise<void> {
  let signedIn = options.signedIn ?? true;
  let automationRows = [...automations()];
  let notificationRows = [...(options.notifications ?? [])];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const method = route.request().method();

    if (path === '/auth/login') {
      const body = route.request().postDataJSON() as { email?: string; password?: string };
      if (body.email === EMAIL && body.password === PASSWORD) {
        signedIn = true;
        return json(route, USER);
      }
      // The same answer for a wrong address and a wrong password, as the API gives.
      return json(route, { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.', request_id: 'e2e' } }, 401);
    }
    if (path === '/auth/logout') {
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/auth/password/change' && method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return body['currentPassword'] === PASSWORD && body['newPassword'] === body['confirmPassword']
        ? route.fulfill({ status: 204 })
        : json(route, { error: { code: 'current_password_invalid', message: 'The current password is not valid.', request_id: 'e2e' } }, 400);
    }
    // Everything else needs the session, exactly as the API does.
    if (!signedIn) {
      return json(route, UNAUTHENTICATED, 401);
    }
    if (path === '/auth/session') {
      return json(route, USER);
    }
    if (path === '/auth/sessions') {
      return json(route, paged(sessions()));
    }
    if (path === '/me/memberships') {
      return json(route, {
        data: [
          {
            id: MEMBERSHIP,
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'admin-role', key: 'admin', name: 'Admin' },
            permissions: ADMIN_PERMISSIONS,
          },
        ],
      });
    }
    if (path.endsWith('/notifications/unread-count')) {
      return json(route, { data: { count: notificationRows.filter((entry) => entry.readAt === null).length }, request_id: 'e2e' });
    }
    if (path.endsWith('/notifications/push-config')) {
      return json(route, { data: { publicKey: null }, request_id: 'e2e' });
    }
    if (path.endsWith('/notifications/read-all') && method === 'POST') {
      const changed = notificationRows.filter((entry) => entry.readAt === null).length;
      notificationRows = notificationRows.map((entry) => entry.readAt === null
        ? { ...entry, readAt: FROZEN_NOTIFICATION_READ_AT } : entry);
      return json(route, { data: { changed }, request_id: 'e2e' });
    }
    if (path.includes('/notifications/') && path.endsWith('/read') && method === 'POST') {
      const id = path.split('/').at(-2);
      if (!notificationRows.some((entry) => entry.id === id)) return json(route, { error: { code: 'resource_not_found' } }, 404);
      notificationRows = notificationRows.map((entry) => entry.id === id
        ? { ...entry, readAt: entry.readAt ?? FROZEN_NOTIFICATION_READ_AT } : entry);
      return json(route, { data: { read: true }, request_id: 'e2e' });
    }
    if (path.endsWith('/notifications')) {
      return json(route, paged(notificationRows));
    }
    if (path.endsWith('/labels')) {
      return json(route, paged([
        { id: 'lb-0', name: 'ولي أمر', color: '#6558d9', state: 'active', version: 1 },
        { id: 'lb-3', name: 'مهتم', color: '#2f7d5b', state: 'active', version: 1 },
      ]));
    }
    if (path.endsWith('/custom-fields')) {
      return json(route, paged([]));
    }
    // The Inbox always asks for server-backed saved views alongside its first
    // page. Keep this explicit so a new request remains visible as a 404,
    // while the normal empty-state response does not become a browser error.
    if (path.endsWith('/saved-views')) {
      return json(route, paged([]));
    }
    if (path.endsWith('/channels/catalogue')) {
      return json(route, paged(channelCatalogue()));
    }
    if (path.endsWith('/test-recipients')) {
      return json(route, paged(path.includes(CONNECTION) ? testRecipients() : []));
    }
    if (path.endsWith('/channels')) {
      return json(route, paged(channelConnections()));
    }
    if (path.endsWith('/people')) {
      return json(route, paged(people()));
    }
    if (path.endsWith('/roles')) {
      return json(route, paged(roles()));
    }
    if (path.endsWith('/teams')) {
      return json(route, paged(teams()));
    }
    if (path.endsWith('/invitations') || path.endsWith('/ownership-transfers')) {
      return json(route, paged([]));
    }
    if (path.endsWith('/permissions')) {
      return json(route, paged([
        { key: 'conversation.read', description: 'Read assigned conversations', delegable: true },
        { key: 'conversation.reply', description: 'Reply to assigned conversations', delegable: true },
      ]));
    }
    if (path.endsWith('/reports/campaigns')) {
      return json(route, { data: campaignReport(), request_id: 'e2e' });
    }
    if (path.endsWith('/reports/operations')) {
      return json(route, { data: { agentOptions: [], agents: [] }, request_id: 'e2e' });
    }
    if (path.endsWith('/reports/assignments')) {
      const secondPage = new URL(route.request().url()).searchParams.has('cursor');
      const item = secondPage
        ? { id: 'audit-2', timestamp: '2026-09-08T09:00:00.000Z', conversationId: CONVERSATION, customer: 'Mona Khalil', action: 'assign', previousAssignee: null, assignedTo: { membershipId: MEMBERSHIP, displayName: 'Ahmed Fouad' }, actor: null }
        : { id: 'audit-1', timestamp: '2026-09-09T09:00:00.000Z', conversationId: CONVERSATION, customer: 'Mona Khalil', action: 'claim', previousAssignee: null, assignedTo: { membershipId: MEMBERSHIP, displayName: 'Ahmed Fouad' }, actor: { membershipId: MEMBERSHIP, displayName: 'Ahmed Fouad' } };
      return json(route, { data: [item], page: { next_cursor: secondPage ? null : 'e2e-cursor-page-2', has_more: !secondPage }, request_id: 'e2e' });
    }
    if (path.endsWith('/automation-templates')) {
      return json(route, paged(automationTemplates()));
    }
    if (path.includes('/conversations/') && path.endsWith('/whatsapp-templates')) {
      return json(route, {
        data: [{
          id: 'whatsapp-template-1', providerTemplateId: 'meta-template-1', name: 'welcome_message', language: 'en', category: 'utility', status: 'approved',
          components: [{ type: 'body', text: 'Hello {{1}}', format: null, buttons: [] }],
          parameters: [{ key: 'body:1', component: 'body', index: null, position: 1, example: null }],
          sendSupported: true, unsupportedReason: null, lastSyncedAt: '2026-09-09T09:00:00.000Z',
        }],
        page: { next_cursor: null, has_more: false }, request_id: 'e2e',
      });
    }
    if (path.endsWith('/whatsapp-templates')) {
      return json(route, paged([]));
    }
    if (path.endsWith('/automation-runs')) {
      return json(route, paged([]));
    }
    if (/\/automation-templates\/[^/]+\/use$/.test(path) && method === 'POST') {
      const source = automationTemplates().find((template) => path.includes(`/${String(template['key'])}/use`));
      const body = route.request().postDataJSON() as { name?: string };
      const created = {
        id: 'automation-from-template', name: body.name ?? 'Template draft', description: source?.['description'] ?? null,
        templateKey: source?.['key'] ?? null, state: 'draft', workflow: source?.['preset'] ?? automationWorkflow(),
        timezone: 'Africa/Cairo', nextRunAt: null, lastRunAt: null, version: 1,
      };
      automationRows = [created, ...automationRows];
      return json(route, { data: created, request_id: 'e2e' }, 201);
    }
    if (path.endsWith('/automations')) {
      return json(route, paged(automationRows));
    }
    if (path.endsWith('/campaigns')) {
      return json(route, paged(campaigns()));
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
    // Routing is loaded beside the opened conversation. These are collection
    // responses, not conversation records: letting them fall through to the
    // generic `/conversations/:id` fixture turns `value` into an object and a
    // later render fails when it tries to search the collection.
    if (path.endsWith('/handoffs') || path.endsWith('/collaborators')) {
      return json(route, { data: [] });
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
