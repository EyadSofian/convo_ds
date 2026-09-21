import type { Conversation, QueueCard, TimelineMessage } from '../api/conversations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { clockTime, dayLabel, initials, relativeTime } from '../format.js';
import { icon } from '../icons.js';
import { routingAbility } from '../live/ability.js';
import { activeFilterCount, simpleFilterValue } from '../live/inbox-query.js';
import { isDenial, rowsOf } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { LIST_WIDTH_MAX, LIST_WIDTH_MIN } from '../state.js';
import { renderContactPanel } from './contact-panel.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import type { Phrase } from './copy.js';
import {
  episodesSection,
  lifecycleControls,
  lifecycleForm,
  lifecycleNotice,
  notesSection,
  statusBadge,
} from './lifecycle-panel.js';
import { metadataSection } from './metadata-section.js';
import {
  avatar,
  button,
  emptyState,
  errorState,
  isolated,
  segmented,
  selectControl,
  skeleton,
} from './parts.js';
import { movedAway, priorityBadge, routingSection } from './routing-panel.js';

/**
 * The Inbox, backed entirely by the API.
 *
 * Three zones, and each one shows exactly what the server is willing to say:
 *
 * - **Queue** — the Unassigned work, as *projected cards*. A card carries a
 *   masked label and no message text, because that is what the server sends to
 *   somebody who has not claimed the conversation (IAM-11).
 * - **Mine** — conversations this caller may actually read, as records.
 * - **Thread** — the timeline of one conversation, with a reply composer only
 *   once it is theirs, and a private-note composer that never reaches the
 *   customer.
 *
 * The live connection's state is on screen, deliberately. A stream that has
 * stopped delivering looks exactly like a quiet inbox.
 */

const DELIVERY_LABEL: Readonly<Record<string, Phrase>> = {
  sent: { ar: 'أُرسلت', en: 'Sent' },
  delivered: { ar: 'سُلّمت', en: 'Delivered' },
  read: { ar: 'قُرئت', en: 'Read' },
};

const COMMAND_LABEL: Readonly<Record<string, Phrase>> = {
  queued: { ar: 'في الانتظار', en: 'Queued' },
  dispatching: { ar: 'جارٍ الإرسال', en: 'Sending' },
  provider_accepted: { ar: 'قبلها المزوّد', en: 'Accepted' },
  rejected: { ar: 'مرفوضة', en: 'Rejected' },
  retry_scheduled: { ar: 'ستُعاد المحاولة', en: 'Retry scheduled' },
  skipped: { ar: 'تم تخطيها', en: 'Skipped' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  failed: { ar: 'فشلت', en: 'Failed' },
  outcome_unknown: { ar: 'النتيجة غير معروفة', en: 'Outcome unknown' },
};

/* ------------------------------------------------------------------ shell -- */

export function renderInbox(state: AppState): HTMLElement {
  const live = state.live;
  const open = live.openConversationId !== null;
  return h(
    'div',
    {
      class: 'inbox',
      'data-list': state.listOpen ? 'open' : 'closed',
      'data-panel': open && state.panelOpen ? 'open' : 'closed',
      'data-panel-drawer': open && state.panelDrawer ? 'open' : 'closed',
      style: `--list-width:${String(state.listWidth)}px`,
    },
    [
      renderListZone(state, live),
      h('button', {
        type: 'button',
        class: 'zone-scrim zone-scrim--list',
        'data-act': 'close-overlays',
        'data-arg': 'list',
        'data-scrim': 'true',
        'aria-label': t(state, 'إغلاق قائمة المحادثات', 'Close conversation list'),
        tabindex: '-1',
      }),
      renderThreadZone(state, live),
      open
        ? h('button', {
            type: 'button',
            class: 'zone-scrim zone-scrim--panel',
            'data-act': 'close-overlays',
            'data-arg': 'panel-drawer',
            'data-scrim': 'true',
            'aria-label': t(state, 'إغلاق التفاصيل', 'Close details'),
            tabindex: '-1',
          })
        : null,
      open
        ? renderContactPanel(state, live, [
            live.openConversation.status === 'ready'
              ? metadataSection(state, live, 'conversation', live.openConversation.value)
              : null,
            live.openConversation.status === 'ready'
              ? routingSection(state, live, live.openConversation.value, routingAbility(live))
              : null,
            notesSection(state, live),
            episodesSection(state, live),
          ])
        : null,
    ],
  );
}

/**
 * The draggable edge of the queue column. A `separator` with a value range, so
 * the width is adjustable from the keyboard as well as by pointer.
 */
function listResizer(state: AppState): HTMLElement {
  return h('button', {
    type: 'button',
    class: 'list-resizer',
    'data-act': 'resize-list-step',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t(state, 'عرض قائمة المحادثات', 'Conversation list width'),
    'aria-valuemin': String(LIST_WIDTH_MIN),
    'aria-valuemax': String(LIST_WIDTH_MAX),
    'aria-valuenow': String(state.listWidth),
  });
}

/* ------------------------------------------------------------------- list -- */

function renderListZone(state: AppState, live: LiveState): HTMLElement {
  const activeFilters = activeFilterCount(live.inboxQuery);
  return h('section', { class: 'zone zone--list', 'aria-label': t(state, 'قائمة المحادثات', 'Conversation list') }, [
    h('header', { class: 'listhead' }, [
      segmented(
        [
          { value: 'unassigned', label: t(state, 'غير مسندة', 'Unassigned'), count: countOf(live.unassigned) },
          { value: 'mine', label: t(state, 'محادثاتي', 'Mine'), count: countOf(live.conversations) },
        ],
        state.inboxQueue,
        'live-inbox-queue',
        t(state, 'طابور المحادثات', 'Conversation queue'),
      ),
      h('div', { class: 'listhead__tools' }, [
        h('div', { class: 'menu-anchor' }, [
          button({
            icon: 'filter',
            act: 'menu',
            arg: 'inbox-filters',
            variant: 'ghost',
            small: true,
            expanded: state.openMenu === 'inbox-filters',
            haspopup: 'dialog',
            title: activeFilters === 0
              ? t(state, 'تصفية', 'Filter')
              : t(state, `تصفية (${String(activeFilters)} مفعّلة)`, `Filter (${String(activeFilters)} active)`),
            extraClass: activeFilters === 0 ? undefined : 'btn--active',
          }),
          state.openMenu === 'inbox-filters' ? inboxFilters(state, live) : null,
        ]),
        button({
          icon: 'refresh',
          act: 'live-inbox-reload',
          variant: 'ghost',
          small: true,
          busy: live.unassigned.status === 'loading',
          title: t(state, 'تحديث', 'Refresh'),
        }),
        button({
          icon: 'close',
          act: 'close-overlays',
          arg: 'list',
          variant: 'ghost',
          small: true,
          title: t(state, 'إغلاق القائمة', 'Close list'),
          extraClass: 'listhead__close',
        }),
      ]),
    ]),
    connectionNotice(state, live),
    listResizer(state),
    h('div', { class: 'zone__body', 'data-scroll': 'list' }, [
      state.inboxQueue === 'mine' ? mineList(state, live) : queueList(state, live),
    ]),
  ]);
}

function countOf(resource: Resource<readonly unknown[]>): number | undefined {
  return resource.status === 'ready' ? resource.value.length : undefined;
}

function inboxFilters(state: AppState, live: LiveState): HTMLElement {
  const filters = live.inboxQuery;
  const labels = rowsOf(live.labels).filter((entry) => entry.state === 'active');
  const common = { act: 'live-inbox-filter', disabled: live.busy !== null };
  const row = (label: string, control: HTMLElement): HTMLElement =>
    h('label', { class: 'field field--row' }, [h('span', { class: 'field__label' }, [label]), control]);
  return h('div', { class: 'popover', role: 'group', 'data-overlay': 'popover', 'aria-label': t(state, 'تصفية المحادثات', 'Filter conversations') }, [
    row(t(state, 'القراءة', 'Read state'), selectControl({ ...common, value: simpleFilterValue(filters, 'unread'), form: 'unread', options: [
      { value: '', label: t(state, 'الكل', 'All') },
      { value: 'true', label: t(state, 'غير مقروءة', 'Unread') },
      { value: 'false', label: t(state, 'مقروءة', 'Read') },
    ] })),
    row(t(state, 'الأولوية', 'Priority'), selectControl({ ...common, value: simpleFilterValue(filters, 'priority'), form: 'priority', options: [
      { value: '', label: t(state, 'كل الأولويات', 'Any priority') },
      { value: 'urgent', label: t(state, 'عاجلة', 'Urgent') },
      { value: 'high', label: t(state, 'مرتفعة', 'High') },
      { value: 'normal', label: t(state, 'عادية', 'Normal') },
      { value: 'low', label: t(state, 'منخفضة', 'Low') },
    ] })),
    row(t(state, 'القناة', 'Channel'), selectControl({ ...common, value: simpleFilterValue(filters, 'channel'), form: 'channel', options: [
      { value: '', label: t(state, 'كل القنوات', 'Any channel') },
      ...['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'].map((value) => ({ value, label: phrase(state, CHANNEL_NAMES, value) })),
    ] })),
    row(t(state, 'التصنيف', 'Label'), selectControl({ ...common, value: simpleFilterValue(filters, 'labelId'), form: 'labelId', options: [
      { value: '', label: t(state, 'كل التصنيفات', 'Any label') },
      ...labels.map((entry) => ({ value: entry.id, label: entry.name })),
    ] })),
  ]);
}

/**
 * What the live connection is doing, in words. A stream that is not delivering
 * looks exactly like an inbox with nothing happening in it.
 */
function connectionNotice(state: AppState, live: LiveState): Child {
  const realtime = live.realtime;
  if (realtime.status === 'live') {
    return h('p', { class: 'realtime realtime--live', 'data-realtime': 'live' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'تحديث مباشر', 'Live'),
    ]);
  }
  if (realtime.status === 'stale') {
    return h('p', { class: 'realtime realtime--stale', 'data-realtime': 'stale', role: 'status' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'انقطع التحديث المباشر — جارٍ إعادة الاتصال', 'Live updates paused — reconnecting'),
    ]);
  }
  if (realtime.status === 'stopped') {
    return h('p', { class: 'realtime realtime--stopped', 'data-realtime': 'stopped', role: 'status' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'توقف التحديث المباشر لتغيّر صلاحياتك. حدّث الصفحة.', 'Live updates stopped because your access changed. Refresh.'),
    ]);
  }
  return null;
}

function queueList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.unassigned,
    {
      title: t(state, 'لا توجد محادثات بانتظار الاستلام', 'Nothing waiting to be claimed'),
      body: t(state, 'ستظهر هنا المحادثات الجديدة في صناديقك.', 'New conversations in your inboxes appear here.'),
    },
    (cards) => h('div', { class: 'convlist', role: 'list' }, cards.map((card) => queueRow(state, live, card))),
  );
}

function mineList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.conversations,
    {
      title: t(state, 'لا توجد محادثات مسندة إليك', 'Nothing assigned to you'),
      body: t(state, 'استلم محادثة من «غير مسندة» لتبدأ.', 'Claim one from Unassigned to start.'),
    },
    (rows) => h('div', { class: 'convlist', role: 'list' }, rows.map((conversation) => conversationRow(state, live, conversation))),
  );
}

function listBody<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: { title: string; body: string },
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return skeleton(state, 6);
  }
  if (resource.status === 'error') {
    return errorState(state, resource.error, 'live-inbox-reload');
  }
  if (resource.value.length === 0) {
    return emptyState({ icon: 'inboxEmpty', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

/**
 * The cue a row carries for priority: nothing for ordinary work. A priority
 * this build has no word for is shown as itself rather than hidden.
 */
function priorityCue(state: AppState, priority: string): Child {
  return priority === 'normal' || priority === 'low' ? null : priorityBadge(state, priority);
}

/**
 * A queue card. Everything on it came from the server's projection; there is
 * no snippet because there is no snippet to render.
 */
function queueRow(state: AppState, live: LiveState, card: QueueCard): HTMLElement {
  return h('article', { class: 'convrow convrow--card', role: 'listitem', 'data-conversation': card.id }, [
    avatar({ initials: '', channel: card.channel }),
    h('div', { class: 'convrow__main' }, [
      h('div', { class: 'convrow__line' }, [
        h('span', { class: 'convrow__name' }, [isolated(card.maskedLabel)]),
        h('span', { class: 'convrow__time' }, [
          // A conversation opened by an outbound message has nobody waiting on
          // it, and the row says so rather than showing a made-up duration.
          card.waitingSinceAt === null
            ? t(state, 'لم ينتظر بعد', 'Not waiting')
            : relativeTime(card.waitingSinceAt, state.clock, state.lang),
        ]),
      ]),
      h('div', { class: 'convrow__line convrow__meta' }, [
        h('span', { class: 'convrow__where' }, [`${phrase(state, CHANNEL_NAMES, card.channel)} · ${card.inboxLabel}`]),
        priorityCue(state, card.priority),
      ]),
    ]),
    button({
      label: t(state, 'استلام', 'Claim'),
      act: 'live-inbox-claim',
      // The version travels with the click, so the claim carries the version
      // this agent actually saw (IAM-13).
      arg: `${card.id}:${String(card.version)}`,
      small: true,
      busy: live.busy === `claim:${card.id}`,
      disabled: !card.claimable,
      extraClass: 'convrow__claim',
    }),
  ]);
}

function conversationRow(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  const open = live.openConversationId === conversation.id;
  // `unread` is this caller's own bookkeeping. A row with no answer is not
  // marked: absent is not the same as read.
  const unread = conversation.unread === true;
  return h(
    'button',
    {
      type: 'button',
      class: unread ? 'convrow convrow--record convrow--unread' : 'convrow convrow--record',
      role: 'listitem',
      'data-act': 'live-inbox-open',
      'data-arg': conversation.id,
      'data-conversation': conversation.id,
      'aria-current': open ? 'true' : 'false',
    },
    [
      avatar({ initials: initials(conversation.peerIdentity), channel: conversation.channel }),
      h('span', { class: 'convrow__main' }, [
        h('span', { class: 'convrow__line' }, [
          h('span', { class: 'convrow__name' }, [isolated(conversation.peerIdentity)]),
          h('span', { class: 'convrow__time' }, [relativeTime(conversation.lastActivityAt, state.clock, state.lang)]),
        ]),
        h('span', { class: 'convrow__line convrow__meta' }, [
          h('span', { class: 'convrow__where' }, [`${phrase(state, CHANNEL_NAMES, conversation.channel)} · ${conversation.inboxLabel}`]),
          conversation.status === 'open' ? null : statusBadge(state, conversation.status),
          priorityCue(state, conversation.priority),
          unread
            ? h('span', { class: 'convrow__dot' }, [h('span', { class: 'visually-hidden' }, [t(state, 'غير مقروءة', 'Unread')])])
            : null,
        ]),
      ]),
    ],
  );
}

/* ----------------------------------------------------------------- thread -- */

function threadZone(state: AppState, children: readonly Child[]): HTMLElement {
  return h('section', { class: 'zone zone--thread thread', 'aria-label': t(state, 'المحادثة', 'Conversation') }, children);
}

function listToggle(state: AppState): HTMLElement {
  return button({
    icon: 'inbox',
    act: 'list',
    variant: 'ghost',
    small: true,
    expanded: state.listOpen,
    title: t(state, 'قائمة المحادثات', 'Conversation list'),
    extraClass: 'thread__listtoggle',
  });
}

function renderThreadZone(state: AppState, live: LiveState): HTMLElement {
  if (live.openConversationId === null) {
    return threadZone(state, [
      h('div', { class: 'thread__placeholder' }, [
        emptyState({
          icon: 'chat',
          title: t(state, 'اختر محادثة', 'Choose a conversation'),
          body: t(state, 'افتح محادثة من القائمة لقراءة سجلها والرد عليها.', 'Open one from the list to read its history and reply.'),
          action: { label: t(state, 'عرض المحادثات', 'Show conversations'), act: 'list' },
        }),
      ]),
    ]);
  }
  if (live.openConversation.status === 'error') {
    return threadZone(state, [
      h('div', { class: 'thread__placeholder' }, [
        // A permission loss here is a normal outcome of routing — a handoff or
        // a reassignment moves a conversation away — so it is named as such.
        live.lostAccess && isDenial(live.openConversation.error)
          ? movedAway(state)
          : errorState(state, live.openConversation.error, 'live-inbox-reload'),
      ]),
    ]);
  }
  if (live.openConversation.status !== 'ready') {
    return threadZone(state, [h('div', { class: 'thread__placeholder' }, [skeleton(state, 4)])]);
  }

  const conversation = live.openConversation.value;
  return threadZone(state, [
    threadHeader(state, live, conversation),
    lifecycleForm(state, live, conversation),
    lifecycleNotice(state, conversation),
    timelineView(state, live),
    // An archived conversation is immutable, so it gets no composer. The notice
    // above says why; a disabled box would say only that something is wrong.
    conversation.status === 'archived' ? null : composer(state, live, conversation),
  ]);
}

function threadHeader(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  return h('header', { class: 'thread__header' }, [
    listToggle(state),
    avatar({ initials: initials(conversation.peerIdentity), channel: conversation.channel }),
    h('div', { class: 'thread__names' }, [
      h('h2', { class: 'thread__name' }, [isolated(conversation.peerIdentity)]),
      h('p', { class: 'thread__sub' }, [
        `${phrase(state, CHANNEL_NAMES, conversation.channel)} · ${conversation.inboxLabel}`,
      ]),
    ]),
    h('div', { class: 'thread__badges' }, [
      statusBadge(state, conversation.status),
      conversation.priority === 'normal' ? null : priorityBadge(state, conversation.priority),
    ]),
    h('div', { class: 'thread__toolbar' }, [
      lifecycleControls(state, live, conversation),
      button({
        icon: 'panel',
        act: 'panel',
        variant: 'ghost',
        small: true,
        pressed: state.panelOpen,
        title: t(state, 'تفاصيل العميل', 'Customer details'),
        extraClass: 'thread__paneltoggle thread__paneltoggle--inline',
      }),
      button({
        icon: 'panel',
        act: 'panel-drawer',
        variant: 'ghost',
        small: true,
        expanded: state.panelDrawer,
        title: t(state, 'تفاصيل العميل', 'Customer details'),
        extraClass: 'thread__paneltoggle thread__paneltoggle--drawer',
      }),
    ]),
  ]);
}

function timelineView(state: AppState, live: LiveState): Child {
  const timeline = live.timeline;
  if (timeline.status === 'idle' || timeline.status === 'loading') {
    return h('div', { class: 'thread__body' }, [skeleton(state, 4)]);
  }
  if (timeline.status === 'error') {
    return h('div', { class: 'thread__body' }, [errorState(state, timeline.error, 'live-inbox-reload')]);
  }
  if (timeline.value.length === 0) {
    return h('div', { class: 'thread__body' }, [
      emptyState({
        icon: 'chat',
        title: t(state, 'لا توجد رسائل بعد', 'No messages yet'),
        body: t(state, 'ستظهر الرسائل هنا فور وصولها.', 'Messages appear here as they arrive.'),
      }),
    ]);
  }
  const items: Child[] = [];
  let lastDay = '';
  for (const message of timeline.value) {
    const day = dayLabel(message.at, state.clock, state.lang);
    if (day !== lastDay) {
      items.push(h('div', { class: 'daysep', role: 'separator' }, [h('span', {}, [day])]));
      lastDay = day;
    }
    items.push(messageBubble(state, message));
  }
  return h(
    'div',
    {
      class: 'thread__body',
      // A scrollable region has to be reachable by keyboard, and a conversation
      // that grows while it is on screen is a log.
      role: 'log',
      tabindex: '0',
      'data-scroll': 'timeline',
      'aria-label': t(state, 'سجل المحادثة', 'Conversation log'),
    },
    [
      live.timelineCursor === null
        ? null
        : h('div', { class: 'thread__older' }, [
            button({
              label: t(state, 'تحميل الرسائل الأقدم', 'Load older messages'),
              act: 'live-inbox-older',
              small: true,
              variant: 'ghost',
              busy: live.busy === 'load-older',
            }),
          ]),
      ...items,
    ],
  );
}

function messageBubble(state: AppState, message: TimelineMessage): HTMLElement {
  return h('article', { class: message.direction === 'out' ? 'msg msg--out' : 'msg msg--in', 'data-message': message.id }, [
    h('div', { class: 'msg__bubble' }, [message.text ?? '']),
    h('div', { class: 'msg__meta' }, [
      h('time', { datetime: message.at }, [clockTime(message.at, state.lang)]),
      ...deliveryNote(state, message),
    ]),
  ]);
}

/**
 * What we know about an outbound message, said plainly.
 *
 * Two facts, not one: what we asked the provider to do and what it later said
 * happened. A screen that folded them into a single tick would be inventing
 * agreement between two things that can genuinely disagree.
 */
function deliveryNote(state: AppState, message: TimelineMessage): readonly Child[] {
  if (message.direction === 'in') {
    return [];
  }
  const parts: Child[] = [];
  if (message.command_state !== null) {
    parts.push(h('span', { class: `msg__state msg__state--${message.command_state}` }, [phrase(state, COMMAND_LABEL, message.command_state)]));
  }
  if (message.delivery_state !== null) {
    parts.push(
      h('span', { class: `msg__delivery msg__delivery--${message.delivery_state}` }, [
        icon(message.delivery_state === 'sent' ? 'check' : 'checkDouble', 14),
        phrase(state, DELIVERY_LABEL, message.delivery_state),
      ]),
    );
  }
  if (message.delivery_anomaly !== null) {
    // Recorded rather than smoothed over: a receipt disagreeing with an earlier
    // one is a fact worth showing the person who has to explain it.
    parts.push(
      h('span', { class: 'msg__anomaly', title: message.delivery_anomaly }, [
        t(state, 'إيصالات متعارضة', 'Conflicting receipts'),
      ]),
    );
  }
  return parts;
}

/* --------------------------------------------------------------- composer -- */

/**
 * The composer, with the reply and the private note as two separate tabs.
 *
 * Separate drafts, separate controls and a different surface, because one field
 * that sends to two places is how an internal remark reaches a customer.
 */
function composer(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  const mode = state.composerTab;
  const tabs = h('div', { class: 'composer__tabs', role: 'tablist', 'aria-label': t(state, 'نوع الرسالة', 'Message type') }, [
    composerTab(state, 'reply', t(state, 'رد', 'Reply'), 'reply'),
    composerTab(state, 'note', t(state, 'ملاحظة داخلية', 'Private note'), 'note'),
  ]);
  return h('div', { class: `composer composer--${mode}` }, [
    h('div', { class: 'composer__panel', role: 'tabpanel', id: 'composer-panel', 'aria-labelledby': `composer-tab-${mode}` }, [
      mode === 'note' ? noteComposer(state, live, tabs) : replyComposer(state, live, conversation, tabs),
    ]),
  ]);
}

function composerTab(state: AppState, value: 'reply' | 'note', label: string, iconName: 'reply' | 'note'): HTMLElement {
  const selected = state.composerTab === value;
  return h(
    'button',
    {
      type: 'button',
      class: 'composer__tab',
      role: 'tab',
      id: `composer-tab-${value}`,
      'aria-selected': String(selected),
      'aria-controls': 'composer-panel',
      tabindex: selected ? '0' : '-1',
      'data-act': 'composer-tab',
      'data-arg': value,
    },
    [icon(iconName, 14), label],
  );
}

/**
 * The reply box, present only when the caller may actually send. An unclaimed
 * conversation gets a Claim button instead: it is not that replying is
 * unavailable, it is that the conversation is not this agent's yet.
 */
function replyComposer(state: AppState, live: LiveState, conversation: Conversation, tabs: HTMLElement): HTMLElement {
  if (conversation.assigneeMembershipId === null) {
    return h('div', { class: 'composer__toolbar composer__toolbar--claim' }, [
      tabs,
      h('p', { class: 'composer__blocked' }, [
        t(state, 'استلم المحادثة لتتمكن من الرد.', 'Claim the conversation to reply.'),
      ]),
      button({
        label: t(state, 'استلام', 'Claim'),
        act: 'live-inbox-claim',
        arg: `${conversation.id}:${String(conversation.version)}`,
        variant: 'primary',
        small: true,
        busy: live.busy === `claim:${conversation.id}`,
      }),
    ]);
  }
  return h('div', { class: 'composer__box' }, [
    // The text is the element's **content**, not a `value` attribute: a textarea
    // ignores that attribute, so rendering it that way would empty the composer
    // on every re-render — and a realtime event mid-sentence is a re-render.
    h(
      'textarea',
      {
        class: 'composer__input',
        rows: '1',
        dir: 'auto',
        'data-act': 'live-composer',
        'data-enables': 'live-inbox-send',
        'aria-label': t(state, 'نص الرد', 'Reply text'),
        placeholder: t(state, 'اكتب ردًا للعميل…', 'Write a reply to the customer…'),
      },
      [live.composer],
    ),
    h('div', { class: 'composer__toolbar' }, [
      tabs,
      live.error === null
        ? h('span', { class: 'composer__hint' }, [t(state, 'يُرسل إلى العميل عبر القناة', 'Sent to the customer on this channel')])
        : h('span', { class: 'composer__hint composer__hint--error', role: 'alert' }, [live.error.message]),
      button({
        label: t(state, 'إرسال', 'Send'),
        icon: 'send',
        act: 'live-inbox-send',
        variant: 'primary',
        small: true,
        busy: live.busy === 'send-reply',
        disabled: live.composer.trim() === '',
      }),
    ]),
  ]);
}

function noteComposer(state: AppState, live: LiveState, tabs: HTMLElement): HTMLElement {
  // The composer is only drawn beside an open conversation.
  const busy = live.busy === `note:${String(live.openConversationId)}`;
  return h('div', { class: 'composer__box composer__box--note' }, [
    h(
      'textarea',
      {
        class: 'composer__input composer__input--note',
        rows: '1',
        dir: 'auto',
        maxlength: '4000',
        'data-act': 'live-note-draft',
        'data-enables': 'live-note-add',
        'aria-label': t(state, 'ملاحظة داخلية جديدة', 'New private note'),
        placeholder: t(state, 'ملاحظة لفريقك — لا يراها العميل', 'A note for your team — the customer never sees it'),
      },
      [live.noteDraft],
    ),
    h('div', { class: 'composer__toolbar' }, [
      tabs,
      h('span', { class: 'composer__hint' }, [icon('lock', 14), t(state, 'مرئية لفريقك فقط', 'Visible to your team only')]),
      button({
        label: t(state, 'إضافة ملاحظة', 'Add note'),
        act: 'live-note-add',
        small: true,
        busy,
        disabled: live.noteDraft.trim() === '',
      }),
    ]),
  ]);
}
