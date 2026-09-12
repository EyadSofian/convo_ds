import type {
  CapabilityMatrix,
  ChannelCatalogueEntry,
  ChannelConnection,
  ChannelKind,
  ChannelReadiness,
} from '../api/channels.js';
import type { ApiError } from '../api/client.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { channelTokenField } from '../live/dispatch.js';
import { isDenial, isUnauthenticated, type LiveState, type Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { button, checkItem, isolated, pill, selectControl, stateBox } from './parts.js';
import type { Tone } from './parts.js';

/**
 * Channels, backed entirely by the API.
 *
 * The screen exists to tell one truth clearly: **a channel is not connected
 * because somebody pasted a token**. Each connection shows the five separate
 * pieces of evidence behind its state and which of them are still missing, so
 * "webhook_pending" reads as "waiting for the provider to deliver something"
 * rather than as a vague amber light.
 *
 * Nothing here talks to Meta. Every control calls a CONVO endpoint, and the
 * absence of a provider transport shows up as `provider_not_connected` on the
 * connection — a real state from the server, not a message this screen invents.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

const READINESS_TONE: Readonly<Record<ChannelReadiness, Tone>> = {
  not_configured: 'neutral',
  authorization_needed: 'warning',
  webhook_pending: 'accent',
  healthy: 'success',
  degraded: 'danger',
  disconnected: 'neutral',
};

function readinessLabel(state: AppState, readiness: ChannelReadiness): string {
  const labels: Record<ChannelReadiness, { ar: string; en: string }> = {
    not_configured: { ar: 'غير مهيّأة', en: 'Not configured' },
    authorization_needed: { ar: 'تحتاج تفويضًا', en: 'Authorization needed' },
    webhook_pending: { ar: 'بانتظار أول حدث', en: 'Waiting for the first event' },
    healthy: { ar: 'سليمة', en: 'Healthy' },
    degraded: { ar: 'متدهورة', en: 'Degraded' },
    disconnected: { ar: 'مفصولة', en: 'Disconnected' },
  };
  return t(state, labels[readiness].ar, labels[readiness].en);
}

function evidenceLabel(state: AppState, kind: string): string {
  const labels: Record<string, { ar: string; en: string }> = {
    asset_verified: { ar: 'الأصل مسجَّل', en: 'Asset registered' },
    credential_verified: { ar: 'المزوّد قبل الاعتماد', en: 'Provider accepted the credential' },
    webhook_subscribed: { ar: 'الاشتراك في الأحداث', en: 'Webhook subscribed' },
    first_inbound: { ar: 'وصلت رسالة واردة', en: 'An inbound message arrived' },
    first_outbound: { ar: 'قُبلت رسالة صادرة', en: 'An outbound message was accepted' },
  };
  const label = labels[kind];
  // An evidence kind this build does not recognise is shown by its own name
  // rather than hidden: a newer server naming one is information, not noise.
  return label === undefined ? kind : t(state, label.ar, label.en);
}

function kindLabel(state: AppState, kind: string): string {
  const labels: Record<string, { ar: string; en: string }> = {
    whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
    messenger: { ar: 'ماسنجر', en: 'Messenger' },
    instagram: { ar: 'إنستغرام', en: 'Instagram' },
    web_chat: { ar: 'محادثة الموقع', en: 'Website chat' },
    custom: { ar: 'قناة مخصّصة', en: 'Custom channel' },
  };
  const label = labels[kind];
  return label === undefined ? kind : t(state, label.ar, label.en);
}

export function renderChannels(state: AppState): HTMLElement {
  const live = state.live;

  if (live.session.status === 'unknown') {
    return frame(state, null, [busyNotice(state)]);
  }
  if (live.session.status === 'signed_out') {
    return frame(state, null, [
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'تحتاج جلسة', 'You need a session'),
        body: t(
          state,
          'شاشة القنوات تتصل بالخادم. افتح شاشة الأفراد لتسجيل الدخول.',
          'The Channels screen talks to the server. Open the People screen to sign in.',
        ),
        actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
        act: 'live-channels-reload',
      }),
    ]);
  }
  if (live.session.tenantId === null) {
    return frame(state, live.session.email, [
      stateBox({
        kind: 'info',
        iconName: 'users',
        title: t(state, 'لا توجد عضوية نشطة', 'No active membership'),
        body: t(
          state,
          'حسابك لا ينتمي إلى شركة نشطة، فلا توجد قنوات لعرضها.',
          'Your account does not belong to an active company, so there are no channels to show.',
        ),
      }),
    ]);
  }

  return frame(state, live.session.email, [
    connectCard(state, live),
    section(state, t(state, 'القنوات المتصلة', 'Connections'), connectionsBody(state, live)),
    section(state, t(state, 'ما يدعمه هذا الإصدار', 'What this build supports'), catalogueBody(state, live)),
  ]);
}

/* ------------------------------------------------------------------ shell -- */

function frame(state: AppState, email: string | null, children: readonly Child[]): HTMLElement {
  const live = state.live;
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    h('div', { class: 'workspace__intro' }, [
      h('div', { class: 'workspace__introtext' }, [
        h('h1', { class: 'workspace__heading' }, [t(state, 'القنوات', 'Channels')]),
        h('p', { class: 'workspace__lede' }, [
          t(
            state,
            'كل أصل لدى المزوّد له اتصال مستقل، وحالة «سليمة» تتطلب أدلة منفصلة يرصدها من شاهدها فعلًا. لصق رمز لا يثبت شيئًا.',
            'Every provider asset has its own connection, and “healthy” requires separate pieces of evidence recorded by whatever actually observed them. Pasting a token proves nothing.',
          ),
        ]),
      ]),
      email === null
        ? null
        : h('div', { class: 'workspace__actions' }, [
            h('span', { class: 'pill' }, [isolated(email)]),
            button({
              label: t(state, 'تحديث', 'Reload'),
              icon: 'refresh',
              act: 'live-channels-reload',
              small: true,
              disabled: live.busy !== null,
            }),
          ]),
    ]),
    ...children,
  ]);
}

function section(state: AppState, title: string, body: Child): HTMLElement {
  return h('section', { class: 'card', 'aria-label': title }, [
    h('div', { class: 'card__header' }, [h('h2', { class: 'card__title' }, [title])]),
    body,
  ]);
}

function busyNotice(state: AppState): HTMLElement {
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
  ]);
}

function resourceView<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: { title: string; body: string },
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return busyNotice(state);
  }
  if (resource.status === 'error') {
    return errorView(state, resource.error);
  }
  if (resource.value.length === 0) {
    return stateBox({ kind: 'empty', iconName: 'channels', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

function errorView(state: AppState, error: ApiError): Child {
  if (isUnauthenticated(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'انتهت الجلسة', 'Your session ended'),
      body: t(state, 'سجّل الدخول من جديد للمتابعة.', 'Sign in again to continue.'),
    });
  }
  if (isDenial(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'لا تملك صلاحية إدارة القنوات', 'You do not have permission to manage channels'),
      body: t(
        state,
        'الخادم رفض الطلب بمفتاح channel.manage. إخفاء الزر ليس ضابط تفويض — الرفض يحدث على الخادم.',
        'The server refused this by the channel.manage key. Hiding the control is not an authorization control; the refusal happens on the server.',
      ),
    });
  }
  return stateBox({
    kind: 'offline',
    iconName: error.code === 'network' ? 'wifiOff' : 'alert',
    title:
      error.code === 'network'
        ? t(state, 'تعذّر الوصول إلى الخادم', 'Could not reach the server')
        : t(state, 'رفض الخادم الطلب', 'The server rejected the request'),
    body: `${error.message}${error.requestId === null ? '' : ` · ${error.requestId}`}`,
    actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
    act: 'live-channels-reload',
  });
}

function mutationError(state: AppState, live: LiveState): Child {
  if (live.error === null) {
    return null;
  }
  const detail = live.error.details.map((entry) => `${entry.field}: ${entry.message}`).join(' · ');
  return h('div', { class: 'banner banner--danger', role: 'alert' }, [
    h('span', {}, [live.error.message]),
    detail === '' ? null : h('span', { class: 'banner__spacer' }),
    detail === '' ? null : h('span', {}, [detail]),
  ]);
}

/* ---------------------------------------------------------------- connect -- */

/**
 * The connect form.
 *
 * The three inputs dispatch `form-toggle` rather than `form`: their values gate
 * the button, and a control whose disabled state is one keystroke behind is a
 * control that looks broken. The renderer preserves focus and caret across the
 * re-render, which is what makes that affordable.
 */
function connectCard(state: AppState, live: LiveState): HTMLElement {
  const connecting = live.busy === 'connect-channel';
  const rawKind = state.dialogForm['channelKind'] ?? 'whatsapp';
  const kind = (['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'] as const).find((value) => value === rawKind) ?? 'whatsapp';
  const meta = kind === 'whatsapp' || kind === 'messenger' || kind === 'instagram';
  const providerApp = state.dialogForm['channelProviderApp'] ?? '';
  const asset = state.dialogForm['channelAsset'] ?? '';
  const name = state.dialogForm['channelName'] ?? '';
  const token = state.dialogForm['channelToken'] ?? '';
  return h('section', { class: 'card', 'aria-label': t(state, 'ربط قناة', 'Connect a channel') }, [
    h('div', { class: 'card__header' }, [
      h('h2', { class: 'card__title' }, [t(state, 'ربط قناة', 'Connect a channel')]),
    ]),
    h('div', { class: 'card__body' }, [
      h('p', { class: 'field__hint' }, [
        t(
          state,
          'الربط يطالب بالأصل لدى هذا التنصيب كله، ويخزّن الاعتماد مشفَّرًا. لا يجعل القناة تعمل — الحالة تبدأ عند «تحتاج تفويضًا».',
          'Connecting claims the asset across this whole installation and stores the credential encrypted. It does not make the channel work: the state starts at “Authorization needed”.',
        ),
      ]),
      h('div', { class: 'filterbar' }, [
        selectControl({
          value: kind,
          act: 'form-toggle',
          form: 'channelKind',
          ariaLabel: t(state, 'نوع القناة', 'Channel kind'),
          options: [
            { value: 'whatsapp', label: kindLabel(state, 'whatsapp') },
            { value: 'messenger', label: kindLabel(state, 'messenger') },
            { value: 'instagram', label: kindLabel(state, 'instagram') },
            { value: 'web_chat', label: kindLabel(state, 'web_chat') },
            { value: 'custom', label: kindLabel(state, 'custom') },
          ],
        }),
        meta
          ? h('span', { class: 'searchbox', style: 'flex:1 1 11rem' }, [
              h('input', {
                class: 'input',
                inputmode: 'numeric',
                placeholder: t(state, 'Meta App ID', 'Meta App ID'),
                'aria-label': t(state, 'معرّف تطبيق ميتا المهيّأ على الخادم', 'Meta App ID configured on the server'),
                value: providerApp,
                'data-act': 'form-toggle',
                'data-form': 'channelProviderApp',
              }),
            ])
          : null,
        h('span', { class: 'searchbox', style: 'flex:1 1 12rem' }, [
          h('input', {
            class: 'input',
            placeholder: assetPlaceholder(state, kind),
            'aria-label': t(state, 'معرّف الأصل', 'Provider asset id'),
            value: asset,
            'data-act': 'form-toggle',
            'data-form': 'channelAsset',
          }),
        ]),
        h('span', { class: 'searchbox', style: 'flex:1 1 10rem' }, [
          h('input', {
            class: 'input',
            placeholder: t(state, 'اسم للعرض', 'Display name'),
            'aria-label': t(state, 'اسم القناة', 'Channel name'),
            value: name,
            'data-act': 'form-toggle',
            'data-form': 'channelName',
          }),
        ]),
        h('span', { class: 'searchbox', style: 'flex:1 1 12rem' }, [
          h('input', {
            class: 'input',
            type: 'password',
            autocomplete: 'off',
            placeholder: meta
              ? t(state, 'رمز وصول المزوّد', 'Provider access token')
              : t(state, 'مفتاح توقيع قوي', 'Strong signing key'),
            'aria-label': t(state, 'رمز الوصول', 'Access token'),
            value: token,
            'data-act': 'form-toggle',
            'data-form': 'channelToken',
          }),
        ]),
        button({
          label: connecting
            ? t(state, 'جارٍ الربط…', 'Connecting…')
            : t(state, 'ربط القناة', 'Connect channel'),
          icon: 'plus',
          act: 'live-connect-channel',
          variant: 'primary',
          small: true,
          disabled: connecting || (meta && providerApp === '') || asset === '' || name === '' || token === '',
        }),
      ]),
      mutationError(state, live),
    ]),
  ]);
}

/* ------------------------------------------------------------ connections -- */

function connectionsBody(state: AppState, live: LiveState): Child {
  return h('div', { class: 'card__body' }, [
    resourceView(
      state,
      live.connections,
      {
        title: t(state, 'لا قنوات بعد', 'No channels yet'),
        body: t(
          state,
          'اربط أصلًا من المزوّد لتبدأ استقبال الرسائل.',
          'Connect a provider asset to start receiving messages.',
        ),
      },
      (rows) => h('div', { class: 'grid2' }, rows.map((row) => connectionCard(state, live, row))),
    ),
  ]);
}

function connectionCard(state: AppState, live: LiveState, connection: ChannelConnection): HTMLElement {
  const gone = connection.disconnected_at !== null;
  const testing = live.busy === `test-channel:${connection.id}`;
  const tokenField = channelTokenField(connection.id);
  const token = state.dialogForm[tokenField] ?? '';
  return h('div', { class: 'card', 'data-connection': connection.id }, [
    h('div', { class: 'card__header' }, [
      h('span', { class: 'card__title' }, [connection.display_name]),
      h('span', { class: 'card__spacer' }),
      pill(readinessLabel(state, connection.status), READINESS_TONE[connection.status], 'shield'),
    ]),
    h('dl', { class: 'attrgrid' }, [
      h('dt', {}, [t(state, 'النوع', 'Kind')]),
      h('dd', {}, [kindLabel(state, connection.kind)]),
      h('dt', {}, [t(state, 'الأصل', 'Asset')]),
      h('dd', {}, [isolated(connection.external_asset_id, true)]),
      connection.provider_app_id === null
        ? null
        : h('dt', {}, [t(state, 'تطبيق ميتا', 'Meta app')]),
      connection.provider_app_id === null
        ? null
        : h('dd', {}, [isolated(connection.provider_app_id, true)]),
      h('dt', {}, [t(state, 'معرّف الاتصال', 'Connection id')]),
      h('dd', {}, [isolated(connection.id, true)]),
      h('dt', {}, [t(state, 'نافذة الرد', 'Reply window')]),
      h('dd', {}, [windowLabel(state, connection.capabilities)]),
    ]),
    h('div', { class: 'field' }, [
      h('span', { class: 'field__label' }, [t(state, 'الأدلة', 'Evidence')]),
      h(
        'ul',
        { class: 'checklist' },
        connection.evidence.map((item) => checkItem(evidenceLabel(state, item.kind), item.satisfied)),
      ),
    ]),
    connection.last_error_code === null
      ? null
      : h('div', { class: 'banner banner--danger', role: 'status' }, [
          h('span', {}, [
            `${t(state, 'آخر خطأ من الخادم', 'Last error from the server')}: `,
            isolated(connection.last_error_code, true),
          ]),
        ]),
    gone
      ? h('p', { class: 'field__hint' }, [
          t(
            state,
            'مفصولة. سجلّها محفوظ، ويمكن ربط الأصل من جديد.',
            'Disconnected. Its history is kept, and the asset can be connected again.',
          ),
        ])
      : h('div', { class: 'filterbar' }, [
          button({
            label: testing
              ? t(state, 'جارٍ الاختبار…', 'Testing…')
              : t(state, 'اختبار الاعتماد', 'Test credential'),
            icon: 'refresh',
            act: 'live-test-channel',
            arg: connection.id,
            small: true,
            disabled: testing,
          }),
          h('span', { class: 'searchbox', style: 'flex:1 1 10rem' }, [
            h('input', {
              class: 'input',
              type: 'password',
              autocomplete: 'off',
              placeholder: t(state, 'اعتماد جديد', 'New credential'),
              'aria-label': t(state, `اعتماد جديد لـ ${connection.display_name}`, `New credential for ${connection.display_name}`),
              value: token,
              'data-act': 'form-toggle',
              'data-form': tokenField,
            }),
          ]),
          button({
            label: t(state, 'تدوير', 'Rotate'),
            act: 'live-rotate-channel',
            arg: connection.id,
            small: true,
            disabled: live.busy === `rotate-channel:${connection.id}` || token === '',
          }),
          button({
            label: t(state, 'فصل', 'Disconnect'),
            act: 'live-disconnect-channel',
            arg: connection.id,
            small: true,
            variant: 'danger',
            disabled: live.busy === `disconnect-channel:${connection.id}`,
          }),
        ]),
  ]);
}

function assetPlaceholder(state: AppState, kind: ChannelKind): string {
  const labels: Record<ChannelKind, { ar: string; en: string }> = {
    whatsapp: { ar: 'Phone Number ID', en: 'Phone Number ID' },
    messenger: { ar: 'Page ID', en: 'Page ID' },
    instagram: { ar: 'Instagram Account ID', en: 'Instagram Account ID' },
    web_chat: { ar: 'معرّف ويدجت الموقع', en: 'Website widget ID' },
    custom: { ar: 'معرّف القناة المخصّصة', en: 'Custom channel ID' },
  };
  const label = labels[kind];
  return t(state, label.ar, label.en);
}

function windowLabel(state: AppState, capabilities: CapabilityMatrix): string {
  return capabilities.windowHours === null
    ? t(state, 'بلا نافذة', 'No window')
    : `${String(capabilities.windowHours)} ${t(state, 'ساعة', 'hours')}`;
}

/* -------------------------------------------------------------- catalogue -- */

function catalogueBody(state: AppState, live: LiveState): Child {
  return h('div', { class: 'card__body' }, [
    h('p', { class: 'field__hint' }, [
      t(
        state,
        'ما يستطيع هذا الإصدار خدمته فعلًا. القناة غير المنفَّذة معروضة ومعطّلة، لا مخفية.',
        'What this build can actually serve. An unimplemented channel is shown and disabled, not hidden.',
      ),
    ]),
    resourceView(
      state,
      live.catalogue,
      {
        title: t(state, 'لا قنوات معروفة', 'No channels declared'),
        body: t(state, 'لم يُبلغ الخادم عن أي قناة.', 'The server declared no channels.'),
      },
      (rows) => h('div', { class: 'rolegrid' }, rows.map((row) => catalogueCard(state, row))),
    ),
  ]);
}

function catalogueCard(state: AppState, entry: ChannelCatalogueEntry): HTMLElement {
  const limit = entry.capabilities.textLimit;
  return h('div', { class: 'card', 'data-channel-kind': entry.kind }, [
    h('div', { class: 'card__header' }, [
      h('span', { class: 'card__title' }, [kindLabel(state, entry.kind)]),
      h('span', { class: 'card__spacer' }),
      entry.implemented
        ? pill(t(state, 'منفَّذة', 'Implemented'), 'success', 'check')
        : pill(t(state, 'غير منفَّذة بعد', 'Not implemented yet'), 'neutral'),
    ]),
    h('div', { class: 'rolegrid__key' }, [
      `${entry.capabilities.host} · ${entry.capabilities.version}`,
    ]),
    h('div', { class: 'labelset' }, [
      pill(windowLabel(state, entry.capabilities), 'neutral'),
      // Both units, because a 1000-character limit is 500 Arabic characters
      // when the real bound is bytes.
      pill(
        `${String(limit.characters)} ${t(state, 'حرفًا', 'chars')} / ${String(limit.bytes)} ${t(state, 'بايت', 'bytes')}`,
        'neutral',
      ),
      entry.capabilities.templates
        ? pill(t(state, 'قوالب', 'Templates'), 'accent')
        : pill(t(state, 'بلا قوالب', 'No templates'), 'neutral'),
      entry.capabilities.businessInitiated
        ? pill(t(state, 'يمكن بدء المحادثة', 'Can start a conversation'), 'neutral')
        : pill(t(state, 'يبدأها العميل فقط', 'Customer-initiated only'), 'warning'),
      // Unsupported is `not_available`, never `false` or `0%` (ADR-0009).
      entry.capabilities.readReceipts
        ? pill(t(state, 'إشعار القراءة', 'Read receipts'), 'neutral')
        : pill(t(state, 'إشعار القراءة غير متاح', 'Read receipts not available'), 'neutral'),
    ]),
  ]);
}
