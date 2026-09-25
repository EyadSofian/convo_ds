import type {
  CapabilityMatrix,
  ChannelCatalogueEntry,
  ChannelConnection,
  ChannelTestRecipient,
} from '../api/channels.js';
import type { ApiError } from '../api/client.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, relativeTime } from '../format.js';
import { icon } from '../icons.js';
import { channelTestIdentityField, channelTestLabelField, channelTokenField } from '../live/dispatch.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { channelTile } from './brand.js';
import { brandMark } from './channel-mark.js';
import { CHANNEL_NAMES, EVIDENCE, ERROR_CODES, phrase, READINESS, t } from './copy.js';
import type { Phrase } from './copy.js';
import {
  badge,
  button,
  emptyState,
  errorState,
  inlineError,
  isolated,
  LITERAL_INPUT,
  page,
  panel,
  refreshButton,
  segmented,
  skeleton,
  textInput,
  toolbar,
} from './parts.js';
import type { Tone } from './parts.js';

/**
 * Channels, as an integration catalogue backed entirely by the API.
 *
 * The catalogue is the product's list of integrations; what each one can do,
 * and whether this build can serve it at all, comes from the server. The
 * connected integrations beneath it are the company's own records. A channel is
 * never shown as connected because a token was pasted: "Connected" means the
 * server holds healthy evidence for it.
 */

export interface CatalogueItem {
  readonly kind: string;
  readonly name: Phrase;
  readonly description: Phrase;
  /** The provider-side identifier this kind is connected by. */
  readonly asset: Phrase;
  /** What a connection of this kind is attached to, as the card names it. */
  readonly assetLabel: Phrase;
  /** Whether the connection is made through a Meta app configured on the server. */
  readonly meta: boolean;
}

export const CATALOGUE: readonly CatalogueItem[] = [
  {
    kind: 'whatsapp',
    name: { ar: 'واتساب للأعمال', en: 'WhatsApp Business' },
    description: { ar: 'رد على العملاء وأرسل القوالب المعتمدة من رقم واتساب للأعمال.', en: 'Reply to customers and send approved templates from your business number.' },
    asset: { ar: 'Phone Number ID', en: 'Phone Number ID' },
    assetLabel: { ar: 'رقم واتساب للأعمال', en: 'WhatsApp Business number' },
    meta: true,
  },
  {
    kind: 'messenger',
    name: { ar: 'فيسبوك ماسنجر', en: 'Facebook Messenger' },
    description: { ar: 'استقبل رسائل صفحة فيسبوك وأجب عنها من صندوق الوارد.', en: 'Answer messages sent to your Facebook Page from the inbox.' },
    asset: { ar: 'Page ID', en: 'Page ID' },
    assetLabel: { ar: 'صفحة فيسبوك', en: 'Facebook Page' },
    meta: true,
  },
  {
    kind: 'instagram',
    name: { ar: 'رسائل إنستغرام', en: 'Instagram Direct' },
    description: { ar: 'تعامل مع الرسائل المباشرة لحساب إنستغرام الاحترافي.', en: 'Handle direct messages to your Instagram professional account.' },
    asset: { ar: 'Instagram Account ID', en: 'Instagram Account ID' },
    assetLabel: { ar: 'حساب إنستغرام احترافي', en: 'Instagram professional account' },
    meta: true,
  },
  {
    kind: 'web_chat',
    name: { ar: 'دردشة الموقع', en: 'Website Chat' },
    description: { ar: 'تحدث مع زوار موقعك عبر نافذة دردشة موقّعة من خادمك.', en: 'Chat with site visitors through a widget your installation signs.' },
    asset: { ar: 'معرّف النافذة', en: 'Widget ID' },
    assetLabel: { ar: 'نافذة الموقع', en: 'Website widget' },
    meta: false,
  },
  {
    kind: 'telegram',
    name: { ar: 'تيليجرام', en: 'Telegram' },
    description: { ar: 'محادثات عبر بوت تيليجرام.', en: 'Conversations through a Telegram bot.' },
    asset: { ar: 'اسم البوت', en: 'Bot username' },
    assetLabel: { ar: 'بوت تيليجرام', en: 'Telegram bot' },
    meta: false,
  },
  {
    kind: 'custom',
    name: { ar: 'قناة API مخصّصة', en: 'Custom API Channel' },
    description: { ar: 'اربط نظامك الخاص عبر تسليمات webhook موقّعة.', en: 'Connect your own system through signed webhook deliveries.' },
    asset: { ar: 'معرّف القناة', en: 'Channel ID' },
    assetLabel: { ar: 'نقطة الربط', en: 'Connected endpoint' },
    meta: false,
  },
];

export function catalogueItem(kind: string): CatalogueItem | undefined {
  return CATALOGUE.find((item) => item.kind === kind);
}

export type IntegrationStatus = 'connected' | 'connecting' | 'attention' | 'permission_expired' | 'disconnected' | 'not_connected' | 'unavailable';

export interface IntegrationSummary {
  readonly status: IntegrationStatus;
  readonly active: readonly ChannelConnection[];
  /** The newest instant a provider accepted a credential for this kind. */
  readonly lastVerified: string | null;
  /** Names are provider-supplied operator labels, never credentials or ids. */
  readonly assetNames: readonly string[];
}

/**
 * One kind's standing, from the connections the server returned.
 *
 * Attention wins over connected: one healthy WhatsApp number does not make a
 * second, broken one somebody else's problem.
 */
export function summarize(kind: string, implemented: boolean, connections: readonly ChannelConnection[]): IntegrationSummary {
  const ofKind = connections.filter((connection) => connection.kind === kind);
  const active = ofKind.filter((connection) => connection.disconnected_at === null);
  const lastVerified = ofKind
    .flatMap((connection) => connection.evidence)
    .filter((evidence) => evidence.kind === 'credential_verified' && evidence.satisfied && evidence.observed_at !== null)
    .map((evidence) => evidence.observed_at as string)
    .sort()
    .at(-1) ?? null;
  const permissionExpired = active.some((connection) => connection.last_error_code === 'credential_rejected');
  const connecting = active.some((connection) => connection.status === 'authorization_needed' || connection.status === 'webhook_pending');
  const status: IntegrationStatus = !implemented
    ? 'unavailable'
    : permissionExpired
      ? 'permission_expired'
      : active.some((connection) => connection.status === 'degraded')
        ? 'attention'
        : connecting
          ? 'connecting'
          : active.length > 0
            ? 'connected'
            : ofKind.length > 0
              ? 'disconnected'
              : 'not_connected';
  return { status, active, lastVerified, assetNames: active.map((connection) => connection.display_name) };
}

const STATUS_VIEW: Readonly<Record<IntegrationStatus, { readonly label: Phrase; readonly tone: Tone }>> = {
  connected: { label: { ar: 'متصلة', en: 'Connected' }, tone: 'success' },
  connecting: { label: { ar: 'جارٍ الربط', en: 'Connecting' }, tone: 'accent' },
  attention: { label: { ar: 'تحتاج إلى متابعة', en: 'Needs attention' }, tone: 'warning' },
  permission_expired: { label: { ar: 'انتهت الصلاحية', en: 'Permission expired' }, tone: 'danger' },
  disconnected: { label: { ar: 'مفصولة', en: 'Disconnected' }, tone: 'neutral' },
  not_connected: { label: { ar: 'غير متصلة', en: 'Not connected' }, tone: 'neutral' },
  unavailable: { label: { ar: 'غير متاح حاليًا', en: 'Coming soon' }, tone: 'neutral' },
};

const READINESS_TONE: Readonly<Record<string, Tone>> = {
  not_configured: 'neutral',
  authorization_needed: 'warning',
  webhook_pending: 'accent',
  healthy: 'success',
  degraded: 'danger',
  disconnected: 'neutral',
};

export function renderChannels(state: AppState): HTMLElement {
  const live = state.live;
  return page('channels', toolbar(
    t(state, 'اربط القنوات التي يتواصل عبرها عملاؤك. تظهر القناة «متصلة» فقط بعد أن يؤكد الخادم جاهزيتها.', 'Connect the channels your customers use. A channel shows as connected only after the server confirms it is healthy.'),
    [refreshButton(state, 'live-channels-reload', live.connections.status === 'loading')],
  ), catalogueBody(state, live));
}

function catalogueBody(state: AppState, live: LiveState): readonly Child[] {
  // Without the company's connections every card would read "Not connected",
  // which would be a claim rather than an absence of data.
  if (live.catalogue.status === 'error' || live.connections.status === 'error') {
    const error = live.catalogue.status === 'error' ? live.catalogue.error : (live.connections as { readonly error: ApiError }).error;
    return [errorState(state, error, 'live-channels-reload')];
  }
  if (live.catalogue.status !== 'ready' || live.connections.status === 'idle' || live.connections.status === 'loading') {
    return [h('div', { class: 'integration-grid' }, CATALOGUE.map(() => h('div', { class: 'integration integration--loading' }, [skeleton(state, 2)])))];
  }
  const server = live.catalogue.value;
  const connections = rowsOf(live.connections);
  return [
    h('section', { class: 'integrations', 'aria-labelledby': 'catalogue-title' }, [
      h('h2', { class: 'section-title', id: 'catalogue-title' }, [t(state, 'التكاملات المتاحة', 'Integrations')]),
      h('div', { class: 'integration-grid' }, CATALOGUE.map((item) => integrationCard(state, item, server.find((entry) => entry.kind === item.kind), connections))),
    ]),
    connectedSection(state, live, connections),
  ];
}

function integrationCard(
  state: AppState,
  item: CatalogueItem,
  entry: ChannelCatalogueEntry | undefined,
  connections: readonly ChannelConnection[],
): HTMLElement {
  const summary = summarize(item.kind, entry?.implemented === true, connections);
  const view = STATUS_VIEW[summary.status];
  const attention = summary.active.find((connection) => connection.status !== 'healthy');
  return h('article', { class: `integration integration--${summary.status}`, 'data-channel-kind': item.kind, 'aria-labelledby': `integration-${item.kind}` }, [
    h('header', { class: 'integration__head' }, [
      channelTile(item.kind, 'lg'),
      h('div', { class: 'integration__titles' }, [
        h('h3', { class: 'integration__name', id: `integration-${item.kind}` }, [t(state, item.name.ar, item.name.en)]),
        h('p', { class: 'integration__provider' }, [providerOf(item)]),
        badge(t(state, view.label.ar, view.label.en), view.tone, { dot: summary.status !== 'unavailable' }),
      ]),
    ]),
    h('p', { class: 'integration__description' }, [t(state, item.description.ar, item.description.en)]),
    entry === undefined || !entry.implemented
      ? h('p', { class: 'integration__note' }, [t(state, 'غير مدعومة في هذا الإصدار بعد.', 'Not supported in this version yet.')])
      : h('ul', { class: 'integration__capabilities', 'aria-label': t(state, 'الإمكانات', 'Capabilities') }, capabilities(state, entry.capabilities)),
    h('dl', { class: 'integration__facts' }, [
      h('div', { class: 'integration__fact' }, [
        h('dt', {}, [assetContext(state, item)]),
        h('dd', {}, [summary.assetNames.length === 0 ? t(state, 'لا يوجد بعد', 'None yet') : isolated(summary.assetNames.join(', '))]),
      ]),
      summary.lastVerified === null
        ? null
        : h('div', { class: 'integration__fact' }, [
            h('dt', {}, [t(state, 'آخر تحقق ناجح', 'Last verified')]),
            h('dd', {}, [relativeTime(summary.lastVerified, state.clock, state.lang)]),
          ]),
    ]),
    h('footer', { class: 'integration__actions' }, [primaryAction(state, item, summary.status, attention)]),
  ]);
}

/**
 * What a connection of this kind is attached to, in the provider's own terms.
 * Messenger connects through a Facebook Page, so the Page is named with
 * Facebook's mark as context; the channel itself stays Messenger.
 */
function assetContext(state: AppState, item: CatalogueItem): Child {
  const label = t(state, item.assetLabel.ar, item.assetLabel.en);
  if (item.kind !== 'messenger') return label;
  return h('span', { class: 'integration__context' }, [brandMark('facebook', 12), label]);
}

/** Who runs the channel: Meta's three products, Telegram, or this product itself. */
function providerOf(item: CatalogueItem): string {
  if (item.meta) return 'Meta';
  return item.kind === 'telegram' ? 'Telegram' : 'DS Omnichannel';
}

function primaryAction(
  state: AppState,
  item: CatalogueItem,
  status: IntegrationStatus,
  attention: ChannelConnection | undefined,
): HTMLElement {
  const name = t(state, item.name.ar, item.name.en);
  if (status === 'unavailable') {
    return button({ label: t(state, 'غير متاح حاليًا', 'Coming soon'), act: 'noop', small: true, disabled: true, title: t(state, `${name} غير متاح في هذا الإصدار`, `${name} is not available in this version`) });
  }
  // Another account can be added whatever state the first one is in: one
  // number waiting for verification is no reason to block a second.
  const another = button({ label: t(state, 'إضافة', 'Add'), icon: 'plus', act: 'dialog', arg: `connect-channel:${item.kind}`, small: true, variant: 'ghost', title: t(state, `ربط حساب ${name} آخر`, `Connect another ${name} account`) });
  if (status === 'attention' || status === 'connecting' || status === 'permission_expired') {
    return h('div', { class: 'integration__buttons' }, [
      button({ label: t(state, 'إكمال الإعداد', 'Complete setup'), icon: 'arrowOut', act: 'channel-manage', arg: `${item.kind}:${(attention as ChannelConnection).id}`, small: true, variant: 'primary', title: t(state, `إكمال إعداد ${name}`, `Complete ${name} setup`) }),
      another,
    ]);
  }
  if (status === 'connected') {
    return h('div', { class: 'integration__buttons' }, [
      button({ label: t(state, 'إدارة', 'Manage'), act: 'channel-manage', arg: `${item.kind}:`, small: true, title: t(state, `إدارة ${name}`, `Manage ${name}`) }),
      another,
    ]);
  }
  return button({ label: t(state, 'ربط', 'Connect'), icon: 'plug', act: 'dialog', arg: `connect-channel:${item.kind}`, small: true, variant: 'primary', title: t(state, `ربط ${name}`, `Connect ${name}`) });
}

/** Only what the server says the adapter supports. An unsupported capability is simply absent. */
function capabilities(state: AppState, matrix: CapabilityMatrix): readonly HTMLElement[] {
  const items: HTMLElement[] = [];
  const add = (supported: boolean, label: string): void => {
    if (supported) items.push(h('li', { class: 'capability' }, [label]));
  };
  add(matrix.outboundTypes.includes('text'), t(state, 'رسائل', 'Messages'));
  add(matrix.templates, t(state, 'قوالب', 'Templates'));
  add(matrix.attachmentTypes.length > 0, t(state, 'وسائط', 'Media'));
  add(matrix.deliveryReceipts || matrix.readReceipts, t(state, 'إيصالات', 'Receipts'));
  add(matrix.inboundEvents.length > 0, t(state, 'Webhooks', 'Webhooks'));
  return items;
}

/* ------------------------------------------------------- connected section -- */

function connectedSection(state: AppState, live: LiveState, connections: readonly ChannelConnection[]): HTMLElement {
  const kinds = [...new Set(connections.map((connection) => connection.kind))];
  const shown = state.channelKind === '' ? connections : connections.filter((connection) => connection.kind === state.channelKind);
  return panel(
    t(state, 'القنوات المتصلة', 'Connected integrations'),
    [
      state.dialog === null ? inlineError(state, live.error) : null,
      connections.length === 0
        ? emptyState({
            icon: 'plug',
            title: t(state, 'لا توجد قنوات متصلة بعد', 'No channels connected yet'),
            body: t(state, 'ابدأ بربط رقم واتساب للأعمال لاستقبال رسائل العملاء.', 'Start by connecting a WhatsApp Business number to receive customer messages.'),
            action: { label: t(state, 'ربط واتساب', 'Connect WhatsApp'), act: 'dialog', arg: 'connect-channel:whatsapp', primary: true },
          })
        : h('ul', { class: 'connection-list' }, shown.map((connection) => connectionRow(state, live, connection))),
    ],
    {
      extraClass: 'connections',
      flush: connections.length > 0,
      actions: kinds.length < 2 ? [] : [segmented(
        [{ value: '', label: t(state, 'الكل', 'All') }, ...kinds.map((kind) => ({ value: kind, label: phrase(state, CHANNEL_NAMES, kind) }))],
        state.channelKind,
        'channel-kind',
        t(state, 'تصفية حسب القناة', 'Filter by channel'),
      )],
    },
  );
}

function connectionRow(state: AppState, live: LiveState, connection: ChannelConnection): HTMLElement {
  const expanded = state.expandedConnection === connection.id;
  const gone = connection.disconnected_at !== null;
  const detailsId = `connection-details-${connection.id}`;
  const satisfied = connection.evidence.filter((item) => item.satisfied).length;
  return h('li', { class: `connection${expanded ? ' connection--expanded' : ''}`, 'data-connection': connection.id }, [
    h('div', { class: 'connection__row' }, [
      channelTile(connection.kind),
      h('div', { class: 'connection__identity' }, [
        h('p', { class: 'connection__name' }, [isolated(connection.display_name)]),
        h('p', { class: 'connection__meta' }, [
          phrase(state, CHANNEL_NAMES, connection.kind),
          ' · ',
          isolated(connection.external_asset_id, true),
        ]),
      ]),
      h('div', { class: 'connection__status' }, [
        badge(gone ? phrase(state, READINESS, 'disconnected') : phrase(state, READINESS, connection.status), gone ? 'neutral' : (READINESS_TONE[connection.status] ?? 'neutral'), { dot: true }),
        h('span', { class: 'connection__evidence' }, [
          t(state, `${String(satisfied)} من ${String(connection.evidence.length)} أدلة`, `${String(satisfied)} of ${String(connection.evidence.length)} checks`),
        ]),
      ]),
      button({
        label: expanded ? t(state, 'إخفاء', 'Hide') : t(state, 'التفاصيل', 'Details'),
        icon: expanded ? 'chevronDown' : 'chevronEnd',
        act: 'connection-toggle',
        arg: connection.id,
        small: true,
        variant: 'ghost',
        expanded,
        controls: detailsId,
      }),
    ]),
    expanded ? connectionDetails(state, live, connection, detailsId) : null,
  ]);
}

function connectionDetails(state: AppState, live: LiveState, connection: ChannelConnection, id: string): HTMLElement {
  const gone = connection.disconnected_at !== null;
  const tokenField = channelTokenField(connection.id);
  const token = state.dialogForm[tokenField] ?? '';
  return h('div', { class: 'connection__details', id }, [
    h('div', { class: 'connection__columns' }, [
      h('section', { class: 'connection__block', 'aria-labelledby': `${id}-evidence` }, [
        h('h3', { class: 'connection__blocktitle', id: `${id}-evidence` }, [t(state, 'التحقق من الجاهزية', 'Readiness checks')]),
        h('ul', { class: 'checklist' }, connection.evidence.map((item) =>
          h('li', { class: item.satisfied ? 'checklist__item checklist__item--done' : 'checklist__item' }, [
            h('span', { class: 'checklist__mark', 'aria-hidden': 'true' }, [icon(item.satisfied ? 'check' : 'clock', 14)]),
            h('span', { class: 'checklist__label' }, [phrase(state, EVIDENCE, item.kind)]),
            h('span', { class: 'checklist__when' }, [
              item.observed_at === null
                ? t(state, 'لم يتحقق', 'Pending')
                : dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.observed_at)),
            ]),
          ]),
        )),
        connection.last_error_code === null
          ? null
          : h('p', { class: 'connection__error', role: 'status' }, [
              icon('alert', 14),
              t(state, 'آخر خطأ: ', 'Last error: '),
              h('span', { class: 'connection__error-code' }, [isolated(connection.last_error_code, true)]),
              ' · ',
              phrase(state, ERROR_CODES, connection.last_error_code),
            ]),
      ]),
      h('section', { class: 'connection__block', 'aria-labelledby': `${id}-facts` }, [
        h('h3', { class: 'connection__blocktitle', id: `${id}-facts` }, [t(state, 'بيانات الاتصال', 'Connection')]),
        h('dl', { class: 'attrgrid' }, [
          h('dt', {}, [t(state, 'المعرّف لدى المزوّد', 'Provider asset')]),
          h('dd', {}, [isolated(connection.external_asset_id, true)]),
          connection.provider_app_id === null ? null : h('dt', {}, [t(state, 'تطبيق Meta', 'Meta app')]),
          connection.provider_app_id === null ? null : h('dd', {}, [isolated(connection.provider_app_id, true)]),
          h('dt', {}, [t(state, 'بيانات الاعتماد', 'Credential')]),
          h('dd', {}, [connection.credential_held ? t(state, 'محفوظة مشفّرة', 'Stored encrypted') : t(state, 'غير محفوظة', 'Not stored')]),
          h('dt', {}, [t(state, 'نافذة الرد', 'Reply window')]),
          h('dd', {}, [connection.capabilities.windowHours === null ? t(state, 'بلا نافذة', 'None') : t(state, `${String(connection.capabilities.windowHours)} ساعة`, `${String(connection.capabilities.windowHours)} hours`)]),
          h('dt', {}, [t(state, 'تاريخ الربط', 'Connected on')]),
          h('dd', {}, [dateFormat(state.lang, { dateStyle: 'medium' }).format(new Date(connection.created_at))]),
        ]),
      ]),
    ]),
    gone
      ? h('p', { class: 'field__hint' }, [t(state, 'هذا الاتصال مفصول. سجله محفوظ، ويمكن ربط الأصل من جديد.', 'This connection is disconnected. Its history is kept and the asset can be connected again.')])
      : h('div', { class: 'connection__manage' }, [
          h('div', { class: 'connection__actions' }, [
            connection.kind === 'whatsapp'
              ? button({
                  label: t(state, 'مزامنة قوالب واتساب', 'Sync WhatsApp templates'),
                  icon: 'refresh',
                  act: 'live-sync-channel-templates',
                  arg: connection.id,
                  small: true,
                  busy: live.busy === `sync-channel-templates:${connection.id}`,
                })
              : null,
            button({
              label: t(state, 'التحقق من الاتصال', 'Verify connection'),
              icon: 'shield',
              act: 'live-test-channel',
              arg: connection.id,
              small: true,
              busy: live.busy === `test-channel:${connection.id}`,
            }),
            // Confirmed first: disconnecting revokes the stored credential, and
            // reconnecting needs a new one from the provider.
            button({
              label: t(state, 'فصل القناة…', 'Disconnect…'),
              act: 'dialog',
              arg: `disconnect-channel:${connection.id}`,
              small: true,
              variant: 'danger',
            }),
          ]),
          h('form', { class: 'inline-form', 'data-submit': 'live-rotate-channel', 'data-arg': connection.id }, [
            h('label', { class: 'field' }, [
              h('span', { class: 'field__label' }, [t(state, 'استبدال بيانات الاعتماد', 'Replace credential')]),
              h('input', {
                class: 'input',
                type: 'password',
                autocomplete: 'off',
                ...LITERAL_INPUT,
                dir: 'ltr',
                placeholder: t(state, 'رمز وصول جديد', 'New access token'),
                value: token,
                'data-act': 'form-toggle',
                'data-form': tokenField,
              }),
            ]),
            button({
              label: t(state, 'حفظ', 'Save'),
              act: 'live-rotate-channel',
              arg: connection.id,
              small: true,
              busy: live.busy === `rotate-channel:${connection.id}`,
              disabled: token === '',
            }),
          ]),
          testRecipients(state, live, connection),
        ]),
  ]);
}

function testRecipients(state: AppState, live: LiveState, connection: ChannelConnection): HTMLElement {
  const identityField = channelTestIdentityField(connection.id);
  const labelField = channelTestLabelField(connection.id);
  const identity = state.dialogForm[identityField] ?? '';
  const label = state.dialogForm[labelField] ?? '';
  const recipients = rowsOf(live.testRecipients).filter((recipient) => recipient.connection_id === connection.id);
  return h('section', { class: 'connection__block', 'aria-labelledby': `test-recipients-${connection.id}` }, [
    h('h3', { class: 'connection__blocktitle', id: `test-recipients-${connection.id}` }, [t(state, 'مستلمو الاختبار', 'Test recipients')]),
    h('p', { class: 'field__hint' }, [t(state, 'الحملات التجريبية تصل فقط إلى هوية موجودة على هذه القناة وتم التصريح لها هنا.', 'Campaign tests reach only an existing identity on this channel that is authorized here.')]),
    recipients.length === 0
      ? null
      : h('ul', { class: 'recipient-list' }, recipients.map((recipient) => recipientRow(state, live, connection, recipient))),
    h('div', { class: 'inline-form' }, [
      textInput(identityField, identity, t(state, 'الرقم أو معرّف المزوّد', 'Number or provider ID'), { act: 'form-toggle', ariaLabel: t(state, 'هوية مستلم الاختبار', 'Test recipient identity') }),
      textInput(labelField, label, t(state, 'اسم للتعريف', 'Label'), { act: 'form-toggle', ariaLabel: t(state, 'اسم مستلم الاختبار', 'Test recipient label') }),
      button({
        label: t(state, 'تصريح', 'Authorize'),
        act: 'live-authorize-test-recipient',
        arg: connection.id,
        small: true,
        busy: live.busy === `authorize-test-recipient:${connection.id}`,
        disabled: identity === '' || label === '',
      }),
    ]),
  ]);
}

function recipientRow(state: AppState, live: LiveState, connection: ChannelConnection, recipient: ChannelTestRecipient): HTMLElement {
  return h('li', { class: 'recipient' }, [
    h('span', { class: 'recipient__label' }, [recipient.label]),
    isolated(recipient.peer_identity, true),
    button({
      label: t(state, 'إلغاء التصريح', 'Revoke'),
      act: 'live-revoke-test-recipient',
      arg: `${connection.id}:${recipient.id}`,
      small: true,
      variant: 'ghost',
      busy: live.busy === `revoke-test-recipient:${recipient.id}`,
    }),
  ]);
}
