/**
 * Demo dataset for the client build.
 *
 * Every timestamp is derived from a caller-supplied `now`, so the workspace
 * always reads as "today" in a demo and stays deterministic in tests. Content is
 * realistic synthetic Arabic/English support traffic per design-reference §8 —
 * long names, mixed-script strings, order IDs, emoji, a very long thread, a
 * missing avatar. No lorem ipsum, and no invented provider statistics.
 */

import type { Lang } from './format';
import { dateFormat } from './format';

export type ChannelKind = 'whatsapp' | 'instagram' | 'messenger';
export type ConversationStatus = 'open' | 'pending' | 'snoozed' | 'resolved';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type SlaState = 'breached' | 'due' | 'healthy' | 'none';
export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';
export type RoleId = 'owner' | 'admin' | 'supervisor' | 'agent' | 'campaign_manager' | 'analyst';

export interface Team {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
}

export interface InboxRef {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly channel: ChannelKind;
  readonly teamId: string;
  readonly connectionId: string;
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly role: RoleId;
  readonly teamIds: readonly string[];
  readonly inboxIds: readonly string[];
  readonly presence: 'online' | 'away' | 'offline';
  readonly openLoad: number;
}

export interface LabelRef {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly tone: 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly scope: 'private' | 'team' | 'workspace';
  readonly criteria: SavedViewCriteria;
}

export interface SavedViewCriteria {
  readonly queue?: 'all' | 'unread' | 'read' | 'mine' | 'unassigned';
  readonly statuses?: readonly ConversationStatus[];
  readonly priorities?: readonly Priority[];
  readonly channels?: readonly ChannelKind[];
  readonly slas?: readonly SlaState[];
  readonly labels?: readonly string[];
  readonly inboxes?: readonly string[];
  readonly teams?: readonly string[];
  readonly sort?: SortOrder;
}

export type SortOrder = 'recent' | 'oldest' | 'sla' | 'priority' | 'unread';

export interface ConsentGrant {
  readonly channel: ChannelKind;
  readonly state: 'granted' | 'withdrawn' | 'none';
  readonly source: string;
  readonly sourceEn: string;
  readonly recordedAt: string;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly handle: string | null;
  readonly locale: 'ar-EG' | 'en-GB';
  readonly city: string;
  readonly cityEn: string;
  readonly attributes: readonly {
    readonly label: string;
    readonly labelEn: string;
    readonly value: string;
  }[];
  readonly consent: readonly ConsentGrant[];
  readonly suppression: {
    readonly active: boolean;
    readonly reason: string | null;
    readonly reasonEn: string | null;
    readonly at: string | null;
  };
  readonly crm: {
    readonly system: string;
    readonly reference: string;
    readonly stage: string;
    readonly stageEn: string;
    readonly syncedAt: string;
  } | null;
  readonly history: readonly {
    readonly id: string;
    readonly title: string;
    readonly titleEn: string;
    readonly at: string;
    readonly outcome: string;
    readonly outcomeEn: string;
  }[];
}

/** The full server-side record. The UI never renders this directly — see projection.ts. */
export interface ConversationRecord {
  readonly id: string;
  readonly reference: string;
  readonly contactId: string;
  readonly inboxId: string;
  readonly teamId: string;
  readonly channel: ChannelKind;
  readonly assigneeId: string | null;
  readonly participantIds: readonly string[];
  readonly status: ConversationStatus;
  readonly priority: Priority;
  readonly sla: SlaState;
  readonly labels: readonly string[];
  readonly unreadCount: number;
  readonly lastActivityAt: string;
  readonly openedAt: string;
  readonly waitingSinceAt: string;
  readonly snippet: string;
  readonly snippetDirection: 'in' | 'out';
  readonly windowExpiresAt: string | null;
  readonly snoozedUntil: string | null;
  readonly episode: number;
}

export interface Attachment {
  readonly name: string;
  readonly size: string;
  readonly kind: 'image' | 'document' | 'audio';
}

export type TimelineItem =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly direction: 'in' | 'out';
      readonly authorName: string;
      readonly body: string;
      readonly at: string;
      readonly delivery: DeliveryState;
      readonly attachments?: readonly Attachment[];
    }
  | {
      readonly kind: 'note';
      readonly id: string;
      readonly authorName: string;
      readonly body: string;
      readonly at: string;
    }
  | { readonly kind: 'event'; readonly id: string; readonly text: string; readonly at: string };

export interface ChannelConnection {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly asset: string;
  readonly label: string;
  readonly labelEn: string;
  readonly readiness:
    | 'not_configured'
    | 'authorization_pending'
    | 'verifying'
    | 'connected'
    | 'degraded'
    | 'reauthorization_required'
    | 'disconnected';
  readonly inboxId: string | null;
  readonly evidence: readonly {
    readonly label: string;
    readonly labelEn: string;
    readonly done: boolean;
  }[];
  readonly windowHours: number;
  readonly note: string;
  readonly noteEn: string;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string;
  readonly channel: ChannelKind;
  readonly state:
    | 'draft'
    | 'validating'
    | 'ready'
    | 'scheduled'
    | 'running'
    | 'paused'
    | 'dispatch_completed'
    | 'cancelled';
  readonly approved: boolean;
  readonly audienceSize: number;
  readonly snapshotAt: string | null;
  readonly ledger: {
    readonly accepted: number;
    readonly failed: number;
    readonly skipped: number;
    readonly unknown: number;
    readonly pending: number;
  };
  readonly templateRevision: string;
}

export interface Dataset {
  readonly now: Date;
  readonly teams: readonly Team[];
  readonly inboxes: readonly InboxRef[];
  readonly members: readonly Member[];
  readonly labels: readonly LabelRef[];
  readonly views: readonly SavedView[];
  readonly contacts: readonly Contact[];
  readonly conversations: readonly ConversationRecord[];
  readonly timelines: Readonly<Record<string, readonly TimelineItem[]>>;
  readonly channels: readonly ChannelConnection[];
  readonly campaigns: readonly Campaign[];
}

export const CURRENT_MEMBER_ID = 'm-hana';

const MINUTE = 60_000;

function ago(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * MINUTE).toISOString();
}

function ahead(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * MINUTE).toISOString();
}

export const TEAMS: readonly Team[] = [
  { id: 't-care', name: 'دعم الطلاب', nameEn: 'Student Support' },
  { id: 't-orders', name: 'التسجيل والمدفوعات', nameEn: 'Enrollment & Payments' },
  { id: 't-vip', name: 'المتابعة والمتدربون المميزون', nameEn: 'Success & VIP Learners' },
];

export const INBOXES: readonly InboxRef[] = [
  {
    id: 'ib-wa-cairo',
    name: 'واتساب — الاستفسارات',
    nameEn: 'WhatsApp — Enquiries',
    channel: 'whatsapp',
    teamId: 't-care',
    connectionId: 'cn-wa-1',
  },
  {
    id: 'ib-wa-orders',
    name: 'واتساب — التسجيل',
    nameEn: 'WhatsApp — Enrollment',
    channel: 'whatsapp',
    teamId: 't-orders',
    connectionId: 'cn-wa-2',
  },
  {
    id: 'ib-ig',
    name: 'إنستجرام — @digitalschool',
    nameEn: 'Instagram — @digitalschool',
    channel: 'instagram',
    teamId: 't-care',
    connectionId: 'cn-ig-1',
  },
  {
    id: 'ib-mg',
    name: 'ماسنجر — Digital School',
    nameEn: 'Messenger — Digital School',
    channel: 'messenger',
    teamId: 't-vip',
    connectionId: 'cn-mg-1',
  },
];

export const MEMBERS: readonly Member[] = [
  {
    id: CURRENT_MEMBER_ID,
    name: 'هناء عبد الرحمن',
    nameEn: 'Hanaa Abdelrahman',
    role: 'supervisor',
    teamIds: ['t-care', 't-orders', 't-vip'],
    inboxIds: ['ib-wa-cairo', 'ib-wa-orders', 'ib-ig', 'ib-mg'],
    presence: 'online',
    openLoad: 7,
  },
  {
    id: 'm-tarek',
    name: 'طارق منير',
    nameEn: 'Tarek Mounir',
    role: 'agent',
    teamIds: ['t-care'],
    inboxIds: ['ib-wa-cairo', 'ib-ig'],
    presence: 'online',
    openLoad: 12,
  },
  {
    id: 'm-mariam',
    name: 'مريم السيد',
    nameEn: 'Mariam Elsayed',
    role: 'agent',
    teamIds: ['t-orders'],
    inboxIds: ['ib-wa-orders'],
    presence: 'online',
    openLoad: 9,
  },
  {
    id: 'm-yara',
    name: 'يارا فؤاد',
    nameEn: 'Yara Fouad',
    role: 'agent',
    teamIds: ['t-care', 't-vip'],
    inboxIds: ['ib-wa-cairo', 'ib-mg'],
    presence: 'away',
    openLoad: 4,
  },
  {
    id: 'm-basel',
    name: 'باسل درويش',
    nameEn: 'Basel Darwish',
    role: 'agent',
    teamIds: ['t-orders'],
    inboxIds: ['ib-wa-orders', 'ib-ig'],
    presence: 'offline',
    openLoad: 0,
  },
  {
    id: 'm-dina',
    name: 'دينا مصطفى',
    nameEn: 'Dina Mostafa',
    role: 'admin',
    teamIds: ['t-care', 't-orders', 't-vip'],
    inboxIds: ['ib-wa-cairo', 'ib-wa-orders', 'ib-ig', 'ib-mg'],
    presence: 'online',
    openLoad: 2,
  },
  {
    id: 'm-omar',
    name: 'عمر الشاذلي',
    nameEn: 'Omar Elshazly',
    role: 'campaign_manager',
    teamIds: ['t-care'],
    inboxIds: [],
    presence: 'online',
    openLoad: 0,
  },
];

export const LABELS: readonly LabelRef[] = [
  { id: 'lb-refund', name: 'مدفوعات', nameEn: 'Payment', tone: 'warning' },
  { id: 'lb-delivery', name: 'تفعيل متأخر', nameEn: 'Activation delay', tone: 'danger' },
  { id: 'lb-vip', name: 'متدرب مميّز', nameEn: 'VIP learner', tone: 'accent' },
  { id: 'lb-sizing', name: 'اختيار المسار', nameEn: 'Track selection', tone: 'neutral' },
  { id: 'lb-invoice', name: 'فاتورة ضريبية', nameEn: 'Tax invoice', tone: 'neutral' },
  { id: 'lb-praise', name: 'رأي إيجابي', nameEn: 'Praise', tone: 'success' },
  { id: 'lb-wholesale', name: 'تدريب شركات', nameEn: 'Corporate training', tone: 'accent' },
];

export const VIEWS: readonly SavedView[] = [
  {
    id: 'v-sla',
    name: 'خطر تجاوز الـ SLA',
    nameEn: 'SLA at risk',
    scope: 'team',
    criteria: { slas: ['breached', 'due'], statuses: ['open', 'pending'], sort: 'sla' },
  },
  {
    id: 'v-vip',
    name: 'متدربون مميّزون بانتظار الرد',
    nameEn: 'VIP learners waiting',
    scope: 'workspace',
    criteria: { labels: ['lb-vip'], statuses: ['open', 'pending'], sort: 'priority' },
  },
  {
    id: 'v-refunds',
    name: 'مدفوعات معلّقة',
    nameEn: 'Pending payments',
    scope: 'private',
    criteria: { labels: ['lb-refund'], statuses: ['open', 'pending'] },
  },
  {
    id: 'v-instagram',
    name: 'إنستجرام اليوم',
    nameEn: 'Instagram today',
    scope: 'private',
    criteria: { channels: ['instagram'], sort: 'recent' },
  },
];

export const PERMISSION_KEYS: readonly string[] = [
  'conversation.read',
  'conversation.unassigned.preview',
  'conversation.reply',
  'conversation.note',
  'conversation.claim',
  'conversation.assign',
  'conversation.close',
  'contact.read',
  'consent.read',
  'consent.record',
  'campaign.draft',
  'campaign.launch',
  'channel.manage',
  'member.manage',
  'role.manage',
  'report.read',
];

function buildContacts(now: Date): readonly Contact[] {
  return [
    {
      id: 'ct-mariam',
      name: 'مريم خالد عبد الجواد',
      phone: '+20 100 234 8190',
      email: 'mariam.khaled@example.com',
      handle: null,
      locale: 'ar-EG',
      city: 'القاهرة الجديدة',
      cityEn: 'New Cairo',
      attributes: [
        { label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48127' },
        { label: 'قيمة الاشتراك', labelEn: 'Enrollment value', value: '2,480.00 EGP' },
        { label: 'الكورس', labelEn: 'Course', value: 'AI Automation Diploma · Cohort 12' },
        { label: 'أول تواصل', labelEn: 'First contact', value: '2025-11-04' },
      ],
      consent: [
        { channel: 'whatsapp', state: 'granted', source: 'نموذج التسجيل على الموقع', sourceEn: 'Website enrollment form', recordedAt: ago(now, 60 * 24 * 128) },
      ],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/8841', stage: 'عميل متكرر', stageEn: 'Returning customer', syncedAt: ago(now, 46) },
      history: [
        { id: 'h-1', title: 'استفسار عن المسار المناسب', titleEn: 'Track recommendation', at: ago(now, 60 * 24 * 21), outcome: 'محلولة', outcomeEn: 'Resolved' },
        { id: 'h-2', title: 'تسوية دفعة — ENR-2026-41003', titleEn: 'Payment adjustment — ENR-2026-41003', at: ago(now, 60 * 24 * 58), outcome: 'محلولة', outcomeEn: 'Resolved' },
      ],
    },
    {
      id: 'ct-omar',
      name: 'عمر شريف',
      phone: null,
      email: null,
      handle: '@omar.sh',
      locale: 'ar-EG',
      city: 'الإسكندرية',
      cityEn: 'Alexandria',
      attributes: [
        { label: 'متابع منذ', labelEn: 'Following since', value: '2024' },
        { label: 'آخر تسجيل', labelEn: 'Last enrollment', value: 'ENR-2026-47788' },
      ],
      consent: [{ channel: 'instagram', state: 'none', source: '—', sourceEn: '—', recordedAt: ago(now, 60 * 24 * 3) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [{ id: 'h-3', title: 'شكوى تغليف', titleEn: 'Packaging complaint', at: ago(now, 60 * 24 * 9), outcome: 'محلولة', outcomeEn: 'Resolved' }],
    },
    {
      id: 'ct-salma',
      name: 'سلمى حسن',
      phone: '+20 122 908 4417',
      email: 'salma.hassan@example.com',
      handle: 'salma.hassan.7',
      locale: 'ar-EG',
      city: 'المعادي',
      cityEn: 'Maadi',
      attributes: [
        { label: 'رقم العضوية', labelEn: 'Membership number', value: 'NL-000-8842' },
        { label: 'الموعد المفضل', labelEn: 'Preferred schedule', value: 'المجموعة المسائية' },
      ],
      consent: [{ channel: 'messenger', state: 'granted', source: 'زر المراسلة على الصفحة', sourceEn: 'Page message button', recordedAt: ago(now, 60 * 24 * 14) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/9120', stage: 'عميل جديد', stageEn: 'New customer', syncedAt: ago(now, 60 * 8) },
      history: [],
    },
    {
      id: 'ct-youssef',
      name: 'يوسف عادل منصور',
      phone: '+20 127 781 4300',
      email: 'youssef.adel@example.com',
      handle: null,
      locale: 'ar-EG',
      city: 'طنطا',
      cityEn: 'Tanta',
      attributes: [
        { label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-47990' },
        { label: 'طريقة الدفع', labelEn: 'Payment method', value: 'الدفع عند الاستلام' },
      ],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'رسالة عميل واردة', sourceEn: 'Inbound customer message', recordedAt: ago(now, 60 * 24 * 6) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/7733', stage: 'عميل متكرر', stageEn: 'Returning customer', syncedAt: ago(now, 60 * 30) },
      history: [{ id: 'h-4', title: 'تأكيد استلام', titleEn: 'Delivery confirmation', at: ago(now, 60 * 24 * 2), outcome: 'محلولة', outcomeEn: 'Resolved' }],
    },
    {
      id: 'ct-nour',
      name: 'نور أحمد',
      phone: null,
      email: 'nour.ahmed@example.com',
      handle: '@nour.ahmed',
      locale: 'ar-EG',
      city: 'الجيزة',
      cityEn: 'Giza',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48210' }],
      consent: [{ channel: 'instagram', state: 'none', source: '—', sourceEn: '—', recordedAt: ago(now, 60 * 5) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-karim',
      name: 'كريم محمود',
      phone: '+20 111 902 3166',
      email: 'karim.mahmoud@example.com',
      handle: null,
      locale: 'ar-EG',
      city: 'المنصورة',
      cityEn: 'Mansoura',
      attributes: [
        { label: 'الرقم الضريبي', labelEn: 'Tax number', value: '540-882-119' },
        { label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48044' },
      ],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'نموذج التسجيل على الموقع', sourceEn: 'Website enrollment form', recordedAt: ago(now, 60 * 24 * 40) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/6612', stage: 'شركة', stageEn: 'Business account', syncedAt: ago(now, 60 * 72) },
      history: [{ id: 'h-5', title: 'طلب فاتورة ضريبية', titleEn: 'Tax invoice request', at: ago(now, 60 * 24 * 33), outcome: 'محلولة', outcomeEn: 'Resolved' }],
    },
    {
      id: 'ct-lina',
      name: 'Lina Haddad',
      phone: '+961 3 447 219',
      email: 'lina.haddad@example.com',
      handle: null,
      locale: 'en-GB',
      city: 'Beirut',
      cityEn: 'Beirut',
      attributes: [
        { label: 'Order', labelEn: 'Order', value: 'ENR-2026-48155' },
        { label: 'Shipping', labelEn: 'Shipping', value: 'International — DHL' },
      ],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'Website enrollment form', sourceEn: 'Website enrollment form', recordedAt: ago(now, 60 * 24 * 11) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/9911', stage: 'New customer', stageEn: 'New customer', syncedAt: ago(now, 60 * 3) },
      history: [],
    },
    {
      id: 'ct-hoda',
      name: 'هدى الشناوي',
      phone: '+20 106 771 5522',
      email: null,
      handle: null,
      locale: 'ar-EG',
      city: 'بورسعيد',
      cityEn: 'Port Said',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-46801' }],
      consent: [{ channel: 'whatsapp', state: 'withdrawn', source: 'رسالة "إلغاء" من العميل', sourceEn: 'Customer sent “stop”', recordedAt: ago(now, 60 * 24 * 4) }],
      suppression: { active: true, reason: 'طلب إيقاف التسويق (كلمة "إلغاء")', reasonEn: 'Marketing opt-out (keyword “stop”)', at: ago(now, 60 * 24 * 4) },
      crm: { system: 'Odoo', reference: 'res.partner/5540', stage: 'عميل سابق', stageEn: 'Former customer', syncedAt: ago(now, 60 * 96) },
      history: [{ id: 'h-6', title: 'شكوى تأخير', titleEn: 'Activation delay complaint', at: ago(now, 60 * 24 * 12), outcome: 'محلولة', outcomeEn: 'Resolved' }],
    },
    {
      id: 'ct-ahmed',
      name: 'أحمد بدر الدين',
      phone: '+20 128 330 9977',
      email: 'ahmed.badr@example.com',
      handle: null,
      locale: 'ar-EG',
      city: 'أسيوط',
      cityEn: 'Asyut',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48233' }],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'رسالة عميل واردة', sourceEn: 'Inbound customer message', recordedAt: ago(now, 60 * 26) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-rana',
      name: 'رنا عبد اللطيف',
      phone: '+20 155 620 8811',
      email: null,
      handle: '@rana.style',
      locale: 'ar-EG',
      city: 'الشيخ زايد',
      cityEn: 'Sheikh Zayed',
      attributes: [{ label: 'اهتمام', labelEn: 'Interest', value: 'تدريب شركة — 40 موظفًا' }],
      consent: [{ channel: 'instagram', state: 'none', source: '—', sourceEn: '—', recordedAt: ago(now, 60 * 2) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-fady',
      name: 'فادي جرجس',
      phone: '+20 109 118 4477',
      email: 'fady.gerges@example.com',
      handle: null,
      locale: 'ar-EG',
      city: 'حلوان',
      cityEn: 'Helwan',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-47612' }],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'نموذج التسجيل على الموقع', sourceEn: 'Website enrollment form', recordedAt: ago(now, 60 * 24 * 20) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: { system: 'Odoo', reference: 'res.partner/8102', stage: 'عميل متكرر', stageEn: 'Returning customer', syncedAt: ago(now, 60 * 12) },
      history: [{ id: 'h-7', title: 'تغيير المسار', titleEn: 'Track change', at: ago(now, 60 * 24 * 30), outcome: 'محلولة', outcomeEn: 'Resolved' }],
    },
    {
      id: 'ct-sara',
      name: 'سارة العطار',
      phone: '+20 120 447 3390',
      email: null,
      handle: null,
      locale: 'ar-EG',
      city: 'الإسماعيلية',
      cityEn: 'Ismailia',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48190' }],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'رسالة عميل واردة', sourceEn: 'Inbound customer message', recordedAt: ago(now, 60 * 40) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-marwan',
      name: 'مروان الجندي',
      phone: '+20 101 556 2200',
      email: null,
      handle: 'marwan.elgendy',
      locale: 'ar-EG',
      city: 'الرحاب',
      cityEn: 'Al Rehab',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48001' }],
      consent: [{ channel: 'messenger', state: 'granted', source: 'زر المراسلة على الصفحة', sourceEn: 'Page message button', recordedAt: ago(now, 60 * 24 * 9) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-jana',
      name: 'جنى عمرو',
      phone: '+20 114 880 6633',
      email: null,
      handle: null,
      locale: 'ar-EG',
      city: 'مدينة نصر',
      cityEn: 'Nasr City',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-48244' }],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'رسالة عميل واردة', sourceEn: 'Inbound customer message', recordedAt: ago(now, 90) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-tamer',
      name: 'تامر عبد العزيز',
      phone: '+20 102 774 1188',
      email: null,
      handle: null,
      locale: 'ar-EG',
      city: 'الفيوم',
      cityEn: 'Fayoum',
      attributes: [{ label: 'رقم التسجيل', labelEn: 'Enrollment ID', value: 'ENR-2026-47455' }],
      consent: [{ channel: 'whatsapp', state: 'granted', source: 'نموذج التسجيل على الموقع', sourceEn: 'Website enrollment form', recordedAt: ago(now, 60 * 24 * 55) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
    {
      id: 'ct-heba',
      name: 'هبة سليمان',
      phone: null,
      email: null,
      handle: '@heba.suliman',
      locale: 'ar-EG',
      city: 'دمياط',
      cityEn: 'Damietta',
      attributes: [{ label: 'اهتمام', labelEn: 'Interest', value: 'مجموعة الشتاء' }],
      consent: [{ channel: 'instagram', state: 'none', source: '—', sourceEn: '—', recordedAt: ago(now, 60 * 6) }],
      suppression: { active: false, reason: null, reasonEn: null, at: null },
      crm: null,
      history: [],
    },
  ];
}

interface ConversationSeed {
  readonly id: string;
  readonly reference: string;
  readonly contactId: string;
  readonly inboxId: string;
  readonly assigneeId: string | null;
  readonly status: ConversationStatus;
  readonly priority: Priority;
  readonly sla: SlaState;
  readonly labels: readonly string[];
  readonly unreadCount: number;
  readonly lastActivityMinutes: number;
  readonly openedMinutes: number;
  readonly waitingMinutes: number;
  readonly snippet: string;
  readonly snippetDirection: 'in' | 'out';
  /** Minutes remaining in the provider window; `null` when the channel has none. */
  readonly windowMinutes: number | null;
  readonly snoozedMinutes?: number;
  readonly episode: number;
}

const CONVERSATION_SEEDS: readonly ConversationSeed[] = [
  {
    id: 'cv-4821',
    reference: 'CV-4821',
    contactId: 'ct-mariam',
    inboxId: 'ib-wa-orders',
    assigneeId: CURRENT_MEMBER_ID,
    status: 'open',
    priority: 'urgent',
    sla: 'breached',
    labels: ['lb-delivery', 'lb-vip'],
    unreadCount: 3,
    lastActivityMinutes: 4,
    openedMinutes: 210,
    waitingMinutes: 41,
    snippet: 'دفعت الاشتراك من 3 أيام ولسه حساب الكورس ما اتفعّلش. المحاضرة النهارده، ممكن حل؟',
    snippetDirection: 'in',
    windowMinutes: 21 * 60,
    episode: 2,
  },
  {
    id: 'cv-4820',
    reference: 'CV-4820',
    contactId: 'ct-lina',
    inboxId: 'ib-wa-cairo',
    assigneeId: CURRENT_MEMBER_ID,
    status: 'open',
    priority: 'high',
    sla: 'due',
    labels: ['lb-refund'],
    unreadCount: 1,
    lastActivityMinutes: 12,
    openedMinutes: 95,
    waitingMinutes: 12,
    snippet: 'Could you confirm the payment reference so I can complete my enrollment?',
    snippetDirection: 'in',
    windowMinutes: 23 * 60,
    episode: 1,
  },
  {
    id: 'cv-4819',
    reference: 'CV-4819',
    contactId: 'ct-nour',
    inboxId: 'ib-ig',
    assigneeId: 'm-tarek',
    status: 'open',
    priority: 'normal',
    sla: 'healthy',
    labels: ['lb-sizing'],
    unreadCount: 0,
    lastActivityMinutes: 18,
    openedMinutes: 70,
    waitingMinutes: 0,
    snippet: 'تمام، هبعتلك خبرتي الحالية عشان ترشحولي المسار المناسب.',
    snippetDirection: 'out',
    windowMinutes: 22 * 60,
    episode: 1,
  },
  {
    id: 'cv-4818',
    reference: 'CV-4818',
    contactId: 'ct-rana',
    inboxId: 'ib-ig',
    assigneeId: null,
    status: 'open',
    priority: 'high',
    sla: 'due',
    labels: ['lb-wholesale'],
    unreadCount: 2,
    lastActivityMinutes: 23,
    openedMinutes: 23,
    waitingMinutes: 23,
    snippet: 'محتاجين عرض تدريب AI لـ 40 موظف وفاتورة باسم الشركة.',
    snippetDirection: 'in',
    windowMinutes: 23 * 60,
    episode: 1,
  },
  {
    id: 'cv-4817',
    reference: 'CV-4817',
    contactId: 'ct-ahmed',
    inboxId: 'ib-wa-orders',
    assigneeId: null,
    status: 'open',
    priority: 'urgent',
    sla: 'breached',
    labels: ['lb-delivery'],
    unreadCount: 4,
    lastActivityMinutes: 31,
    openedMinutes: 260,
    waitingMinutes: 61,
    snippet: 'الكورس اتفعّل بس المحاضرة الثالثة مش ظاهرة عندي.',
    snippetDirection: 'in',
    windowMinutes: 19 * 60,
    episode: 1,
  },
  {
    id: 'cv-4816',
    reference: 'CV-4816',
    contactId: 'ct-salma',
    inboxId: 'ib-mg',
    assigneeId: 'm-yara',
    status: 'pending',
    priority: 'normal',
    sla: 'healthy',
    labels: [],
    unreadCount: 0,
    lastActivityMinutes: 44,
    openedMinutes: 300,
    waitingMinutes: 0,
    snippet: 'بانتظار رد المتدرب على مواعيد المجموعة المناسبة.',
    snippetDirection: 'out',
    windowMinutes: 20 * 60,
    episode: 1,
  },
  {
    id: 'cv-4815',
    reference: 'CV-4815',
    contactId: 'ct-karim',
    inboxId: 'ib-wa-cairo',
    assigneeId: 'm-tarek',
    status: 'open',
    priority: 'normal',
    sla: 'healthy',
    labels: ['lb-invoice'],
    unreadCount: 1,
    lastActivityMinutes: 58,
    openedMinutes: 120,
    waitingMinutes: 58,
    snippet: 'الرقم الضريبي 540-882-119، ابعتوا الفاتورة على الإيميل لو سمحتم.',
    snippetDirection: 'in',
    windowMinutes: 22 * 60,
    episode: 1,
  },
  {
    id: 'cv-4814',
    reference: 'CV-4814',
    contactId: 'ct-jana',
    inboxId: 'ib-wa-orders',
    assigneeId: null,
    status: 'open',
    priority: 'normal',
    sla: 'healthy',
    labels: [],
    unreadCount: 1,
    lastActivityMinutes: 66,
    openedMinutes: 66,
    waitingMinutes: 66,
    snippet: 'ممكن أغيّر البريد المسجل قبل بداية الكورس؟',
    snippetDirection: 'in',
    windowMinutes: 22 * 60,
    episode: 1,
  },
  {
    id: 'cv-4813',
    reference: 'CV-4813',
    contactId: 'ct-fady',
    inboxId: 'ib-wa-cairo',
    assigneeId: 'm-mariam',
    status: 'snoozed',
    priority: 'low',
    sla: 'none',
    labels: ['lb-sizing'],
    unreadCount: 0,
    lastActivityMinutes: 180,
    openedMinutes: 620,
    waitingMinutes: 0,
    snippet: 'مؤجلة حتى فتح المجموعة المسائية الجديدة.',
    snippetDirection: 'out',
    windowMinutes: 18 * 60,
    snoozedMinutes: 60 * 20,
    episode: 1,
  },
  {
    id: 'cv-4812',
    reference: 'CV-4812',
    contactId: 'ct-marwan',
    inboxId: 'ib-mg',
    assigneeId: CURRENT_MEMBER_ID,
    status: 'open',
    priority: 'high',
    sla: 'due',
    labels: ['lb-vip'],
    unreadCount: 0,
    lastActivityMinutes: 96,
    openedMinutes: 200,
    waitingMinutes: 25,
    snippet: 'اتفقنا ننقله لمسار الـAdvanced، هبعتله خطوات التحويل.',
    snippetDirection: 'out',
    windowMinutes: 16 * 60,
    episode: 1,
  },
  {
    id: 'cv-4811',
    reference: 'CV-4811',
    contactId: 'ct-sara',
    inboxId: 'ib-wa-orders',
    assigneeId: 'm-mariam',
    status: 'open',
    priority: 'normal',
    sla: 'healthy',
    labels: [],
    unreadCount: 0,
    lastActivityMinutes: 140,
    openedMinutes: 260,
    waitingMinutes: 0,
    snippet: 'تم تأكيد موعد الـLive Session يوم الخميس.',
    snippetDirection: 'out',
    windowMinutes: 21 * 60,
    episode: 1,
  },
  {
    id: 'cv-4810',
    reference: 'CV-4810',
    contactId: 'ct-heba',
    inboxId: 'ib-ig',
    assigneeId: null,
    status: 'open',
    priority: 'low',
    sla: 'healthy',
    labels: [],
    unreadCount: 1,
    lastActivityMinutes: 175,
    openedMinutes: 175,
    waitingMinutes: 175,
    snippet: 'كورس الـAI Automation الجديد بدأ الحجز؟',
    snippetDirection: 'in',
    windowMinutes: 21 * 60,
    episode: 1,
  },
  {
    id: 'cv-4809',
    reference: 'CV-4809',
    contactId: 'ct-hoda',
    inboxId: 'ib-wa-cairo',
    assigneeId: 'm-yara',
    status: 'open',
    priority: 'high',
    sla: 'due',
    labels: ['lb-refund'],
    unreadCount: 0,
    lastActivityMinutes: 1_700,
    openedMinutes: 2_000,
    waitingMinutes: 90,
    snippet: 'تم تسجيل مراجعة الدفع، بانتظار تأكيد المالية.',
    snippetDirection: 'out',
    windowMinutes: -30,
    episode: 1,
  },
  {
    id: 'cv-4808',
    reference: 'CV-4808',
    contactId: 'ct-youssef',
    inboxId: 'ib-wa-orders',
    assigneeId: CURRENT_MEMBER_ID,
    status: 'resolved',
    priority: 'normal',
    sla: 'none',
    labels: ['lb-praise'],
    unreadCount: 0,
    lastActivityMinutes: 2_600,
    openedMinutes: 3_100,
    waitingMinutes: 0,
    snippet: 'وصلتني الشهادة، شكرًا على المتابعة 🙏',
    snippetDirection: 'in',
    windowMinutes: null,
    episode: 1,
  },
  {
    id: 'cv-4807',
    reference: 'CV-4807',
    contactId: 'ct-tamer',
    inboxId: 'ib-wa-cairo',
    assigneeId: 'm-tarek',
    status: 'resolved',
    priority: 'low',
    sla: 'none',
    labels: [],
    unreadCount: 0,
    lastActivityMinutes: 4_100,
    openedMinutes: 4_400,
    waitingMinutes: 0,
    snippet: 'تمام، تم إلغاء التسجيل.',
    snippetDirection: 'out',
    windowMinutes: null,
    episode: 1,
  },
  {
    id: 'cv-4806',
    reference: 'CV-4806',
    contactId: 'ct-omar',
    inboxId: 'ib-ig',
    assigneeId: 'm-tarek',
    status: 'resolved',
    priority: 'normal',
    sla: 'none',
    labels: ['lb-praise'],
    unreadCount: 0,
    lastActivityMinutes: 5_300,
    openedMinutes: 5_800,
    waitingMinutes: 0,
    snippet: 'شكرًا جدًا، الخدمة ممتازة 👏',
    snippetDirection: 'in',
    windowMinutes: null,
    episode: 1,
  },
];

function buildConversations(now: Date): readonly ConversationRecord[] {
  return CONVERSATION_SEEDS.map((seed) => {
    const inbox = INBOXES.find((entry) => entry.id === seed.inboxId) as InboxRef;
    return {
      id: seed.id,
      reference: seed.reference,
      contactId: seed.contactId,
      inboxId: seed.inboxId,
      teamId: inbox.teamId,
      channel: inbox.channel,
      assigneeId: seed.assigneeId,
      participantIds: seed.assigneeId === null ? [] : [seed.assigneeId],
      status: seed.status,
      priority: seed.priority,
      sla: seed.sla,
      labels: seed.labels,
      unreadCount: seed.unreadCount,
      lastActivityAt: ago(now, seed.lastActivityMinutes),
      openedAt: ago(now, seed.openedMinutes),
      waitingSinceAt: ago(now, seed.waitingMinutes),
      snippet: seed.snippet,
      snippetDirection: seed.snippetDirection,
      windowExpiresAt: seed.windowMinutes === null ? null : ahead(now, seed.windowMinutes),
      snoozedUntil: seed.snoozedMinutes === undefined ? null : ahead(now, seed.snoozedMinutes),
      episode: seed.episode,
    };
  });
}

function buildTimelines(now: Date): Record<string, readonly TimelineItem[]> {
  return {
    'cv-4821': [
      {
        kind: 'event',
        id: 'e-4821-1',
        text: 'أُعيد فتح المحادثة برسالة واردة — بدأت فترة قياس جديدة',
        at: ago(now, 214),
      },
      {
        kind: 'message',
        id: 'm-4821-1',
        direction: 'in',
        authorName: 'مريم خالد عبد الجواد',
        body: 'السلام عليكم، دفعت اشتراك AI Automation Diploma من 3 أيام ولسه الحساب ما اتفعّلش.',
        at: ago(now, 212),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4821-2',
        direction: 'out',
        authorName: 'هناء عبد الرحمن',
        body: 'وعليكم السلام أ. مريم 🙏 بعتذر جدًا عن التأخير. براجع عملية الدفع وتفعيل حسابك مع فريق التسجيل وأرجعلك خلال دقائق.',
        at: ago(now, 205),
        delivery: 'read',
      },
      {
        kind: 'note',
        id: 'n-4821-1',
        authorName: 'هناء عبد الرحمن',
        body: 'ملاحظة داخلية: الدفع ظاهر ناجح على البوابة لكن الـwebhook لم يصل. لو لم يتفعّل خلال 15 دقيقة نصعّد للتقني ونرسل رابط دخول مؤقت.',
        at: ago(now, 203),
      },
      {
        kind: 'message',
        id: 'm-4821-3',
        direction: 'in',
        authorName: 'مريم خالد عبد الجواد',
        body: 'ده سكرين شوت من إيصال الدفع، العملية مكتوب عليها "ناجحة".',
        at: ago(now, 60),
        delivery: 'read',
        attachments: [{ name: 'payment-receipt.png', size: '248 KB', kind: 'image' }],
      },
      {
        kind: 'message',
        id: 'm-4821-4',
        direction: 'out',
        authorName: 'هناء عبد الرحمن',
        body: 'وصلني، شكرًا. راجعت العملية وفعّلت حسابك يدويًا. هيوصلك رابط الدخول على البريد والواتساب حالًا.',
        at: ago(now, 52),
        delivery: 'delivered',
      },
      {
        kind: 'event',
        id: 'e-4821-2',
        text: 'تم رفع الأولوية إلى «عاجلة» — تجاوز زمن الرد المستهدف',
        at: ago(now, 44),
      },
      {
        kind: 'message',
        id: 'm-4821-5',
        direction: 'in',
        authorName: 'مريم خالد عبد الجواد',
        body: 'دفعت الاشتراك من 3 أيام ولسه حساب الكورس ما اتفعّلش. المحاضرة النهارده، ممكن حل؟',
        at: ago(now, 4),
        delivery: 'delivered',
      },
    ],
    'cv-4820': [
      {
        kind: 'message',
        id: 'm-4820-1',
        direction: 'in',
        authorName: 'Lina Haddad',
        body: 'Hello — I paid for enrollment ENR-2026-48155, but the payment is not reflected on my account yet.',
        at: ago(now, 95),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4820-2',
        direction: 'out',
        authorName: 'هناء عبد الرحمن',
        body: 'Hi Lina — thanks for waiting. We found the payment and linked it to your enrollment. I am confirming the reference now.',
        at: ago(now, 80),
        delivery: 'read',
      },
      {
        kind: 'note',
        id: 'n-4820-1',
        authorName: 'دينا مصطفى',
        body: 'Finance confirmed the payout batch on Tuesday. Provider reference is not exposed to us yet — do not promise a date.',
        at: ago(now, 74),
      },
      {
        kind: 'message',
        id: 'm-4820-3',
        direction: 'in',
        authorName: 'Lina Haddad',
        body: 'Could you confirm the payment reference so I can complete my enrollment?',
        at: ago(now, 12),
        delivery: 'delivered',
      },
    ],
    'cv-4819': [
      {
        kind: 'message',
        id: 'm-4819-1',
        direction: 'in',
        authorName: 'نور أحمد',
        body: 'أنا مبتدئة في الـAI، أبدأ بالـFoundation ولا AI Automation؟',
        at: ago(now, 70),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4819-2',
        direction: 'out',
        authorName: 'طارق منير',
        body: 'أهلًا نور 👋 حسب خبرتك الحالية، مسار الـFoundation هيكون أنسب كبداية.',
        at: ago(now, 40),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4819-3',
        direction: 'out',
        authorName: 'طارق منير',
        body: 'تمام، هبعتلك خبرتي الحالية عشان ترشحولي المسار المناسب.',
        at: ago(now, 18),
        delivery: 'delivered',
      },
    ],
    'cv-4818': [
      {
        kind: 'message',
        id: 'm-4818-1',
        direction: 'in',
        authorName: 'رنا عبد اللطيف',
        body: 'مساء الخير، بنشتغل بوتيك في الشيخ زايد.',
        at: ago(now, 24),
        delivery: 'delivered',
      },
      {
        kind: 'message',
        id: 'm-4818-2',
        direction: 'in',
        authorName: 'رنا عبد اللطيف',
        body: 'محتاجين عرض تدريب AI لـ 40 موظف وفاتورة باسم الشركة.',
        at: ago(now, 23),
        delivery: 'delivered',
      },
    ],
    'cv-4817': [
      {
        kind: 'message',
        id: 'm-4817-1',
        direction: 'in',
        authorName: 'أحمد بدر الدين',
        body: 'الكورس اتفعّل بس المحاضرة الثالثة مش ظاهرة عندي.',
        at: ago(now, 31),
        delivery: 'delivered',
      },
    ],
    'cv-4816': [
      {
        kind: 'message',
        id: 'm-4816-1',
        direction: 'in',
        authorName: 'سلمى حسن',
        body: 'هل فيه مجموعة مسائية للكورس؟',
        at: ago(now, 300),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4816-2',
        direction: 'out',
        authorName: 'يارا فؤاد',
        body: 'متاح مجموعة مسائية أونلاين ومجموعة Weekend. تحبي أحجزلك أي موعد؟',
        at: ago(now, 250),
        delivery: 'read',
      },
      {
        kind: 'event',
        id: 'e-4816-1',
        text: 'تم التحويل إلى «بانتظار العميل» بواسطة يارا فؤاد',
        at: ago(now, 44),
      },
    ],
    'cv-4815': [
      {
        kind: 'message',
        id: 'm-4815-1',
        direction: 'in',
        authorName: 'كريم محمود',
        body: 'محتاج فاتورة ضريبية لتسجيل ENR-2026-48044.',
        at: ago(now, 120),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4815-2',
        direction: 'out',
        authorName: 'طارق منير',
        body: 'تمام أ. كريم، محتاج الرقم الضريبي واسم الشركة بالظبط.',
        at: ago(now, 100),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4815-3',
        direction: 'in',
        authorName: 'كريم محمود',
        body: 'الرقم الضريبي 540-882-119، ابعتوا الفاتورة على الإيميل لو سمحتم.',
        at: ago(now, 58),
        delivery: 'delivered',
      },
    ],
    'cv-4814': [
      {
        kind: 'message',
        id: 'm-4814-1',
        direction: 'in',
        authorName: 'جنى عمرو',
        body: 'ممكن أغيّر البريد المسجل قبل بداية الكورس؟',
        at: ago(now, 66),
        delivery: 'delivered',
      },
    ],
    'cv-4813': [
      {
        kind: 'message',
        id: 'm-4813-1',
        direction: 'in',
        authorName: 'فادي جرجس',
        body: 'المجموعة المسائية اكتملت؟ محتاج أنقل من المجموعة الصباحية.',
        at: ago(now, 620),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4813-2',
        direction: 'out',
        authorName: 'مريم السيد',
        body: 'المجموعة الحالية اكتملت، لكن هنفتح مجموعة مسائية جديدة خلال يومين. هأجّل المحادثة وأرجعلك فور فتحها.',
        at: ago(now, 600),
        delivery: 'read',
      },
      { kind: 'event', id: 'e-4813-1', text: 'تم التأجيل حتى الغد 08:00 بتوقيت القاهرة', at: ago(now, 180) },
    ],
    'cv-4812': [
      {
        kind: 'message',
        id: 'm-4812-1',
        direction: 'in',
        authorName: 'مروان الجندي',
        body: 'المحتوى الحالي أساسي بالنسبة لخبرتي، هل أقدر أنقل لمسار Advanced؟',
        at: ago(now, 200),
        delivery: 'read',
      },
      {
        kind: 'note',
        id: 'n-4812-1',
        authorName: 'هناء عبد الرحمن',
        body: 'متدرب مميّز — يُسمح بالترقية إلى Advanced دون رسوم إضافية.',
        at: ago(now, 150),
      },
      {
        kind: 'message',
        id: 'm-4812-2',
        direction: 'out',
        authorName: 'هناء عبد الرحمن',
        body: 'اتفقنا ننقلك لمسار الـAdvanced، هبعتلك خطوات التحويل.',
        at: ago(now, 96),
        delivery: 'read',
      },
    ],
    'cv-4811': [
      {
        kind: 'message',
        id: 'm-4811-1',
        direction: 'in',
        authorName: 'سارة العطار',
        body: 'الـLive Session الأولى هتكون إمتى؟',
        at: ago(now, 260),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4811-2',
        direction: 'out',
        authorName: 'مريم السيد',
        body: 'تم تأكيد موعد الـLive Session يوم الخميس.',
        at: ago(now, 140),
        delivery: 'read',
      },
    ],
    'cv-4810': [
      {
        kind: 'message',
        id: 'm-4810-1',
        direction: 'in',
        authorName: 'هبة سليمان',
        body: 'كورس الـAI Automation الجديد بدأ الحجز؟',
        at: ago(now, 175),
        delivery: 'delivered',
      },
    ],
    'cv-4809': [
      {
        kind: 'message',
        id: 'm-4809-1',
        direction: 'in',
        authorName: 'هدى الشناوي',
        body: 'عايزة أراجع عملية الدفع لتسجيل ENR-2026-46801.',
        at: ago(now, 2_000),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4809-2',
        direction: 'out',
        authorName: 'يارا فؤاد',
        body: 'تم تسجيل مراجعة الدفع، بانتظار تأكيد المالية.',
        at: ago(now, 1_700),
        delivery: 'read',
      },
      {
        kind: 'event',
        id: 'e-4809-1',
        text: 'انتهت نافذة الرد على واتساب — الرد الحر لم يعد متاحًا',
        at: ago(now, 30),
      },
    ],
    'cv-4808': [
      {
        kind: 'message',
        id: 'm-4808-1',
        direction: 'out',
        authorName: 'هناء عبد الرحمن',
        body: 'تم إصدار شهادتك وإرسال رابط التحميل اليوم 🎓',
        at: ago(now, 3_100),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4808-2',
        direction: 'in',
        authorName: 'يوسف عادل منصور',
        body: 'وصلتني الشهادة، شكرًا على المتابعة 🙏',
        at: ago(now, 2_600),
        delivery: 'read',
      },
      { kind: 'event', id: 'e-4808-1', text: 'تم الحل — التصنيف: استلام الشهادة', at: ago(now, 2_590) },
    ],
    'cv-4807': [
      {
        kind: 'message',
        id: 'm-4807-1',
        direction: 'in',
        authorName: 'تامر عبد العزيز',
        body: 'ألغيت التسجيل، شكرًا.',
        at: ago(now, 4_400),
        delivery: 'read',
      },
      {
        kind: 'message',
        id: 'm-4807-2',
        direction: 'out',
        authorName: 'طارق منير',
        body: 'تمام، تم إغلاق طلب إلغاء التسجيل.',
        at: ago(now, 4_100),
        delivery: 'read',
      },
      { kind: 'event', id: 'e-4807-1', text: 'تم الحل — التصنيف: إلغاء تسجيل', at: ago(now, 4_090) },
    ],
    'cv-4806': [
      {
        kind: 'message',
        id: 'm-4806-1',
        direction: 'in',
        authorName: 'عمر شريف',
        body: 'شكرًا جدًا، الخدمة ممتازة 👏',
        at: ago(now, 5_300),
        delivery: 'read',
      },
      { kind: 'event', id: 'e-4806-1', text: 'تم الحل — التصنيف: رأي إيجابي', at: ago(now, 5_290) },
    ],
  };
}

function buildChannels(now: Date): readonly ChannelConnection[] {
  // Goes through the shared formatter so the Western-digit rule holds here too;
  // building an `Intl` instance locally is how a screen quietly reverts to
  // Arabic-Indic digits.
  const lastCheck = (lang: Lang): string =>
    dateFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(now.getTime() - 9 * MINUTE),
    );
  return [
    {
      id: 'cn-wa-1',
      kind: 'whatsapp',
      asset: '+20 15 5500 1200',
      label: 'واتساب — الخط الرئيسي',
      labelEn: 'WhatsApp — Main line',
      readiness: 'connected',
      inboxId: 'ib-wa-cairo',
      evidence: [
        { label: 'تفويض الأصل', labelEn: 'Asset authorization', done: true },
        { label: 'التحقق من الصلاحيات', labelEn: 'Grant verification', done: true },
        { label: 'التحقق من الاشتراك', labelEn: 'Subscription verification', done: true },
        { label: 'اختبار وارد', labelEn: 'Inbound test', done: true },
        { label: 'اختبار صادر', labelEn: 'Outbound test', done: true },
      ],
      windowHours: 24,
      note: `آخر فحص ${lastCheck('ar')}`,
      noteEn: `Last checked ${lastCheck('en')}`,
    },
    {
      id: 'cn-wa-2',
      kind: 'whatsapp',
      asset: '+20 15 5500 1288',
      label: 'واتساب — التسجيل',
      labelEn: 'WhatsApp — Enrollment',
      readiness: 'degraded',
      inboxId: 'ib-wa-orders',
      evidence: [
        { label: 'تفويض الأصل', labelEn: 'Asset authorization', done: true },
        { label: 'التحقق من الصلاحيات', labelEn: 'Grant verification', done: true },
        { label: 'التحقق من الاشتراك', labelEn: 'Subscription verification', done: true },
        { label: 'اختبار وارد', labelEn: 'Inbound test', done: true },
        { label: 'اختبار صادر', labelEn: 'Outbound test', done: false },
      ],
      windowHours: 24,
      note: 'اختبار الإرسال الأخير رجع بخطأ مؤقت من المزوّد',
      noteEn: 'The last outbound test returned a transient provider error',
    },
    {
      id: 'cn-ig-1',
      kind: 'instagram',
      asset: '@noor.living',
      label: 'إنستجرام — حساب أعمال',
      labelEn: 'Instagram — Business account',
      readiness: 'connected',
      inboxId: 'ib-ig',
      evidence: [
        { label: 'تفويض الأصل', labelEn: 'Asset authorization', done: true },
        { label: 'التحقق من الصلاحيات', labelEn: 'Grant verification', done: true },
        { label: 'التحقق من الاشتراك', labelEn: 'Subscription verification', done: true },
        { label: 'اختبار وارد', labelEn: 'Inbound test', done: true },
        { label: 'اختبار صادر', labelEn: 'Outbound test', done: true },
      ],
      windowHours: 24,
      note: 'مسار Instagram Login — يبدأ العميل المحادثة دائمًا',
      noteEn: 'Instagram Login path — the customer always starts the conversation',
    },
    {
      id: 'cn-mg-1',
      kind: 'messenger',
      asset: 'Digital School',
      label: 'ماسنجر — Digital School',
      labelEn: 'Messenger — Digital School',
      readiness: 'reauthorization_required',
      inboxId: 'ib-mg',
      evidence: [
        { label: 'تفويض الأصل', labelEn: 'Asset authorization', done: true },
        { label: 'التحقق من الصلاحيات', labelEn: 'Grant verification', done: false },
        { label: 'التحقق من الاشتراك', labelEn: 'Subscription verification', done: false },
        { label: 'اختبار وارد', labelEn: 'Inbound test', done: true },
        { label: 'اختبار صادر', labelEn: 'Outbound test', done: false },
      ],
      windowHours: 24,
      note: 'انتهت صلاحية رمز الصفحة — يلزم إعادة التفويض من مالك الصفحة',
      noteEn: 'The Page token expired — the Page owner must re-authorize',
    },
    {
      id: 'cn-wa-3',
      kind: 'whatsapp',
      asset: '—',
      label: 'واتساب — تدريب الشركات (جديد)',
      labelEn: 'WhatsApp — Wholesale line (new)',
      readiness: 'not_configured',
      inboxId: null,
      evidence: [
        { label: 'تفويض الأصل', labelEn: 'Asset authorization', done: false },
        { label: 'التحقق من الصلاحيات', labelEn: 'Grant verification', done: false },
        { label: 'التحقق من الاشتراك', labelEn: 'Subscription verification', done: false },
        { label: 'اختبار وارد', labelEn: 'Inbound test', done: false },
        { label: 'اختبار صادر', labelEn: 'Outbound test', done: false },
      ],
      windowHours: 24,
      note: 'لم يبدأ الإعداد بعد',
      noteEn: 'Setup has not started',
    },
  ];
}

function buildCampaigns(now: Date): readonly Campaign[] {
  return [
    {
      id: 'cm-winter',
      name: 'إطلاق دبلومة AI Automation',
      nameEn: 'AI Automation Diploma launch',
      channel: 'whatsapp',
      state: 'dispatch_completed',
      approved: true,
      audienceSize: 4_120,
      snapshotAt: ago(now, 60 * 26),
      ledger: { accepted: 3_884, failed: 96, skipped: 118, unknown: 22, pending: 0 },
      templateRevision: 'ai_diploma_launch_ar · v4',
    },
    {
      id: 'cm-restock',
      name: 'تذكير الـLive Session',
      nameEn: 'Live session reminder',
      channel: 'whatsapp',
      state: 'running',
      approved: true,
      audienceSize: 860,
      snapshotAt: ago(now, 95),
      ledger: { accepted: 402, failed: 7, skipped: 31, unknown: 3, pending: 417 },
      templateRevision: 'live_session_reminder_ar · v2',
    },
    {
      id: 'cm-vip',
      name: 'دعوة Masterclass للخريجين',
      nameEn: 'Alumni masterclass invitation',
      channel: 'messenger',
      state: 'ready',
      approved: false,
      audienceSize: 214,
      snapshotAt: ago(now, 40),
      ledger: { accepted: 0, failed: 0, skipped: 0, unknown: 0, pending: 214 },
      templateRevision: 'alumni_masterclass_ar · v1',
    },
    {
      id: 'cm-survey',
      name: 'استبيان رضا بعد انتهاء الكورس',
      nameEn: 'Post-course satisfaction survey',
      channel: 'whatsapp',
      state: 'draft',
      approved: false,
      audienceSize: 0,
      snapshotAt: null,
      ledger: { accepted: 0, failed: 0, skipped: 0, unknown: 0, pending: 0 },
      templateRevision: '—',
    },
  ];
}

export function buildDataset(now: Date): Dataset {
  return {
    now,
    teams: TEAMS,
    inboxes: INBOXES,
    members: MEMBERS,
    labels: LABELS,
    views: VIEWS,
    contacts: buildContacts(now),
    conversations: buildConversations(now),
    timelines: buildTimelines(now),
    channels: buildChannels(now),
    campaigns: buildCampaigns(now),
  };
}
