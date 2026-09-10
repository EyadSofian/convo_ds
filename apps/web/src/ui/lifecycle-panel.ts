import type { Conversation, Episode, Note } from '../api/conversations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { futureTime, relativeTime } from '../format.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { button, isolated, pill, stateBox } from './parts.js';
import type { Tone } from './parts.js';

/**
 * The lifecycle controls, the private notes and the reporting episodes.
 *
 * Three surfaces that answer three different questions about the same
 * conversation — where is it, what do we say to each other about it, and how
 * long has each attempt at it taken — and they are kept apart on screen for the
 * same reason they are kept apart in the schema.
 *
 * The rule that shapes this file: **an offered control is a control the
 * lifecycle table permits.** The availability map below is the browser's copy
 * of §18.1, and it is not trusted to stay in step by inspection — a unit test
 * regenerates it from `applyTrigger` in `@convo/domain` and fails on any
 * divergence. A button that is always refused is worse than a missing one: it
 * teaches an operator that the software is unreliable rather than that the
 * conversation has moved.
 *
 * The server still decides. This map only chooses what to *offer*; permission,
 * the version fence and the refusals live where they can be enforced.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

/** The five agent-driven commands, in the order they are offered. */
export const LIFECYCLE_COMMANDS = ['wait', 'snooze', 'resolve', 'reopen', 'archive'] as const;

export type LifecycleCommandName = (typeof LIFECYCLE_COMMANDS)[number];

/**
 * Which commands do something from each status.
 *
 * "Do something" is the test, not merely "is not refused": resolving an already
 * resolved conversation is *permitted* by the table and changes nothing, so
 * offering it would be offering a no-op. Re-snoozing a snoozed conversation
 * changes no status either, but it invalidates the wake job and schedules a new
 * one — so it stays.
 *
 * `archived` maps to nothing at all. An archived conversation is immutable, and
 * the header says so in words rather than showing five controls that all refuse.
 */
interface StatusView {
  readonly ar: string;
  readonly en: string;
  readonly tone: Tone;
  readonly commands: readonly LifecycleCommandName[];
}

const STATUS_VIEW: Readonly<Record<string, StatusView>> = {
  open: { ar: 'مفتوحة', en: 'Open', tone: 'accent', commands: ['wait', 'snooze', 'resolve'] },
  pending: {
    ar: 'بانتظار العميل',
    en: 'Waiting on customer',
    tone: 'warning',
    commands: ['snooze', 'resolve'],
  },
  snoozed: { ar: 'مؤجّلة', en: 'Snoozed', tone: 'neutral', commands: ['snooze', 'resolve'] },
  resolved: {
    ar: 'مُغلقة',
    en: 'Resolved',
    tone: 'success',
    commands: ['snooze', 'reopen', 'archive'],
  },
  archived: { ar: 'مؤرشفة', en: 'Archived', tone: 'neutral', commands: [] },
};

/**
 * The one place an unrecognised status is handled.
 *
 * The column has a CHECK constraint naming exactly these five, so a status this
 * build has never heard of means the server is ahead of the browser. It is
 * shown verbatim and offered no controls — a guess at which transitions a
 * status we cannot name allows would be a guess at somebody's data.
 */
function viewOf(status: string): StatusView {
  return STATUS_VIEW[status] ?? { ar: status, en: status, tone: 'neutral', commands: [] };
}

/** The availability half of the table above, for the test that regenerates it. */
export const COMMANDS_FOR: Readonly<Record<string, readonly LifecycleCommandName[]>> =
  Object.fromEntries(
    Object.entries(STATUS_VIEW).map(([status, view]) => [status, view.commands]),
  );

/** The commands that need something typed before they can be sent. */
const NEEDS_INPUT: Readonly<Record<LifecycleCommandName, boolean>> = {
  wait: true,
  snooze: true,
  resolve: true,
  reopen: false,
  archive: false,
};

const COMMAND_LABEL: Readonly<Record<LifecycleCommandName, { ar: string; en: string }>> = {
  wait: { ar: 'بانتظار العميل', en: 'Waiting on customer' },
  snooze: { ar: 'تأجيل', en: 'Snooze' },
  resolve: { ar: 'إغلاق', en: 'Resolve' },
  reopen: { ar: 'إعادة فتح', en: 'Reopen' },
  archive: { ar: 'أرشفة', en: 'Archive' },
};

export function statusPill(state: AppState, status: string): HTMLElement {
  const view = viewOf(status);
  return pill(t(state, view.ar, view.en), view.tone);
}

/* -------------------------------------------------------------- controls -- */

/**
 * The lifecycle controls for the open conversation.
 *
 * A control that opens a panel is `aria-expanded`, and only one panel is open
 * at a time — two forms side by side in a header this dense is how somebody
 * types a snooze reason into a resolution.
 */
export function lifecycleControls(
  state: AppState,
  live: LiveState,
  conversation: Conversation,
): Child {
  const commands = viewOf(conversation.status).commands;
  if (commands.length === 0) {
    return null;
  }
  const busy = live.busy === `lifecycle:${conversation.id}`;
  return h(
    'div',
    { class: 'lifecycle__controls', role: 'group', 'aria-label': t(state, 'حالة المحادثة', 'Conversation state') },
    commands.map((command) => {
      const label = COMMAND_LABEL[command];
      const opens = NEEDS_INPUT[command];
      return button({
        label: t(state, label.ar, label.en),
        act: opens ? 'live-lifecycle-open' : 'live-lifecycle-do',
        arg: command,
        small: true,
        variant: command === 'archive' ? 'ghost' : 'default',
        disabled: busy,
        ...(opens ? { expanded: live.lifecyclePanel === command } : {}),
      });
    }),
  );
}

/**
 * The expanded form for whichever control is open.
 *
 * Rendered below the header rather than in a popover: it carries a text field
 * an operator may spend a minute on, and a layer that closes when focus leaves
 * would lose it.
 */
export function lifecycleForm(state: AppState, live: LiveState, conversation: Conversation): Child {
  const open = live.lifecyclePanel;
  if (open === null || !viewOf(conversation.status).commands.includes(open)) {
    return null;
  }
  const busy = live.busy === `lifecycle:${conversation.id}`;
  const label = COMMAND_LABEL[open];
  return h('form', { class: 'lifecycle__form', 'data-lifecycle': open }, [
    h('p', { class: 'lifecycle__prompt' }, [promptFor(state, open)]),
    ...bodyFor(state, open),
    h('div', { class: 'lifecycle__formactions' }, [
      button({
        label: t(state, 'إلغاء', 'Cancel'),
        act: 'live-lifecycle-close',
        small: true,
        variant: 'ghost',
      }),
      button({
        label: t(state, label.ar, label.en),
        act: 'live-lifecycle-do',
        arg: open,
        small: true,
        variant: 'primary',
        disabled: busy,
      }),
    ]),
  ]);
}

function promptFor(state: AppState, command: LifecycleCommandName): string {
  if (command === 'wait') {
    return t(
      state,
      'ما الذي ننتظره من العميل؟ يبقى النص داخليًا ويظهر لزملائك في القائمة.',
      'What are we waiting on the customer for? This stays internal and shows to your colleagues in the list.',
    );
  }
  if (command === 'snooze') {
    return t(
      state,
      'متى تعود المحادثة؟ تختفي من القائمة حتى ذلك الوقت، وتعود فورًا إن راسلنا العميل قبله.',
      'When should this come back? It leaves the list until then, and returns immediately if the customer writes before that.',
    );
  }
  return t(
    state,
    'بماذا انتهت؟ يُسجَّل هذا مع الحلقة الحالية ويظهر في التقارير.',
    'How did it end? This is recorded with the current episode and shows in reports.',
  );
}

function bodyFor(state: AppState, command: LifecycleCommandName): readonly Child[] {
  if (command === 'wait') {
    return [
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'السبب', 'Reason')]),
        h('input', {
          class: 'input',
          type: 'text',
          maxlength: '500',
          'data-act': 'form',
          'data-form': 'lifecycleReason',
          placeholder: t(state, 'بانتظار رقم الطلب', 'Waiting for their order number'),
        }),
      ]),
    ];
  }
  if (command === 'snooze') {
    return [
      h(
        'div',
        { class: 'lifecycle__presets', role: 'group', 'aria-label': t(state, 'مدد جاهزة', 'Preset delays') },
        SNOOZE_PRESETS.map((preset) =>
          button({
            label: t(state, preset.ar, preset.en),
            act: 'live-lifecycle-do',
            arg: `snooze:${String(preset.minutes)}`,
            small: true,
          }),
        ),
      ),
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'أو وقت محدّد', 'Or a specific time')]),
        h('input', {
          class: 'input',
          type: 'datetime-local',
          'data-act': 'form',
          'data-form': 'lifecycleWakeAt',
        }),
      ]),
      // The zone is shown, not chosen. It is a fact about this browser, and a
      // picker would invite somebody to pick one they are not sitting in —
      // which is how "tomorrow morning" becomes 3am for the person on call.
      h('p', { class: 'field__hint' }, [
        t(state, 'بتوقيت ', 'In ') + browserTimezone(),
      ]),
    ];
  }
  return [
    h('label', { class: 'field' }, [
      h('span', { class: 'field__label' }, [t(state, 'الخلاصة', 'Resolution')]),
      h('input', {
        class: 'input',
        type: 'text',
        maxlength: '120',
        'data-act': 'form',
        'data-form': 'lifecycleResolution',
        placeholder: t(state, 'أُرسل بديل الطلب', 'Replacement order sent'),
      }),
    ]),
  ];
}

/**
 * Delays offered as plain offsets from now.
 *
 * Offsets rather than calendar points on purpose: "in three hours" is one
 * instant in every timezone, while "tomorrow morning" is a calendar question
 * whose answer depends on a zone, a working day and a DST rule. That belongs to
 * a caller who knows all three, not to arithmetic in a browser — so the custom
 * field takes a real datetime instead of this list pretending to.
 */
export const SNOOZE_PRESETS: readonly { minutes: number; ar: string; en: string }[] = [
  { minutes: 60, ar: 'ساعة', en: '1 hour' },
  { minutes: 180, ar: '3 ساعات', en: '3 hours' },
  { minutes: 1440, ar: 'يوم', en: '1 day' },
];

/** The zone this browser believes it is in. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* ----------------------------------------------------------- state notice -- */

/**
 * What the current status actually means, in the words the operator chose.
 *
 * A `pending` pill says the conversation is waiting; only the reason says what
 * for, and the reason is the whole value of having pressed the button.
 */
export function lifecycleNotice(state: AppState, conversation: Conversation): Child {
  if (conversation.status === 'pending' && conversation.pendingReason !== null) {
    return h('p', { class: 'lifecycle__notice', role: 'status' }, [
      h('span', { class: 'lifecycle__noticekey' }, [t(state, 'بانتظار', 'Waiting on')]),
      isolated(conversation.pendingReason),
    ]);
  }
  if (conversation.status === 'snoozed' && conversation.snoozedUntil !== null) {
    return h('p', { class: 'lifecycle__notice', role: 'status' }, [
      h('span', { class: 'lifecycle__noticekey' }, [t(state, 'تعود', 'Returns')]),
      futureTime(conversation.snoozedUntil, state.clock, state.lang),
      conversation.snoozeTimezone === null
        ? null
        : h('span', { class: 'lifecycle__noticezone' }, [conversation.snoozeTimezone]),
    ]);
  }
  if (conversation.status === 'resolved' && conversation.resolution !== null) {
    return h('p', { class: 'lifecycle__notice', role: 'status' }, [
      h('span', { class: 'lifecycle__noticekey' }, [t(state, 'انتهت بـ', 'Ended with')]),
      isolated(conversation.resolution),
    ]);
  }
  if (conversation.status === 'archived') {
    return h('p', { class: 'lifecycle__notice', role: 'status' }, [
      t(
        state,
        'مؤرشفة: سجلّها محفوظ كما هو ولا يتغيّر. رسالة جديدة من العميل تفتح محادثة أخرى.',
        'Archived: its history is kept exactly as it was. A new message from the customer opens another conversation.',
      ),
    ]);
  }
  return null;
}

/* ------------------------------------------------------------------ notes -- */

/**
 * The private notes.
 *
 * A separate composer from the reply box, always, and labelled on the control
 * itself rather than only by the heading above it. One field that sends to two
 * places is how "customer is being difficult" reaches the customer.
 */
export function notesSection(state: AppState, live: LiveState): HTMLElement {
  const id = live.openConversationId;
  const busy = id !== null && live.busy === `note:${id}`;
  return h('section', { class: 'notes', 'aria-label': t(state, 'ملاحظات داخلية', 'Internal notes') }, [
    h('h3', { class: 'contact__heading' }, [t(state, 'ملاحظات داخلية', 'Internal notes')]),
    h('p', { class: 'field__hint' }, [
      t(
        state,
        'لا يراها العميل ولا تُرسل إلى أي قناة.',
        'The customer never sees these, and they are never sent to any channel.',
      ),
    ]),
    notesBody(state, live),
    h('div', { class: 'notes__composer' }, [
      // The text is a child, not a `value` attribute: a textarea ignores the
      // attribute, so the draft would be wiped by every re-render — and a
      // realtime event arriving mid-sentence would delete what was being typed.
      h('textarea', {
        class: 'input notes__field',
        rows: '2',
        maxlength: '4000',
        'data-act': 'live-note-draft',
        'aria-label': t(state, 'ملاحظة داخلية جديدة', 'A new internal note'),
        placeholder: t(state, 'ملاحظة لزملائك…', 'A note for your colleagues…'),
      }, [live.noteDraft]),
      button({
        label: t(state, 'أضف ملاحظة', 'Add note'),
        act: 'live-note-add',
        small: true,
        disabled: busy || live.noteDraft.trim() === '',
      }),
    ]),
  ]);
}

function notesBody(state: AppState, live: LiveState): Child {
  const notes = live.notes;
  if (notes.status === 'idle' || notes.status === 'loading') {
    return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
      h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
      h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
    ]);
  }
  if (notes.status === 'error') {
    return stateBox({
      kind: 'offline',
      iconName: 'refresh',
      title: t(state, 'تعذّر تحميل الملاحظات', 'The notes could not be loaded'),
      body: notes.error.message,
      actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
      act: 'live-notes-reload',
    });
  }
  if (notes.value.length === 0) {
    return h('p', { class: 'field__hint' }, [
      t(state, 'لا ملاحظات بعد.', 'No notes yet.'),
    ]);
  }
  return h(
    'ul',
    { class: 'notes__list' },
    notes.value.map((note) => noteRow(state, live, note)),
  );
}

function noteRow(state: AppState, live: LiveState, note: Note): HTMLElement {
  // A deleted note keeps its place. The row says a note was removed rather than
  // closing the gap silently: a conversation that quietly loses an internal
  // remark is a conversation nobody can reconstruct afterwards.
  if (note.deletedAt !== null) {
    return h('li', { class: 'notes__item notes__item--deleted' }, [
      h('p', { class: 'notes__body' }, [
        t(state, 'حُذفت ملاحظة ', 'A note was deleted '),
        relativeTime(note.deletedAt, state.clock, state.lang),
      ]),
    ]);
  }
  const busy = live.busy === `note:${note.id}`;
  if (live.editingNoteId === note.id) {
    return h('li', { class: 'notes__item notes__item--editing' }, [
      h('textarea', {
        class: 'input notes__field',
        rows: '2',
        maxlength: '4000',
        'data-act': 'live-note-edit-draft',
        'aria-label': t(state, 'تصحيح الملاحظة', 'Correct the note'),
      }, [live.noteEdit]),
      h('div', { class: 'notes__meta' }, [
        button({
          label: t(state, 'إلغاء', 'Cancel'),
          act: 'live-note-edit-cancel',
          small: true,
          variant: 'ghost',
        }),
        button({
          label: t(state, 'حفظ', 'Save'),
          act: 'live-note-edit-save',
          arg: note.id,
          small: true,
          disabled: busy || live.noteEdit.trim() === '',
        }),
      ]),
    ]);
  }
  return h('li', { class: 'notes__item' }, [
    h('p', { class: 'notes__body' }, [isolated(note.body)]),
    h('div', { class: 'notes__meta' }, [
      h('span', { class: 'notes__when' }, [
        relativeTime(note.createdAt, state.clock, state.lang),
      ]),
      note.editedAt === null
        ? null
        : // Marked, always: a corrected remark must not read as the one that
          // was there when the decision it describes was taken.
          h('span', { class: 'notes__edited' }, [t(state, 'مُعدّلة', 'edited')]),
      button({
        label: t(state, 'تعديل', 'Edit'),
        act: 'live-note-edit',
        arg: note.id,
        small: true,
        variant: 'ghost',
        disabled: busy,
      }),
      button({
        label: t(state, 'حذف', 'Delete'),
        act: 'live-note-delete',
        arg: note.id,
        small: true,
        variant: 'ghost',
        disabled: busy,
      }),
    ]),
  ]);
}

/* --------------------------------------------------------------- episodes -- */

/**
 * The reporting episodes, oldest first.
 *
 * One row per time this conversation was worked: a reopen starts a new one
 * rather than reusing the first, which is the only way a resolution-time report
 * can be true. Showing them is how an agent can see that the "4 minutes" on a
 * report is this episode's four minutes and not the whole thread's.
 */
export function episodesSection(state: AppState, live: LiveState): Child {
  const episodes = live.episodes;
  if (episodes.status !== 'ready' || episodes.value.length === 0) {
    // Absent rather than empty: every conversation has at least one episode, so
    // "none" only ever means "not loaded", and an empty box saying so teaches
    // nothing.
    return null;
  }
  return h('section', { class: 'episodes', 'aria-label': t(state, 'حلقات المتابعة', 'Reporting episodes') }, [
    h('h3', { class: 'contact__heading' }, [t(state, 'حلقات المتابعة', 'Reporting episodes')]),
    h(
      'ol',
      { class: 'episodes__list' },
      episodes.value.map((episode) => episodeRow(state, episode, episodes)),
    ),
  ]);
}

function episodeRow(
  state: AppState,
  episode: Episode,
  all: Resource<readonly Episode[]>,
): HTMLElement {
  const isCurrent = all.status === 'ready' && all.value.at(-1)?.id === episode.id;
  return h('li', { class: 'episodes__item' }, [
    h('div', { class: 'episodes__top' }, [
      h('span', { class: 'episodes__seq' }, [`#${String(episode.seq)}`]),
      episode.closedAt === null
        ? pill(t(state, 'جارية', 'Open'), isCurrent ? 'accent' : 'neutral')
        : pill(t(state, 'مُغلقة', 'Closed'), 'success'),
      h('span', { class: 'episodes__when' }, [
        relativeTime(episode.openedAt, state.clock, state.lang),
      ]),
    ]),
    episode.resolution === null
      ? null
      : h('p', { class: 'episodes__resolution' }, [isolated(episode.resolution)]),
    h('dl', { class: 'attrgrid' }, [
      h('dt', {}, [t(state, 'أول رسالة', 'First message')]),
      h('dd', {}, [absentOr(state, episode.firstInboundAt)]),
      h('dt', {}, [t(state, 'أول ردّ', 'First response')]),
      h('dd', {}, [absentOr(state, episode.firstResponseAt)]),
    ]),
  ]);
}

function absentOr(state: AppState, at: string | null): Child {
  // An em dash, not a zero and not "now": a clock that never started is a
  // different fact from one that started at the beginning of time.
  return at === null ? '—' : relativeTime(at, state.clock, state.lang);
}
