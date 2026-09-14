import type { FetchLike } from '../api/client.js';
import type { EventSourceFactory } from '../live/realtime.js';

/**
 * Demo mode: an in-browser stand-in for the API, opened only with `?demo=1`.
 *
 * It exists so the product can be shown to a prospective customer with a
 * populated workspace — conversations with history, customers, channels, a
 * team, campaigns and reports — without writing sample rows into a real
 * company's database. Nothing here is reachable without the query parameter,
 * and nothing here ever calls the network.
 */

type Json = Record<string, unknown>;
type Row = Json;

const TENANT = 'd0000000-0000-4000-8000-000000000001';

function uid(group: string, n: number): string {
  return `${group.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ME = uid('a', 1);
const MEMBERS = [
  { id: ME, email: '', name: 'أنت', role: 'admin' },
  { id: uid('a', 2), email: 'sara.ahmed@digital-school.com', name: 'سارة أحمد', role: 'supervisor' },
  { id: uid('a', 3), email: 'omar.khaled@digital-school.com', name: 'عمر خالد', role: 'agent' },
  { id: uid('a', 4), email: 'nour.hassan@digital-school.com', name: 'نور حسن', role: 'agent' },
  { id: uid('a', 5), email: 'youssef.ali@digital-school.com', name: 'يوسف علي', role: 'campaign_manager' },
  { id: uid('a', 6), email: 'owner@digital-school.com', name: 'مدير الأكاديمية', role: 'owner' },
] as const;

const ROLE_NAMES: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', supervisor: 'Supervisor', agent: 'Agent', campaign_manager: 'Campaign manager', analyst: 'Analyst',
};

const PERMISSIONS = [
  'conversation.read', 'conversation.unassigned.preview', 'conversation.reply', 'conversation.note',
  'conversation.claim', 'conversation.assign', 'conversation.handoff.request', 'conversation.close',
  'contact.read', 'contact.edit', 'consent.read', 'consent.record',
  'campaign.read', 'campaign.draft', 'campaign.approve', 'campaign.launch', 'campaign.control',
  'channel.manage', 'member.manage', 'role.manage', 'report.read',
];

const CHANNELS = {
  whatsapp: { id: uid('c', 1), inbox: 'خط التسجيل — واتساب' },
  messenger: { id: uid('c', 2), inbox: 'صفحة فيسبوك' },
  instagram: { id: uid('c', 3), inbox: 'إنستغرام الأكاديمية' },
  web_chat: { id: uid('c', 4), inbox: 'الدعم الفني — الموقع' },
} as const;

type Kind = keyof typeof CHANNELS;

interface Script {
  readonly name: string;
  readonly phone: string;
  readonly kind: Kind;
  readonly priority: string;
  readonly status: string;
  readonly unread: boolean;
  readonly startedMinutesAgo: number;
  readonly labels: readonly string[];
  readonly course: string;
  readonly city: string;
  /** `c:` from the customer, `a:` from the team. */
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

const SCRIPTS: readonly Script[] = [
  {
    name: 'سارة عبد الله', phone: '201001234567', kind: 'whatsapp', priority: 'high', status: 'open', unread: true, startedMinutesAgo: 42,
    labels: ['lb-parent', 'lb-interested'], course: 'تطوير الويب', city: 'القاهرة',
    lines: [
      'c:مساء الخير، سجّلت ابني في كورس تطوير الويب ولم تصلني رسالة التأكيد.',
      'a:أهلًا بحضرتك، ممكن رقم الطلب علشان أراجع التسجيل؟',
      'c:رقم الطلب 4817.',
      'a:تمام، الطلب ظاهر عندنا والدفع اكتمل. هبعت رسالة التأكيد تاني دلوقتي.',
      'c:وصلت، شكرًا جدًا. هل في جروب للطلاب قبل بداية الكورس؟',
      'a:أيوه، هيوصلكم لينك الجروب يوم الخميس مع جدول المحاضرات.',
      'c:ممتاز، وهل ممكن أغيّر موعد المحاضرة من الصبح للمسا؟',
    ],
    notes: ['العميلة ولية أمر، ابنها في الصف الثالث الإعدادي. الدفع كامل.', 'طلبت تغيير الموعد للفترة المسائية — راجعت مع التنسيق وفي أماكن متاحة.'],
  },
  {
    name: 'محمد الشريف', phone: '201112223344', kind: 'whatsapp', priority: 'normal', status: 'open', unread: false, startedMinutesAgo: 95,
    labels: ['lb-interested'], course: 'تحليل البيانات', city: 'الإسكندرية',
    lines: [
      'c:السلام عليكم، هل ينفع أدفع كورس تحليل البيانات على دفعات؟',
      'a:وعليكم السلام، أيوه متاح تقسيط على 3 دفعات بدون فوائد.',
      'c:طيب أول دفعة كام؟',
      'a:أول دفعة 1,500 جنيه عند التسجيل، والباقي على شهرين.',
      'c:تمام، ابعتلي لينك الدفع لو سمحت.',
      'a:اتفضل اللينك، وبعد الدفع هيوصلك تأكيد تلقائي خلال دقائق.',
    ],
    notes: [],
  },
  {
    name: 'ليلى منصور', phone: 'laila.mansour', kind: 'instagram', priority: 'normal', status: 'open', unread: true, startedMinutesAgo: 18,
    labels: ['lb-interested'], course: 'التسويق الرقمي', city: 'الجيزة',
    lines: [
      'c:مرحبا 👋 شفت إعلان كورس التسويق الرقمي، السعر كام؟',
      'a:أهلًا ليلى! الكورس 8 أسابيع وسعره 3,200 جنيه، وفي خصم 15% للتسجيل المبكر.',
      'c:والخصم لحد إمتى؟',
    ],
    notes: [],
  },
  {
    name: 'أحمد فؤاد', phone: 'visitor-5582', kind: 'web_chat', priority: 'urgent', status: 'open', unread: false, startedMinutesAgo: 12,
    labels: [], course: 'الذكاء الاصطناعي', city: 'المنصورة',
    lines: [
      'c:مش قادر أدخل على المنصة، بيقولي كلمة المرور غلط رغم إني غيرتها.',
      'a:آسفين على الإزعاج يا أحمد. ممكن الإيميل المسجّل بيه؟',
      'c:ahmed.fouad@mail.com',
      'a:لقيت الحساب، كان متقفل بعد محاولات دخول كتير. فتحته دلوقتي، جرّب تاني.',
      'c:لسه نفس المشكلة للأسف، والمحاضرة بعد نص ساعة.',
    ],
    notes: ['حوّلت المشكلة للدعم الفني — مستوى عاجل لأن المحاضرة قريبة.'],
  },
  {
    name: 'نور الهدى', phone: '100004455667', kind: 'messenger', priority: 'low', status: 'pending', unread: false, startedMinutesAgo: 260,
    labels: [], course: 'تطوير الويب', city: 'طنطا',
    lines: [
      'c:خلصت كورس تطوير الويب، إمتى أقدر أستلم الشهادة؟',
      'a:مبروك يا نور! الشهادات بتتطبع خلال 5 أيام عمل من آخر تقييم.',
      'c:تمام، هستلمها من الفرع ولا بتتبعت؟',
      'a:ممكن الاتنين. ابعتيلنا العنوان لو تحبي تتبعتلك بالشحن.',
    ],
    notes: [],
  },
  {
    name: 'يوسف كمال', phone: '201223344556', kind: 'whatsapp', priority: 'high', status: 'open', unread: true, startedMinutesAgo: 67,
    labels: ['lb-corporate', 'lb-vip'], course: 'الذكاء الاصطناعي', city: 'القاهرة',
    lines: [
      'c:مساء الخير، أنا مسؤول التدريب في شركة نور للبرمجيات. عندنا 25 موظف محتاجين تدريب ذكاء اصطناعي.',
      'a:أهلًا أستاذ يوسف، يسعدنا جدًا. تحبوا التدريب أونلاين ولا في مقر الشركة؟',
      'c:في مقر الشركة، يومين في الأسبوع.',
      'a:تمام، هجهز عرض سعر للشركات وأبعته النهارده قبل الساعة 5.',
      'c:ممتاز، ومحتاجين كمان شهادات معتمدة للموظفين.',
    ],
    notes: ['عميل شركات — فرصة 25 مقعد. متابعة مع قسم المبيعات لعرض السعر.'],
  },
  {
    name: 'هبة سالم', phone: '201099887766', kind: 'whatsapp', priority: 'normal', status: 'snoozed', unread: false, startedMinutesAgo: 1440,
    labels: ['lb-parent'], course: 'تحليل البيانات', city: 'أسيوط',
    lines: [
      'c:بنتي عندها امتحانات الأسبوع الجاي، ينفع تأجل المحاضرات أسبوعين؟',
      'a:أكيد، هنوقف حضورها ونرجعها مع الدفعة اللي بعدها بدون أي رسوم.',
      'c:شكرًا ليكم جدًا.',
    ],
    notes: [],
  },
  {
    name: 'كريم عادل', phone: '100007788990', kind: 'messenger', priority: 'high', status: 'resolved', unread: false, startedMinutesAgo: 2900,
    labels: [], course: 'التسويق الرقمي', city: 'الإسماعيلية',
    lines: [
      'c:دفعت مرتين بالغلط لنفس الكورس.',
      'a:آسفين يا كريم، راجعت العمليتين وهيتم استرداد المبلغ المكرر خلال 3 أيام عمل.',
      'c:تمام، وصلني الاسترداد النهارده. شكرًا.',
      'a:العفو، ولو احتجت أي حاجة إحنا موجودين.',
    ],
    notes: [],
  },
];

const EXTRA_CONTACTS = [
  { name: 'دينا رمزي', phone: '201055501234', kind: 'whatsapp' as Kind, course: 'تطوير الويب', city: 'القاهرة', labels: ['lb-interested'] },
  { name: 'طارق حسين', phone: '201066602345', kind: 'whatsapp' as Kind, course: 'الذكاء الاصطناعي', city: 'الجيزة', labels: ['lb-vip'] },
  { name: 'منى خليل', phone: 'mona.khalil', kind: 'instagram' as Kind, course: 'التسويق الرقمي', city: 'الزقازيق', labels: [] },
  { name: 'باسم وجدي', phone: '100003344221', kind: 'messenger' as Kind, course: 'تحليل البيانات', city: 'بورسعيد', labels: ['lb-corporate'] },
];

const LABELS = [
  { id: 'lb-parent', name: 'ولي أمر', color: '#6558d9', state: 'active', version: 1 },
  { id: 'lb-interested', name: 'مهتم بالتسجيل', color: '#2f7d5b', state: 'active', version: 1 },
  { id: 'lb-corporate', name: 'عميل شركات', color: '#b7791f', state: 'active', version: 1 },
  { id: 'lb-vip', name: 'VIP', color: '#c2410c', state: 'active', version: 1 },
];

const FIELD_COURSE = uid('f', 1);
const FIELD_CITY = uid('f', 2);
const FIELD_ORDER = uid('f', 3);

const CUSTOM_FIELDS = [
  { id: FIELD_COURSE, target: 'contact', key: 'course', name: 'الكورس', type: 'single_select', options: ['تطوير الويب', 'تحليل البيانات', 'التسويق الرقمي', 'الذكاء الاصطناعي'], state: 'active', version: 1 },
  { id: FIELD_CITY, target: 'contact', key: 'city', name: 'المدينة', type: 'text', options: [], state: 'active', version: 1 },
  { id: FIELD_ORDER, target: 'conversation', key: 'order_number', name: 'رقم الطلب', type: 'text', options: [], state: 'active', version: 1 },
];

interface State {
  signedIn: boolean;
  email: string;
  conversations: Row[];
  queue: Row[];
  messages: Map<string, Row[]>;
  notes: Map<string, Row[]>;
  episodes: Map<string, Row[]>;
  handoffs: Map<string, Row[]>;
  collaborators: Map<string, Row[]>;
  contacts: Row[];
  connections: Row[];
  testRecipients: Row[];
  campaigns: Row[];
  recipients: Map<string, Row[]>;
  people: Row[];
  invitations: Row[];
  teams: Row[];
  roles: Row[];
  labels: Row[];
  customFields: Row[];
  sessions: Row[];
  counter: number;
}

function labelRows(state: State, ids: readonly string[]): Row[] {
  return state.labels.filter((label) => ids.includes(String(label.id)));
}

function capabilities(kind: string): Json {
  const meta = kind === 'whatsapp' || kind === 'messenger' || kind === 'instagram';
  return {
    kind, version: meta ? 'v21.0' : '1', host: meta ? 'graph.facebook.com' : 'self',
    inboundEvents: ['message', 'delivery', 'read'], outboundTypes: ['text', 'template'],
    attachmentTypes: ['image', 'document'], textLimit: { characters: 4096, bytes: 16384 },
    windowHours: meta ? 24 : null, businessInitiated: kind === 'whatsapp', templates: kind === 'whatsapp',
    deliveryReceipts: true, readReceipts: kind !== 'instagram',
  };
}

function seed(now: number): State {
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();
  const state: State = {
    signedIn: true, email: 'admin@convo.com', conversations: [], queue: [], messages: new Map(), notes: new Map(),
    episodes: new Map(), handoffs: new Map(), collaborators: new Map(), contacts: [], connections: [], testRecipients: [],
    campaigns: [], recipients: new Map(), people: [], invitations: [], teams: [], roles: [], labels: LABELS.map((label) => ({ ...label })),
    customFields: CUSTOM_FIELDS.map((field) => ({ ...field })), sessions: [], counter: 100,
  };

  const contactFor = (index: number, name: string, phone: string, kind: Kind, course: string, city: string, labels: readonly string[], createdAgo: number): Row => ({
    id: uid('b', index + 1),
    displayName: name,
    attributes: { 'المدينة': city },
    version: 1,
    labels: labelRows(state, labels),
    customFields: [{ fieldId: FIELD_COURSE, value: course }, { fieldId: FIELD_CITY, value: city }],
    createdAt: at(createdAgo),
    identities: [{ id: uid('e', index + 1), kind, scopeId: CHANNELS[kind].id, externalId: phone, validFrom: at(createdAgo), validTo: null }],
    consent: [
      { channel: kind, purpose: 'service', state: 'granted', source: 'customer_message', recordedAt: at(createdAgo), actorMembershipId: null },
      ...(index % 3 === 0 ? [{ channel: kind, purpose: 'marketing', state: 'granted', source: 'agent_recorded', recordedAt: at(createdAgo - 5), actorMembershipId: ME }] : []),
    ],
    suppressed: index === 7 ? [kind] : [],
  });

  SCRIPTS.forEach((script, index) => {
    const conversationId = uid('f0', index + 1);
    const contact = contactFor(index, script.name, script.phone, script.kind, script.course, script.city, script.labels, script.startedMinutesAgo + 60 * 24 * (index + 2));
    state.contacts.push(contact);
    const step = Math.max(1, Math.floor(script.startedMinutesAgo / (script.lines.length + 1)));
    const rows = script.lines.map((line, position) => {
      const inbound = line.startsWith('c:');
      const minutesAgo = script.startedMinutesAgo - step * position;
      return {
        id: uid('10', (index + 1) * 100 + position), direction: inbound ? 'in' : 'out', at: at(minutesAgo), content_type: 'text',
        text: line.slice(2), attachments: [], author_membership_id: inbound ? null : ME,
        command_state: inbound ? null : 'provider_accepted', delivery_state: inbound ? null : position < script.lines.length - 2 ? 'read' : 'delivered',
        delivery_anomaly: null, provider_message_id: `wamid.demo.${String(index)}.${String(position)}`,
      };
    });
    state.messages.set(conversationId, rows);
    const last = rows[rows.length - 1] as Row;
    state.notes.set(conversationId, script.notes.map((body, position) => ({
      id: uid('20', (index + 1) * 10 + position), conversationId, authorMembershipId: position === 0 ? ME : MEMBERS[1].id,
      body, createdAt: at(script.startedMinutesAgo - 5 - position * 7), editedAt: null, deletedAt: null,
    })));
    state.episodes.set(conversationId, [
      ...(index === 1 ? [{ id: uid('30', index * 10 + 1), seq: 1, openedAt: at(60 * 24 * 20), openedBy: 'customer_inbound', firstInboundAt: at(60 * 24 * 20), firstResponseAt: at(60 * 24 * 20 - 4), closedAt: at(60 * 24 * 20 - 50), resolution: 'تم التسجيل في الكورس' }] : []),
      {
        id: uid('30', index * 10 + 2), seq: index === 1 ? 2 : 1, openedAt: at(script.startedMinutesAgo), openedBy: 'customer_inbound',
        firstInboundAt: at(script.startedMinutesAgo), firstResponseAt: at(script.startedMinutesAgo - Math.min(step, 6)),
        closedAt: script.status === 'resolved' ? at(Math.max(1, script.startedMinutesAgo - step * script.lines.length)) : null,
        resolution: script.status === 'resolved' ? 'تم استرداد المبلغ المكرر' : null,
      },
    ]);
    state.handoffs.set(conversationId, []);
    state.collaborators.set(conversationId, index === 5 ? [{ membershipId: MEMBERS[4].id, label: MEMBERS[4].name, addedAt: at(30), participated: false }] : []);
    state.conversations.push({
      id: conversationId, connectionId: CHANNELS[script.kind].id, peerIdentity: script.phone, teamId: null, assigneeMembershipId: ME,
      status: script.status, priority: script.priority, version: 4, waitingSince: script.unread ? String(last.at) : null,
      inboxLabel: CHANNELS[script.kind].inbox, channel: script.kind, participantMembershipIds: [ME], contactId: contact.id,
      pendingReason: script.status === 'pending' ? 'بانتظار عنوان الشحن من العميلة' : null,
      snoozedUntil: script.status === 'snoozed' ? new Date(now + 3 * 24 * 60 * 60_000).toISOString() : null,
      snoozeTimezone: script.status === 'snoozed' ? 'Africa/Cairo' : null,
      resolution: script.status === 'resolved' ? 'تم استرداد المبلغ المكرر' : null,
      resolvedAt: script.status === 'resolved' ? String(last.at) : null,
      lastActivityAt: String(last.at), ownerState: 'human_active', ownerVersion: 1, unread: script.unread,
      labels: labelRows(state, script.labels),
      customFields: index === 0 ? [{ fieldId: FIELD_ORDER, value: '4817' }] : [],
    });
  });

  EXTRA_CONTACTS.forEach((extra, offset) => {
    state.contacts.push(contactFor(SCRIPTS.length + offset, extra.name, extra.phone, extra.kind, extra.course, extra.city, extra.labels, 60 * 24 * (12 + offset)));
  });

  const queueChannels: readonly Kind[] = ['whatsapp', 'instagram', 'web_chat', 'whatsapp', 'messenger', 'whatsapp'];
  const queuePriorities = ['urgent', 'normal', 'high', 'normal', 'low', 'high'];
  queueChannels.forEach((kind, index) => {
    state.queue.push({
      id: uid('f1', index + 1), inboxLabel: CHANNELS[kind].inbox, channel: kind, maskedLabel: `••••${String(214 + index * 37).slice(-3)}`,
      priority: queuePriorities[index], status: 'open', waitingSinceAt: at(2 + index * 7), claimable: true, version: 1,
    });
  });

  const evidence = (satisfied: number, observedAgo: number): Row[] =>
    ['asset_verified', 'credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'].map((kind, index) => ({
      kind, satisfied: index < satisfied, observed_at: index < satisfied ? at(observedAgo - index * 30) : null,
    }));
  const connection = (kind: Kind, name: string, asset: string, status: string, satisfied: number): Row => ({
    id: CHANNELS[kind].id, kind, provider: kind === 'web_chat' ? 'web_chat' : 'meta', display_name: name, external_asset_id: asset,
    provider_app_id: kind === 'web_chat' ? null : '123456789012345', status, capabilities: capabilities(kind),
    evidence: evidence(satisfied, 60 * 24 * 30), missing_evidence: [], last_error_code: status === 'healthy' ? null : 'provider_not_connected',
    last_error_at: status === 'healthy' ? null : at(90), created_at: at(60 * 24 * 30), disconnected_at: null, credential_held: true,
    credential_fingerprint: 'a'.repeat(64),
  });
  state.connections.push(
    connection('whatsapp', 'Digital School — التسجيل', '109876543210', 'healthy', 5),
    connection('messenger', 'صفحة Digital School', '104455667788', 'healthy', 5),
    connection('web_chat', 'دردشة موقع الأكاديمية', 'widget-digital-school', 'healthy', 5),
    { ...connection('instagram', 'digitalschool.eg', '17841400000000001', 'authorization_needed', 1), missing_evidence: ['credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'] },
  );
  state.testRecipients.push({
    id: uid('40', 1), connection_id: CHANNELS.whatsapp.id, identity_id: uid('e', 1), peer_identity: '201000000000',
    display_name: 'هاتف الإدارة', label: 'هاتف الإدارة', authorized_at: at(60 * 24 * 3),
  });

  const campaign = (n: number, name: string, objective: string | null, campaignState: string, approved: boolean, audience: Json | null, execution: Json | null, updatedAgo: number): Row => ({
    id: uid('50', n), name, objective, connection_id: CHANNELS.whatsapp.id, state: campaignState, version: 3,
    revision_id: uid('51', n), revision: 1, revision_hash: String(n).repeat(64).slice(0, 64),
    content: { text: `مرحبًا {{name}}، ${objective ?? name}` }, variables: {}, audience_filter: {}, timezone: 'Africa/Cairo',
    expires_at: null, budget_amount_minor: '2500.000000', budget_currency: 'EGP', approved, audience, execution,
    created_at: at(updatedAgo + 60 * 24 * 2), updated_at: at(updatedAgo),
  });
  state.campaigns.push(
    campaign(1, 'دفعة سبتمبر — تأكيد التسجيل', 'تأكيد مقاعد الطلاب قبل بداية الدراسة', 'running', true, { total: 1280, eligible: 1146, excluded: 134 }, { id: uid('52', 1), state: 'running', scheduled_for: null }, 25),
    campaign(2, 'تذكير المحاضرة المباشرة', 'رفع نسبة حضور محاضرة الذكاء الاصطناعي', 'dispatch_completed', true, { total: 640, eligible: 618, excluded: 22 }, { id: uid('52', 2), state: 'completed', scheduled_for: null }, 60 * 26),
    campaign(3, 'عرض الخريف للشركات', 'عرض تدريب الموظفين للشركات', 'ready', true, { total: 320, eligible: 298, excluded: 22 }, null, 60 * 3),
    campaign(4, 'متابعة المهتمين', null, 'draft', false, null, null, 40),
  );
  const recipientStates = ['read', 'read', 'delivered', 'read', 'accepted', 'delivered', 'failed', 'read', 'delivered', 'read'];
  [1, 2].forEach((n) => {
    state.recipients.set(uid('50', n), state.contacts.slice(0, 10).map((contact, index) => ({
      id: uid('53', n * 100 + index), contact_id: contact.id, display_name: contact.displayName,
      external_id: (contact.identities as Row[])[0]?.externalId ?? '', state: recipientStates[index],
      last_error: recipientStates[index] === 'failed' ? { code: 'provider_rejected' } : null, estimated_amount_minor: '0.650000', currency: 'EGP',
    })));
  });

  state.roles.push(...Object.entries(ROLE_NAMES).map(([key, name], index) => ({
    id: uid('60', index + 1), key, name, is_builtin: true,
    grants: PERMISSIONS.slice(0, key === 'agent' ? 5 : key === 'analyst' ? 2 : PERMISSIONS.length - index * 2)
      .map((permission) => ({ permission_key: permission, scope_level: key === 'agent' ? 'own' : 'tenant' })),
  })));
  const roleOf = (key: string): Row => {
    const role = state.roles.find((entry) => entry.key === key) as Row;
    return { id: role.id, key, name: role.name };
  };
  state.people.push(...MEMBERS.map((member) => ({
    membership_id: member.id, email: member.email, status: 'active', role: roleOf(member.role),
    scopes: member.role === 'agent' ? [{ type: 'team', id: uid('70', 1) }] : [{ type: 'tenant', id: null }],
  })));
  state.teams.push(
    { id: uid('70', 1), name: 'فريق التسجيل', member_count: 3, archived: false, members: [ME, MEMBERS[2].id, MEMBERS[3].id].map((id) => ({ membership_id: id, email: '' })) },
    { id: uid('70', 2), name: 'الدعم الفني', member_count: 2, archived: false, members: [MEMBERS[1].id, MEMBERS[3].id].map((id) => ({ membership_id: id, email: '' })) },
  );
  state.invitations.push(
    { id: uid('80', 1), email: 'mariam.adel@digital-school.com', status: 'pending', role: roleOf('agent'), created_at: at(60 * 5), expires_at: new Date(now + 6 * 24 * 60 * 60_000).toISOString(), accepted_at: null, revoked_at: null, scopes: [] },
    { id: uid('80', 2), email: 'nour.hassan@digital-school.com', status: 'accepted', role: roleOf('agent'), created_at: at(60 * 24 * 20), expires_at: at(60 * 24 * 13), accepted_at: at(60 * 24 * 19), revoked_at: null, scopes: [] },
  );
  state.sessions.push(
    { id: uid('90', 1), current: true, created_at: at(35), last_seen_at: at(0), expires_at: new Date(now + 14 * 24 * 60 * 60_000).toISOString() },
    { id: uid('90', 2), current: false, created_at: at(60 * 24 * 2), last_seen_at: at(60 * 6), expires_at: new Date(now + 12 * 24 * 60 * 60_000).toISOString() },
  );
  return state;
}

function report(state: State, now: number): Json {
  const day = (daysAgo: number): string => new Date(now - daysAgo * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const fresh = new Date(now - 5 * 60_000).toISOString();
  const volumes = [96, 140, 118, 152, 131, 164, 112];
  return {
    generated_at: fresh, fresh_through: fresh, timezone: 'UTC',
    filters: { from: null, to: null, channel: null, campaign_id: null },
    definitions: { campaigns: state.campaigns.length, executions: 2 },
    audience: { denominator: 1920, eligible: 1764, excluded: 156 },
    current: { denominator: 1764, planned: 38, queued: 42, in_flight: 8, accepted: 212, delivered: 598, read: 812, failed: 31, skipped: 19, cancelled: 0, outcome_unknown: 4 },
    milestones: { denominator: 1764, accepted: 1622, delivered: 1410, read: 812 },
    trend: volumes.map((recipients, index) => ({
      day: day(volumes.length - 1 - index), recipients, accepted: Math.round(recipients * 0.92),
      delivered: Math.round(recipients * 0.8), read: Math.round(recipients * 0.46), failed: Math.round(recipients * 0.02),
    })),
    costs: [{ currency: 'EGP', estimated_amount_minor: '1146.600000', committed_amount_minor: '1054.200000', reconciled_amount_minor: '1031.900000' }],
    channels: [
      { kind: 'whatsapp', denominator: 1520, accepted: 1410, delivered: 1244, read: 740, delivery_receipts: true, read_receipts: true },
      { kind: 'messenger', denominator: 244, accepted: 212, delivered: 166, read: 72, delivery_receipts: true, read_receipts: true },
    ],
    errors: [{ code: 'provider_rejected', count: 18 }, { code: 'marketing_consent_missing', count: 9 }, { code: 'attempt_never_completed', count: 4 }],
    campaigns: [
      { id: uid('50', 1), name: 'دفعة سبتمبر — تأكيد التسجيل', state: 'running', denominator: 1146, pending: 88, accepted: 1030, delivered: 902, read: 514, failed: 19, outcome_unknown: 3, included: 1146, excluded: 134, fresh_through: fresh },
      { id: uid('50', 2), name: 'تذكير المحاضرة المباشرة', state: 'dispatch_completed', denominator: 618, pending: 0, accepted: 592, delivered: 508, read: 298, failed: 12, outcome_unknown: 1, included: 618, excluded: 22, fresh_through: fresh },
    ],
  };
}

function reply(status: number, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ok = (data: unknown): Response => reply(200, { data, request_id: 'demo' });
const page = (rows: readonly unknown[]): Response => reply(200, { data: rows, page: { next_cursor: null, has_more: false }, request_id: 'demo' });

function parseBody(init: RequestInit): Json {
  if (typeof init.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Json;
  } catch {
    return {};
  }
}

/** A fetch that answers `/api/v1/*` from the sample workspace, in memory. */
export function createDemoServer(clock: () => number = () => Date.now()): FetchLike {
  const state = seed(clock());
  const iso = (): string => new Date(clock()).toISOString();
  const next = (group: string): string => uid(group, (state.counter += 1));
  const find = (rows: readonly Row[], id: string): Row | undefined => rows.find((row) => row.id === id);
  const person = (id: string): Row | undefined => state.people.find((row) => row.membership_id === id);
  const nameOf = (id: string): string => MEMBERS.find((member) => member.id === id)?.name ?? 'زميل';

  const withEmails = (): Row[] => state.people.map((row) => (row.membership_id === ME ? { ...row, email: state.email } : row));
  const teamsView = (): Row[] => state.teams.map((team) => ({
    ...team,
    members: (team.members as Row[]).map((member) => ({ ...member, email: String(withEmails().find((row) => row.membership_id === member.membership_id)?.email ?? '') })),
  }));

  const applyLabels = (row: Row, body: Json): void => {
    const current = new Set((row.labels as Row[]).map((label) => String(label.id)));
    for (const id of (body.addLabels as string[] | undefined) ?? []) current.add(id);
    for (const id of (body.removeLabels as string[] | undefined) ?? []) current.delete(id);
    row.labels = labelRows(state, [...current]);
    const fields = new Map((row.customFields as Row[]).map((field) => [String(field.fieldId), field]));
    for (const change of (body.fields as Row[] | undefined) ?? []) {
      if (change.value === null) fields.delete(String(change.fieldId));
      else fields.set(String(change.fieldId), { fieldId: change.fieldId, value: change.value });
    }
    row.customFields = [...fields.values()];
    row.version = Number(row.version ?? 1) + 1;
  };

  const handle = (method: string, path: string, query: URLSearchParams, body: Json): Response => {
    if (path === '/auth/login' && method === 'POST') {
      state.signedIn = true;
      state.email = typeof body.email === 'string' && body.email !== '' ? body.email : 'admin@convo.com';
      return ok({ user: { id: 'demo-user', email: state.email } });
    }
    if (path === '/auth/logout' && method === 'POST') {
      state.signedIn = false;
      return reply(204);
    }
    if (!state.signedIn) {
      return reply(401, { error: { code: 'authentication_required', message: 'Authentication is required.', request_id: 'demo', details: [] } });
    }
    if (path === '/auth/session') return ok({ user: { id: 'demo-user', email: state.email } });
    if (path === '/auth/sessions') return page(state.sessions);
    const sessionMatch = /^\/auth\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null && method === 'DELETE') {
      state.sessions = state.sessions.filter((row) => row.id !== sessionMatch[1]);
      return reply(204);
    }
    if (path === '/me/memberships') {
      return ok([{ id: ME, tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' }, role: { id: uid('60', 2), key: 'admin', name: 'Admin' }, permissions: PERMISSIONS }]);
    }

    const tenant = /^\/tenants\/[^/]+(\/.*)?$/.exec(path);
    if (tenant === null) return notAvailable();
    const rest = tenant[1] ?? '';
    const segments = rest.split('/').filter((segment) => segment !== '');
    const [resource, id, action, extra] = segments;

    /* ------------------------------------------------------------ inbox -- */
    if (resource === 'conversations') {
      if (id === 'unassigned' && method === 'GET') {
        const priority = query.get('priority');
        const channel = query.get('channel');
        return ok(state.queue.filter((card) => (priority === null || card.priority === priority) && (channel === null || card.channel === channel)));
      }
      if (id === undefined && method === 'GET') {
        const priority = query.get('priority');
        const channel = query.get('channel');
        const unread = query.get('unread');
        const label = query.get('label');
        const rows = state.conversations
          .filter((row) => row.assigneeMembershipId === ME || query.get('queue') === 'all')
          .filter((row) => priority === null || row.priority === priority)
          .filter((row) => channel === null || row.channel === channel)
          .filter((row) => unread === null || String(row.unread === true) === unread)
          .filter((row) => label === null || (row.labels as Row[]).some((entry) => entry.id === label))
          .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
        return page(rows);
      }
      if (id === undefined) return notAvailable();
      let conversation = find(state.conversations, id);
      if (action === 'claim' && method === 'POST') {
        const card = find(state.queue, id);
        if (conversation === undefined && card !== undefined) {
          state.queue = state.queue.filter((row) => row.id !== id);
          const contact = state.contacts[SCRIPTS.length] as Row;
          const identity = (contact.identities as Row[])[0] as Row;
          conversation = {
            id, connectionId: CHANNELS[card.channel as Kind].id, peerIdentity: identity.externalId, teamId: null, assigneeMembershipId: ME,
            status: 'open', priority: card.priority, version: 2, waitingSince: card.waitingSinceAt, inboxLabel: card.inboxLabel,
            channel: card.channel, participantMembershipIds: [ME], contactId: contact.id, pendingReason: null, snoozedUntil: null,
            snoozeTimezone: null, resolution: null, resolvedAt: null, lastActivityAt: String(card.waitingSinceAt), ownerState: 'human_active',
            ownerVersion: 1, unread: true, labels: [], customFields: [],
          };
          state.conversations.push(conversation);
          state.messages.set(id, [
            { id: next('10'), direction: 'in', at: String(card.waitingSinceAt), content_type: 'text', text: 'السلام عليكم، عايز أعرف مواعيد الدفعة الجاية وأسعار الكورسات.', attachments: [], author_membership_id: null, command_state: null, delivery_state: null, delivery_anomaly: null, provider_message_id: `wamid.demo.${id}` },
          ]);
          state.notes.set(id, []);
          state.episodes.set(id, [{ id: next('30'), seq: 1, openedAt: String(card.waitingSinceAt), openedBy: 'customer_inbound', firstInboundAt: String(card.waitingSinceAt), firstResponseAt: null, closedAt: null, resolution: null }]);
          state.handoffs.set(id, []);
          state.collaborators.set(id, []);
        }
        if (conversation === undefined) return notFound();
        conversation.assigneeMembershipId = ME;
        conversation.version = Number(conversation.version) + 1;
        return ok(conversation);
      }
      if (conversation === undefined) return notFound();
      if (action === undefined && method === 'GET') return ok(conversation);
      if (action === 'messages' && method === 'GET') {
        return page([...(state.messages.get(id) ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at))));
      }
      if (action === 'messages' && method === 'POST') {
        const text = typeof body.text === 'string' ? body.text : typeof body.body === 'string' ? body.body : '';
        const message = { id: next('10'), direction: 'out', at: iso(), content_type: 'text', text, attachments: [], author_membership_id: ME, command_state: 'provider_accepted', delivery_state: 'delivered', delivery_anomaly: null, provider_message_id: `wamid.demo.${String(state.counter)}` };
        state.messages.set(id, [...(state.messages.get(id) ?? []), message]);
        conversation.lastActivityAt = message.at;
        conversation.waitingSince = null;
        return reply(202, { data: { id: message.id, command_state: 'provider_accepted', state_reason: null, delivery_state: 'delivered' }, request_id: 'demo' });
      }
      if (action === 'notes' && method === 'GET') return page(state.notes.get(id) ?? []);
      if (action === 'notes' && method === 'POST') {
        const note = { id: next('20'), conversationId: id, authorMembershipId: ME, body: String(body.body ?? ''), createdAt: iso(), editedAt: null, deletedAt: null };
        state.notes.set(id, [...(state.notes.get(id) ?? []), note]);
        return reply(201, { data: note, request_id: 'demo' });
      }
      if (action === 'episodes' && method === 'GET') return page(state.episodes.get(id) ?? []);
      if (action === 'handoffs' && method === 'GET') return page(state.handoffs.get(id) ?? []);
      if (action === 'handoffs' && method === 'POST') {
        const to = String(body.toMembershipId ?? '');
        const handoff = { id: next('21'), conversationId: id, fromMembershipId: ME, fromLabel: 'أنت', toMembershipId: to, toLabel: nameOf(to), state: 'pending', note: typeof body.note === 'string' ? body.note : null, basedOnVersion: conversation.version, createdAt: iso(), expiresAt: new Date(clock() + 30 * 60_000).toISOString(), settledAt: null, settledByMembershipId: null };
        state.handoffs.set(id, [...(state.handoffs.get(id) ?? []), handoff]);
        return reply(201, { data: handoff, request_id: 'demo' });
      }
      if (action === 'collaborators') {
        const list = state.collaborators.get(id) ?? [];
        if (method === 'GET') return page(list);
        if (method === 'POST') {
          const member = String(body.membershipId ?? '');
          const updated = [...list.filter((row) => row.membershipId !== member), { membershipId: member, label: nameOf(member), addedAt: iso(), participated: false }];
          state.collaborators.set(id, updated);
          return ok(updated);
        }
        if (method === 'DELETE' && extra !== undefined) {
          const updated = list.filter((row) => row.membershipId !== extra);
          state.collaborators.set(id, updated);
          return ok(updated);
        }
      }
      if (action === 'read' && method === 'POST') {
        conversation.unread = false;
        return ok({ readThrough: iso() });
      }
      if (action === 'transitions' && method === 'POST') {
        const command = String(body.command ?? '');
        const status: Record<string, string> = { wait: 'pending', snooze: 'snoozed', resolve: 'resolved', reopen: 'open', archive: 'archived' };
        conversation.status = status[command] ?? conversation.status;
        conversation.pendingReason = command === 'wait' ? String(body.reason ?? '') : null;
        conversation.snoozedUntil = command === 'snooze' ? String(body.wakeAt ?? iso()) : null;
        conversation.snoozeTimezone = command === 'snooze' ? String(body.timezone ?? 'Africa/Cairo') : null;
        conversation.resolution = command === 'resolve' ? String(body.resolution ?? '') : null;
        conversation.resolvedAt = command === 'resolve' ? iso() : null;
        conversation.version = Number(conversation.version) + 1;
        return ok(conversation);
      }
      if (action === 'assignments' && method === 'POST') {
        conversation.assigneeMembershipId = (body.assigneeMembershipId as string | null | undefined) ?? (body.membershipId as string | null | undefined) ?? null;
        conversation.version = Number(conversation.version) + 1;
        return ok(conversation);
      }
      if (action === 'priority' && method === 'PATCH') {
        conversation.priority = String(body.priority ?? conversation.priority);
        conversation.version = Number(conversation.version) + 1;
        return ok(conversation);
      }
      if (action === 'metadata' && method === 'PATCH') {
        applyLabels(conversation, body);
        conversation.version = Number(conversation.version) + 1;
        return ok({ version: conversation.version, metadata: { labels: conversation.labels, customFields: conversation.customFields } });
      }
      return notAvailable();
    }

    if (resource === 'notes' && id !== undefined) {
      for (const [conversationId, list] of state.notes) {
        const note = find(list, id);
        if (note === undefined) continue;
        if (method === 'PATCH') {
          note.body = String(body.body ?? note.body);
          note.editedAt = iso();
        } else if (method === 'DELETE') {
          note.body = '';
          note.deletedAt = iso();
        }
        state.notes.set(conversationId, list);
        return ok(note);
      }
      return notFound();
    }

    if (resource === 'directory' && id === 'agents') {
      const conversation = find(state.conversations, query.get('conversation_id') ?? '');
      return page(MEMBERS.filter((member) => member.role !== 'owner').map((member) => ({
        membershipId: member.id, label: member.id === ME ? state.email : member.name, assigned: conversation?.assigneeMembershipId === member.id,
      })));
    }

    if (resource === 'handoffs' && id !== undefined && action !== undefined) {
      for (const list of state.handoffs.values()) {
        const handoff = find(list, id);
        if (handoff === undefined) continue;
        handoff.state = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
        handoff.settledAt = iso();
        handoff.settledByMembershipId = ME;
        return ok(handoff);
      }
      return notFound();
    }

    /* --------------------------------------------------------- metadata -- */
    if (resource === 'labels') {
      if (method === 'GET') return page(state.labels);
      if (method === 'POST') {
        const label = { id: next('ab'), name: String(body.name ?? ''), color: String(body.color ?? '#6558d9'), state: 'active', version: 1 };
        state.labels.push(label);
        return reply(201, { data: label, request_id: 'demo' });
      }
    }
    if (resource === 'custom-fields') {
      if (method === 'GET') return page(state.customFields);
      if (method === 'POST') {
        const field = { id: next('ac'), target: body.target ?? 'contact', key: body.key ?? 'field', name: body.name ?? '', type: body.type ?? 'text', options: body.options ?? [], state: 'active', version: 1 };
        state.customFields.push(field);
        return reply(201, { data: field, request_id: 'demo' });
      }
    }

    /* --------------------------------------------------------- contacts -- */
    if (resource === 'contacts') {
      if (id === undefined && method === 'GET') {
        const q = (query.get('q') ?? '').trim();
        const label = query.get('label');
        return page(state.contacts
          .filter((contact) => q === '' || String(contact.displayName).includes(q) || (contact.identities as Row[]).some((identity) => String(identity.externalId).includes(q)))
          .filter((contact) => label === null || (contact.labels as Row[]).some((entry) => entry.id === label))
          .map((contact) => {
            // The list is the summary shape: consent and suppressions come with the detail read.
            const summary: Row = { ...contact };
            delete summary.consent;
            delete summary.suppressed;
            return summary;
          }));
      }
      const contact = id === undefined ? undefined : find(state.contacts, id);
      if (contact === undefined) return notFound();
      if (action === undefined && method === 'GET') return ok(contact);
      if (action === undefined && method === 'PATCH') {
        if (typeof body.displayName === 'string') contact.displayName = body.displayName;
        contact.version = Number(contact.version) + 1;
        return ok(contact);
      }
      if (action === 'consents' && method === 'POST') {
        contact.consent = [{ channel: body.channel, purpose: body.purpose, state: body.state, source: 'agent_recorded', recordedAt: iso(), actorMembershipId: ME }, ...(contact.consent as Row[])];
        return reply(201, { data: contact, request_id: 'demo' });
      }
      if (action === 'metadata' && method === 'PATCH') {
        applyLabels(contact, body);
        return ok({ version: contact.version, metadata: { labels: contact.labels, customFields: contact.customFields } });
      }
      return notAvailable();
    }

    /* --------------------------------------------------------- channels -- */
    if (resource === 'channels') {
      if (id === 'catalogue') {
        return page(['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'].map((kind) => ({ kind, provider: kind === 'web_chat' || kind === 'custom' ? kind : 'meta', implemented: true, capabilities: capabilities(kind) })));
      }
      if (id === undefined && method === 'GET') return page(state.connections);
      if (id === undefined && method === 'POST') {
        const kind = String(body.kind ?? 'whatsapp');
        const created = { id: next('c'), kind, provider: kind === 'web_chat' || kind === 'custom' ? kind : 'meta', display_name: String(body.displayName ?? ''), external_asset_id: String(body.externalAssetId ?? ''), provider_app_id: body.providerAppId ?? null, status: 'authorization_needed', capabilities: capabilities(kind), evidence: [{ kind: 'asset_verified', satisfied: true, observed_at: iso() }, ...['credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'].map((entry) => ({ kind: entry, satisfied: false, observed_at: null }))], missing_evidence: ['credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'], last_error_code: null, last_error_at: null, created_at: iso(), disconnected_at: null, credential_held: true, credential_fingerprint: 'c'.repeat(64) };
        state.connections.push(created);
        return reply(201, { data: created, request_id: 'demo' });
      }
      const connection = id === undefined ? undefined : find(state.connections, id);
      if (connection === undefined) return notFound();
      if (action === 'test-recipients') {
        if (method === 'GET') return page(state.testRecipients.filter((row) => row.connection_id === id));
        if (method === 'POST') {
          const recipient = { id: next('40'), connection_id: id, identity_id: next('e'), peer_identity: String(body.peerIdentity ?? ''), display_name: String(body.label ?? ''), label: String(body.label ?? ''), authorized_at: iso() };
          state.testRecipients.push(recipient);
          return reply(201, { data: recipient, request_id: 'demo' });
        }
        if (method === 'DELETE' && extra !== undefined) {
          state.testRecipients = state.testRecipients.filter((row) => row.id !== extra);
          return reply(204);
        }
      }
      if (action === 'test' && method === 'POST') return ok(connection);
      if (action === 'credential' && method === 'POST') return ok(connection);
      if (action === undefined && method === 'DELETE') {
        connection.status = 'disconnected';
        connection.disconnected_at = iso();
        return reply(204);
      }
      return notAvailable();
    }

    /* -------------------------------------------------------- campaigns -- */
    if (resource === 'reports' && id === 'campaigns') {
      if (action === undefined) return ok(report(state, clock()));
      if (action === 'exports') {
        const job = { id: extra ?? next('ad'), campaign_id: body.campaignId ?? null, format: 'csv', state: 'completed', row_count: 1764, error_code: null, requested_at: iso(), completed_at: iso(), expires_at: new Date(clock() + 24 * 60 * 60_000).toISOString(), download_url: null };
        return reply(method === 'POST' ? 202 : 200, { data: job, request_id: 'demo' });
      }
    }
    if (resource === 'campaigns') {
      if (id === undefined && method === 'GET') return page(state.campaigns);
      if (id === undefined && method === 'POST') {
        const created = { ...(state.campaigns[3] as Row), id: next('50'), name: String(body.name ?? 'حملة جديدة'), objective: (body.objective as string | undefined) ?? null, state: 'draft', approved: false, audience: null, execution: null, created_at: iso(), updated_at: iso() };
        state.campaigns.unshift(created);
        return reply(201, { data: created, request_id: 'demo' });
      }
      const campaign = id === undefined ? undefined : find(state.campaigns, id);
      if (campaign === undefined) return notFound();
      const touch = (changes: Json, status = 200): Response => {
        Object.assign(campaign, changes, { updated_at: iso(), version: Number(campaign.version) + 1 });
        return reply(status, { data: campaign, request_id: 'demo' });
      };
      if (action === 'recipients' && method === 'GET') return page(state.recipients.get(id as string) ?? []);
      if (action === undefined && method === 'PATCH') return touch({ name: body.name ?? campaign.name, objective: body.objective ?? campaign.objective, revision: Number(campaign.revision) + 1 });
      if (action === 'validate') return touch({ state: 'ready', audience: { total: 480, eligible: 452, excluded: 28 } });
      if (action === 'approve') return touch({ approved: true });
      if (action === 'launch') {
        const scheduled = typeof body.scheduledFor === 'string' ? body.scheduledFor : null;
        return touch({ state: scheduled === null ? 'running' : 'scheduled', execution: { id: next('52'), state: scheduled === null ? 'running' : 'scheduled', scheduled_for: scheduled } }, 202);
      }
      if (action === 'control') {
        const verb = String(body.action ?? '');
        return touch({ state: verb === 'pause' ? 'paused' : verb === 'resume' ? 'running' : 'cancelled' }, 202);
      }
      if (action === 'clone') {
        const clone = { ...campaign, id: next('50'), name: String(body.name ?? `${String(campaign.name)} (نسخة)`), state: 'draft', approved: false, execution: null, created_at: iso(), updated_at: iso() };
        state.campaigns.unshift(clone);
        return reply(201, { data: clone, request_id: 'demo' });
      }
      if (action === 'test-send') {
        const recipient = state.testRecipients[0] as Row;
        return reply(202, { data: { id: next('54'), campaign_id: id, revision_id: campaign.revision_id, test_recipient_id: recipient.id, recipient_label: recipient.label, peer_identity: recipient.peer_identity, message_id: next('10'), state: 'queued', state_reason: null, created_at: iso() }, request_id: 'demo' });
      }
      if (action === 'retry') return reply(202, { data: { id: next('55'), campaign_id: id, execution_id: (campaign.execution as Row | null)?.id ?? null, recipient_count: 1, created_at: iso() }, request_id: 'demo' });
      return notAvailable();
    }

    /* ----------------------------------------------------------- people -- */
    if (resource === 'people') {
      if (id === undefined && method === 'GET') return page(withEmails());
      const row = id === undefined ? undefined : person(id);
      if (row === undefined) return notFound();
      if (method === 'PATCH') {
        if (typeof body.status === 'string') row.status = body.status;
        if (typeof body.roleId === 'string') {
          const role = find(state.roles, body.roleId);
          if (role !== undefined) row.role = { id: role.id, key: role.key, name: role.name };
        }
        if (Array.isArray(body.scopes)) row.scopes = body.scopes;
        return ok(withEmails().find((entry) => entry.membership_id === id));
      }
    }
    if (resource === 'roles') {
      if (id === undefined && method === 'GET') return page(state.roles);
      if (id === undefined && method === 'POST') {
        const created = { id: next('60'), key: `custom_${String(state.counter)}`, name: String(body.name ?? ''), is_builtin: false, grants: ((body.grants as Row[] | undefined) ?? []).map((grant) => ({ permission_key: grant.permission, scope_level: grant.scope })) };
        state.roles.push(created);
        return reply(201, { data: created, request_id: 'demo' });
      }
      const role = id === undefined ? undefined : find(state.roles, id);
      if (role === undefined) return notFound();
      if (method === 'PATCH') {
        role.name = String(body.name ?? role.name);
        return ok(role);
      }
      if (method === 'DELETE') {
        state.roles = state.roles.filter((entry) => entry.id !== id);
        return reply(204);
      }
    }
    if (resource === 'teams') {
      if (id === undefined && method === 'GET') return page(teamsView());
      if (id === undefined && method === 'POST') {
        const created = { id: next('70'), name: String(body.name ?? ''), member_count: 0, archived: false, members: [] };
        state.teams.push(created);
        return reply(201, { data: created, request_id: 'demo' });
      }
      const team = id === undefined ? undefined : find(state.teams, id);
      if (team === undefined) return notFound();
      if (action === undefined && method === 'PATCH') {
        if (typeof body.archived === 'boolean') team.archived = body.archived;
        if (typeof body.name === 'string') team.name = body.name;
      } else if (action === 'members' && method === 'POST') {
        team.members = [...(team.members as Row[]), { membership_id: body.membershipId, email: '' }];
      } else if (action === 'members' && method === 'DELETE') {
        team.members = (team.members as Row[]).filter((member) => member.membership_id !== extra);
      }
      team.member_count = (team.members as Row[]).length;
      return ok(teamsView().find((entry) => entry.id === id));
    }
    if (resource === 'invitations') {
      if (id === undefined && method === 'GET') return page(state.invitations);
      if (id === undefined && method === 'POST') {
        const role = find(state.roles, String(body.roleId ?? '')) ?? (state.roles[3] as Row);
        const created = { id: next('80'), email: String(body.email ?? ''), status: 'pending', role: { id: role.id, key: role.key, name: role.name }, created_at: iso(), expires_at: new Date(clock() + 7 * 24 * 60 * 60_000).toISOString(), accepted_at: null, revoked_at: null, scopes: [] };
        state.invitations.unshift(created);
        return reply(201, { data: created, request_id: 'demo' });
      }
      const invitation = id === undefined ? undefined : find(state.invitations, id);
      if (invitation !== undefined && method === 'DELETE') {
        invitation.status = 'revoked';
        invitation.revoked_at = iso();
        return reply(204);
      }
    }
    if (resource === 'permissions') {
      return page(PERMISSIONS.map((key) => ({ key, description: key, delegable: true })));
    }
    if (resource === 'ownership-transfers' && method === 'GET') return page([]);

    return notAvailable();
  };

  return async (url, init) => {
    const parsed = new URL(url, 'https://demo.local');
    const path = parsed.pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    // A short, steady delay so loading states read as a real network.
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    return handle(method, path, parsed.searchParams, parseBody(init));
  };
}

function notFound(): Response {
  return reply(404, { error: { code: 'resource_not_found', message: 'The requested resource does not exist.', request_id: 'demo', details: [] } });
}

function notAvailable(): Response {
  return reply(422, { error: { code: 'demo_unavailable', message: 'هذا الإجراء غير متاح في نسخة العرض.', request_id: 'demo', details: [] } });
}

/** Demo mode has no live stream; the connection simply stays quiet. */
export const silentEventSource: EventSourceFactory = () => ({
  addEventListener: () => undefined,
  close: () => undefined,
});

/** Whether the page was opened in demo mode (`?demo=1`). */
export function isDemo(search: string): boolean {
  return new URLSearchParams(search).has('demo');
}
