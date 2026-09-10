import type { ApiError } from '../api/client.js';
import type { Conversation, QueueCard, TimelineMessage } from '../api/conversations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { clockTime, initials, relativeTime } from '../format.js';
import { isDenial, isUnauthenticated } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { LIST_WIDTH_MAX, LIST_WIDTH_MIN } from '../state.js';
import type { IconName } from '../icons.js';
import { routingAbility } from '../live/ability.js';
import { renderContactPanel } from './contact-panel.js';
import {
  movedAway,
  priorityPill,
  routingSection,
} from './routing-panel.js';
import {
  episodesSection,
  lifecycleControls,
  lifecycleForm,
  lifecycleNotice,
  notesSection,
  statusPill,
} from './lifecycle-panel.js';
import { avatar, button, CHANNEL_ICON, isolated, pill, stateBox } from './parts.js';

/**
 * The Inbox, backed entirely by the API.
 *
 * Three zones, and each one shows exactly what the server is willing to say:
 *
 * - **Queue** — the Unassigned work, as *projected cards*. A card carries a
 *   masked label and no message text, because that is what the server sends to
 *   somebody who has not claimed the conversation. This screen could not show a
 *   snippet here if it wanted to: it was never given one (IAM-11).
 * - **Mine** — conversations this caller may actually read, as records.
 * - **Thread** — the timeline of one conversation, with the composer available
 *   only once it is theirs. Before a claim there is a Claim button and no
 *   composer, because that is the rule the server enforces and a screen that
 *   offered a disabled composer would be describing a different one.
 *
 * The live connection's state is on screen, deliberately. A stream that has
 * stopped delivering looks exactly like a quiet inbox, and an operator cannot
 * tell those apart by looking — so the screen says which one it is.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}


const DELIVERY_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  sent: { ar: 'أُرسلت', en: 'Sent' },
  delivered: { ar: 'وصلت', en: 'Delivered' },
  read: { ar: 'قُرئت', en: 'Read' },
};

const COMMAND_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  queued: { ar: 'في الانتظار', en: 'Queued' },
  dispatching: { ar: 'جارٍ الإرسال', en: 'Sending' },
  provider_accepted: { ar: 'قبِلها المزوّد', en: 'Accepted by the provider' },
  rejected: { ar: 'مرفوضة', en: 'Rejected' },
  retry_scheduled: { ar: 'إعادة مجدولة', en: 'Retry scheduled' },
  skipped: { ar: 'متروكة', en: 'Skipped' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  failed: { ar: 'فشلت', en: 'Failed' },
  outcome_unknown: { ar: 'النتيجة غير معروفة', en: 'Outcome unknown' },
};

const CHANNEL_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  messenger: { ar: 'ماسنجر', en: 'Messenger' },
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  web_chat: { ar: 'محادثة الموقع', en: 'Website chat' },
  custom: { ar: 'قناة مخصّصة', en: 'Custom channel' },
};

function labelled(
  state: AppState,
  table: Readonly<Record<string, { ar: string; en: string }>>,
  key: string,
): string {
  const entry = table[key];
  // A value this build does not recognise is shown as itself rather than
  // hidden: a newer server saying something new is information, not noise.
  return entry === undefined ? key : t(state, entry.ar, entry.en);
}

/* ------------------------------------------------------------------ shell -- */

export function renderInbox(state: AppState): HTMLElement {
  return h(
    'div',
    {
      class: 'inbox inbox--live',
      'data-list': state.listOpen ? 'open' : 'closed',
      'data-panel': state.live.openConversationId === null ? 'closed' : 'open',
      style: `--list-width:${String(state.listWidth)}px`,
    },
    [
      renderListZone(state, state.live),
      state.listOpen ? scrim(state) : null,
      renderThreadZone(state, state.live),
      // The customer beside the conversation, once there is a conversation to
      // stand beside. It is a column rather than a drawer: at these widths the
      // timeline keeps its 640px either way.
      state.live.openConversationId === null
        ? null
        : renderContactPanel(state, state.live, [
            state.live.openConversation.status === 'ready'
              ? routingSection(
                  state,
                  state.live,
                  state.live.openConversation.value,
                  routingAbility(state.live),
                )
              : null,
            notesSection(state, state.live),
            episodesSection(state, state.live),
          ]),
    ],
  );
}

/**
 * What to show in place of the queue when there is no session to read it with.
 *
 * The frame stays: the columns, the resizer and the thread pane are the screen,
 * and swapping the whole layout for a message would move every control an
 * operator has just learned the position of.
 */
function sessionNotice(state: AppState): Child {
  const live = state.live;
  if (live.session.status === 'unknown') {
    return busy(state);
  }
  if (live.session.status === 'signed_out') {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'تحتاج جلسة', 'You need a session'),
      body: t(
        state,
        'صندوق الوارد يقرأ من الخادم. سجّل الدخول للمتابعة.',
        'The inbox reads from the server. Sign in to continue.',
      ),
      actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
      act: 'live-inbox-reload',
    });
  }
  if (live.session.tenantId === null) {
    return stateBox({
      kind: 'info',
      iconName: 'users',
      title: t(state, 'لا توجد عضوية نشطة', 'No active membership'),
      body: t(
        state,
        'حسابك لا ينتمي إلى شركة نشطة، فلا يوجد صندوق وارد لعرضه.',
        'Your account does not belong to an active company, so there is no inbox to show.',
      ),
    });
  }
  return null;
}

/**
 * The draggable edge of the queue column.
 *
 * A `separator` with a value range, so the width is adjustable from the
 * keyboard as well as by pointer — the column is a working control, not a
 * decoration, and one that only responds to a mouse is not one everybody has.
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

/** Dismiss surface for the list drawer at the widths where it is an overlay. */
function scrim(state: AppState): HTMLElement {
  return h('button', {
    type: 'button',
    class: 'zone-scrim zone-scrim--list',
    'data-act': 'close-overlays',
    'data-arg': 'list',
    'aria-label': t(state, 'إغلاق القائمة', 'Close list'),
    tabindex: '-1',
  });
}

function zone(name: string, label: string, children: readonly Child[]): HTMLElement {
  // `thread` carries the column layout the stylesheet defines for it; the zone
  // classes carry the shell grid. Both are the design system's, not this
  // screen's, so a live inbox and a workspace screen still look like one product.
  const extra = name === 'thread' ? ' thread' : '';
  return h('section', { class: `zone zone--${name}${extra}`, 'aria-label': label }, children);
}

function busy(state: AppState): HTMLElement {
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
  ]);
}

/* ------------------------------------------------------------------- list -- */

function renderListZone(state: AppState, live: LiveState): HTMLElement {
  return zone('list', t(state, 'قائمة المحادثات', 'Conversation list'), [
    h('div', { class: 'listtools' }, [
      h('div', { class: 'listtools__row' }, [
        button({
          label: t(state, 'غير المسندة', 'Unassigned'),
          act: 'live-inbox-queue',
          arg: 'unassigned',
          small: true,
          pressed: state.inboxQueue !== 'mine',
        }),
        button({
          label: t(state, 'محادثاتي', 'Mine'),
          act: 'live-inbox-queue',
          arg: 'mine',
          small: true,
          pressed: state.inboxQueue === 'mine',
        }),
        button({
          label: t(state, 'تحديث', 'Reload'),
          icon: 'refresh',
          act: 'live-inbox-reload',
          small: true,
          disabled: live.busy !== null,
        }),
      ]),
      connectionNotice(state, live),
    ]),
    listResizer(state),
    h('div', { class: 'zone__body' }, [
      sessionNotice(state) ??
        (state.inboxQueue === 'mine' ? mineList(state, live) : queueList(state, live)),
    ]),
  ]);
}

/**
 * What the live connection is doing, in words.
 *
 * A stream that is not delivering looks exactly like an inbox with nothing
 * happening in it. Saying which one it is costs one line and is the difference
 * between waiting and being kept waiting.
 */
function connectionNotice(state: AppState, live: LiveState): Child {
  const realtime = live.realtime;
  if (realtime.status === 'live') {
    return h('p', { class: 'listtools__hint', 'data-realtime': 'live' }, [
      t(state, 'التحديث الحي يعمل.', 'Live updates are on.'),
    ]);
  }
  if (realtime.status === 'stale') {
    return h('p', { class: 'listtools__hint', 'data-realtime': 'stale', role: 'status' }, [
      t(
        state,
        'انقطع التحديث الحي؛ ما تراه لقطة. سنعيد الاتصال.',
        'Live updates dropped; what you see is a snapshot. Reconnecting.',
      ),
    ]);
  }
  if (realtime.status === 'stopped') {
    return h('p', { class: 'listtools__hint', 'data-realtime': 'stopped', role: 'status' }, [
      t(
        state,
        'أُوقف التحديث الحي لأن صلاحيتك تغيّرت. أعد تحميل الشاشة.',
        'Live updates stopped because your access changed. Reload the screen.',
      ),
    ]);
  }
  return null;
}

function queueList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.unassigned,
    {
      title: t(state, 'لا شيء في الانتظار', 'Nothing waiting'),
      body: t(
        state,
        'لا توجد محادثات غير مسندة في صناديق الوارد المسموح لك بها.',
        'No unassigned conversations in the inboxes you can work.',
      ),
    },
    (cards) => h('div', { class: 'convlist', role: 'list' }, cards.map((card) => queueRow(state, card))),
  );
}

function mineList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.conversations,
    {
      title: t(state, 'لا محادثات لديك', 'Nothing assigned to you'),
      body: t(
        state,
        'استلم محادثة من قائمة غير المسندة لتبدأ.',
        'Claim one from the Unassigned queue to start.',
      ),
    },
    (rows) =>
      h(
        'div',
        { class: 'convlist', role: 'list' },
        rows.map((conversation) => conversationRow(state, live, conversation)),
      ),
  );
}

function listBody<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: { title: string; body: string },
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return busy(state);
  }
  if (resource.status === 'error') {
    return errorView(state, resource.error, 'live-inbox-reload');
  }
  if (resource.value.length === 0) {
    return stateBox({ kind: 'empty', iconName: 'inbox', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

/**
 * A queue card.
 *
 * Everything on it came from the server's projection. There is no snippet
 * because there is no snippet to render, and the masked label is the server's
 * masking rather than a substring taken here.
 */
function queueRow(state: AppState, card: QueueCard): HTMLElement {
  return h(
    'article',
    { class: 'convrow convrow--card', role: 'listitem', 'data-conversation': card.id },
    [
      h('div', { class: 'convrow__lead' }, [
        avatar({ initials: initials(card.maskedLabel), channel: channelIcon(card.channel) }),
      ]),
      h('div', { class: 'convrow__body' }, [
        h('div', { class: 'convrow__top' }, [
          h('span', { class: 'convrow__name' }, [isolated(card.maskedLabel)]),
          h('span', { class: 'convrow__time' }, [
            card.waitingSinceAt === null
              ? t(state, 'لم ينتظر بعد', 'Not waiting yet')
              : relativeTime(card.waitingSinceAt, state.clock, state.lang),
          ]),
        ]),
        h('div', { class: 'convrow__meta' }, [
          pill(labelled(state, CHANNEL_LABEL, card.channel)),
          pill(card.inboxLabel),
          priorityPill(state, card.priority),
        ]),
      ]),
      h('div', { class: 'convrow__tail' }, [
        button({
          label: t(state, 'استلام', 'Claim'),
          act: 'live-inbox-claim',
          // The version travels with the click, so the claim carries the
          // version this agent actually saw rather than a fresher one read
          // behind their back — which would defeat the conflict it exists to
          // report (IAM-13).
          arg: `${card.id}:${String(card.version)}`,
          small: true,
          disabled: !card.claimable,
        }),
      ]),
    ],
  );
}

function conversationRow(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  const open = live.openConversationId === conversation.id;
  // `unread` is this caller's own bookkeeping and only the list carries it. A
  // row with no answer is not marked: absent is not the same as read, and
  // guessing would clear a marker nobody moved.
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
      h('div', { class: 'convrow__lead' }, [
        avatar({
          initials: initials(conversation.peerIdentity),
          channel: channelIcon(conversation.channel),
        }),
      ]),
      h('div', { class: 'convrow__body' }, [
        h('div', { class: 'convrow__top' }, [
          h('span', { class: 'convrow__name' }, [isolated(conversation.peerIdentity)]),
          unread
            ? h('span', { class: 'convrow__dot' }, [
                h('span', { class: 'visually-hidden' }, [t(state, 'غير مقروءة', 'Unread')]),
              ])
            : null,
        ]),
        h('div', { class: 'convrow__meta' }, [
          pill(labelled(state, CHANNEL_LABEL, conversation.channel)),
          pill(conversation.inboxLabel),
          statusPill(state, conversation.status),
          // The same cue the queue card carries: an agent triaging their own
          // list needs it as much as one picking work up.
          priorityPill(state, conversation.priority),
        ]),
      ]),
    ],
  );
}

/** The channel's mark. Our own channels have no provider logo, so they get a globe. */
function channelIcon(channel: string): IconName {
  if (channel === 'messenger' || channel === 'instagram' || channel === 'whatsapp') {
    return CHANNEL_ICON[channel];
  }
  return 'globe';
}

/* ----------------------------------------------------------------- thread -- */

function renderThreadZone(state: AppState, live: LiveState): HTMLElement {
  if (sessionNotice(state) !== null) {
    return zone('thread', t(state, 'المحادثة', 'Conversation'), [
      stateBox({
        kind: 'empty',
        iconName: 'inbox',
        title: t(state, 'لا محادثة مفتوحة', 'No conversation open'),
        body: t(
          state,
          'تظهر المحادثة هنا بعد الاتصال بالخادم واختيار واحدة.',
          'A conversation appears here once the server answers and one is picked.',
        ),
      }),
    ]);
  }
  if (live.openConversationId === null) {
    return zone('thread', t(state, 'المحادثة', 'Conversation'), [
      stateBox({
        kind: 'empty',
        iconName: 'inbox',
        title: t(state, 'اختر محادثة', 'Pick a conversation'),
        body: t(
          state,
          'افتح محادثة من القائمة لقراءة سجلّها والرد عليها.',
          'Open one from the list to read its history and reply.',
        ),
      }),
    ]);
  }
  if (live.openConversation.status === 'error') {
    return zone('thread', t(state, 'المحادثة', 'Conversation'), [
      // A permission loss here is a normal outcome of routing — a handoff moves
      // a conversation away, a supervisor reassigns one out from under whoever
      // is reading it — so it is named as such rather than reported as a fault.
      live.lostAccess && isDenial(live.openConversation.error)
        ? movedAway(state)
        : errorView(state, live.openConversation.error, 'live-inbox-reload'),
    ]);
  }
  if (live.openConversation.status !== 'ready') {
    return zone('thread', t(state, 'المحادثة', 'Conversation'), [busy(state)]);
  }

  const conversation = live.openConversation.value;
  return zone('thread', t(state, 'المحادثة', 'Conversation'), [
    threadHeader(state, live, conversation),
    lifecycleForm(state, live, conversation),
    lifecycleNotice(state, conversation),
    timelineView(state, live),
    // An archived conversation is immutable, so it gets no composer. The notice
    // above says why; a disabled box would say only that something is wrong.
    conversation.status === 'archived' ? null : composer(state, live, conversation),
  ]);
}

function threadHeader(
  state: AppState,
  live: LiveState,
  conversation: Conversation,
): HTMLElement {
  return h('header', { class: 'thread__header' }, [
    h('div', { class: 'thread__ident' }, [
      avatar({
        initials: initials(conversation.peerIdentity),
        channel: channelIcon(conversation.channel),
      }),
      h('div', { class: 'thread__names' }, [
        h('h2', { class: 'thread__name' }, [isolated(conversation.peerIdentity)]),
        h('p', { class: 'thread__sub' }, [
          `${labelled(state, CHANNEL_LABEL, conversation.channel)} · ${conversation.inboxLabel}`,
        ]),
      ]),
    ]),
    h('span', { class: 'thread__toolspacer' }),
    h('div', { class: 'thread__toolbar' }, [
      statusPill(state, conversation.status),
      priorityPill(state, conversation.priority),
      lifecycleControls(state, live, conversation),
    ]),
  ]);
}

function timelineView(state: AppState, live: LiveState): Child {
  const timeline = live.timeline;
  if (timeline.status === 'idle' || timeline.status === 'loading') {
    return h('div', { class: 'thread__body' }, [busy(state)]);
  }
  if (timeline.status === 'error') {
    return h('div', { class: 'thread__body' }, [
      errorView(state, timeline.error, 'live-inbox-reload'),
    ]);
  }
  if (timeline.value.length === 0) {
    return h('div', { class: 'thread__body' }, [
      stateBox({
        kind: 'empty',
        iconName: 'inbox',
        title: t(state, 'لا رسائل بعد', 'No messages yet'),
        body: t(state, 'لم يصل شيء في هذه المحادثة.', 'Nothing has arrived in this conversation.'),
      }),
    ]);
  }
  return h(
    'div',
    {
      class: 'thread__body',
      // A scrollable region has to be reachable by keyboard, and a conversation
      // that grows while it is on screen is a log: a screen reader announces
      // additions instead of the reader having to go looking for them.
      role: 'log',
      tabindex: '0',
      'data-scroll': 'timeline',
      'aria-label': t(state, 'سجل المحادثة', 'Conversation log'),
    },
    [
    live.timelineCursor === null
      ? null
      : button({
          label: t(state, 'تحميل الأقدم', 'Load older'),
          act: 'live-inbox-older',
          small: true,
          disabled: live.busy === 'load-older',
        }),
      ...timeline.value.map((message) => messageBubble(state, message)),
    ],
  );
}

function messageBubble(state: AppState, message: TimelineMessage): HTMLElement {
  return h(
    'article',
    {
      class: message.direction === 'out' ? 'msg msg--out' : 'msg',
      'data-message': message.id,
    },
    [
      h('div', { class: 'msg__bubble' }, [message.text ?? '']),
      h('div', { class: 'msg__meta' }, [
        h('span', {}, [clockTime(message.at, state.lang)]),
        ...deliveryNote(state, message),
      ]),
    ],
  );
}

/**
 * What we know about an outbound message, said plainly.
 *
 * Two facts, not one: what we asked the provider to do and what it later said
 * happened. They are separate columns on the server for a reason, and a screen
 * that folded them into a single tick would be inventing agreement between two
 * things that can genuinely disagree.
 */
function deliveryNote(state: AppState, message: TimelineMessage): readonly Child[] {
  if (message.direction === 'in') {
    return [];
  }
  const parts: Child[] = [];
  if (message.command_state !== null) {
    parts.push(
      h('span', { class: 'msg__state' }, [labelled(state, COMMAND_LABEL, message.command_state)]),
    );
  }
  if (message.delivery_state !== null) {
    parts.push(
      h('span', { class: 'msg__delivery' }, [
        labelled(state, DELIVERY_LABEL, message.delivery_state),
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

/**
 * The composer, present only when the caller may actually send.
 *
 * An unclaimed conversation gets a Claim button instead. Rendering a disabled
 * composer would describe a rule the server does not have: it is not that
 * replying is temporarily unavailable, it is that the conversation is not this
 * agent's yet.
 */
function composer(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  if (conversation.assigneeMembershipId === null) {
    return h('div', { class: 'composer composer--claim' }, [
      h('p', { class: 'composer__blocked' }, [
        t(
          state,
          'استلم المحادثة لقراءتها كاملة والرد عليها.',
          'Claim the conversation to read it in full and reply.',
        ),
      ]),
      button({
        label: t(state, 'استلام', 'Claim'),
        act: 'live-inbox-claim',
        arg: `${conversation.id}:${String(conversation.version)}`,
        disabled: live.busy === `claim:${conversation.id}`,
      }),
    ]);
  }
  // The documented budget, unchanged by the rewrite: padding 5 + textarea 44 +
  // gap 3 + toolbar 30 + padding 5 = 87px, inside the 118px cap. Only the
  // textarea grows, and only to 88px.
  return h('div', { class: 'composer' }, [
    // The text is the element's **content**, not a `value` attribute: a
    // textarea ignores that attribute entirely, so rendering it that way would
    // silently empty the composer on every re-render — and a realtime event
    // arriving mid-sentence is a re-render.
    h(
      'textarea',
      {
        class: 'composer__input',
        // One row at rest; the composer grows to fit what is typed, up to the
        // 88px cap. Starting at two would spend a row of the budget on air.
        rows: '1',
        'data-act': 'live-composer',
        'aria-label': t(state, 'نص الرد', 'Reply text'),
        placeholder: t(state, 'اكتب ردًا…', 'Write a reply…'),
      },
      [live.composer],
    ),
    h('div', { class: 'composer__toolbar' }, [
      live.error === null
        ? null
        : h('span', { class: 'composer__hint', role: 'alert' }, [live.error.message]),
      h('span', { class: 'composer__toolspacer' }),
      button({
        label: t(state, 'إرسال', 'Send'),
        act: 'live-inbox-send',
        variant: 'primary',
        small: true,
        disabled: live.busy === 'send-reply' || live.composer.trim() === '',
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------------- states -- */

function errorView(state: AppState, error: ApiError, retryAct: string): HTMLElement {
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
      title: t(state, 'غير مسموح', 'Not permitted'),
      body: t(
        state,
        'دورك لا يصل إلى هذه المحادثة. فقدان صندوق الوارد يلغي الإسناد والمشاركة.',
        'Your role does not reach this conversation. Losing inbox access overrides assignment and participation.',
      ),
    });
  }
  return stateBox({
    kind: 'offline',
    iconName: 'refresh',
    title: t(state, 'تعذّر الوصول للخادم', 'The server could not be reached'),
    body: error.message,
    actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
    act: retryAct,
  });
}
