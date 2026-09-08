import { selectedId, windowMinutesLeft } from '../actions';
import type { ConversationRecord, DeliveryState, TimelineItem } from '../data';
import type { Child } from '../dom';
import { h } from '../dom';
import type { FilterContext, QueueSegment } from '../filters';
import {
  activeChips,
  activeFilterCount,
  CHANNEL_VALUES,
  channelLabel,
  DATE_VALUES,
  dateLabel,
  labelName,
  PRIORITY_VALUES,
  priorityLabel,
  QUEUE_SEGMENTS,
  queueLabel,
  SLA_VALUES,
  slaLabel,
  SORT_VALUES,
  sortLabel,
  STATUS_VALUES,
  statusLabel,
  applyFilter,
  segmentCounts,
  UNASSIGNED_TOKEN,
} from '../filters';
import {
  clockTime,
  conversationCount,
  dayLabel,
  durationLabel,
  formatNumber,
  initials,
  minutesSince,
  relativeTime,
} from '../format';
import type { IconName } from '../icons';
import { icon } from '../icons';
import { canAssignOthers, canOpenInbox, conversationAccess } from '../permissions';
import type { ListCard } from '../projection';
import { contactNameFor, projectCard, projectThread, visibleConversations } from '../projection';
import type { AppState } from '../state';
import {
  currentActor,
  findConversation,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  readDraft,
} from '../state';
import {
  anchored,
  avatar,
  banner,
  button,
  CHANNEL_ICON,
  countBadge,
  isolated,
  notice,
  pill,
  popover,
  segment,
  skeletonList,
  stateBox,
  switchControl,
  type PopoverOption,
  type Tone,
} from './parts';

const PRIORITY_TONE: Record<string, Tone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

const SLA_TONE: Record<string, Tone> = {
  breached: 'danger',
  due: 'warning',
  healthy: 'success',
  none: 'neutral',
};

const STATUS_TONE: Record<string, Tone> = {
  open: 'accent',
  pending: 'warning',
  snoozed: 'unknown',
  resolved: 'success',
};

export interface InboxModel {
  readonly state: AppState;
  readonly context: FilterContext;
  readonly visible: readonly ConversationRecord[];
  readonly filtered: readonly ConversationRecord[];
  readonly cards: readonly ListCard[];
  readonly counts: Record<QueueSegment, number>;
  readonly selected: ConversationRecord | null;
  readonly denied: boolean;
  readonly loading: boolean;
  readonly stale: boolean;
}

export function buildInboxModel(state: AppState): InboxModel {
  const actor = currentActor(state);
  const context: FilterContext = {
    // Live working copies, not the seed: messages sent in this session live in
    // `state.timelines` and assignments in `state.conversations`.
    dataset: { ...state.dataset, conversations: state.conversations, timelines: state.timelines },
    actorId: actor.memberId,
    now: state.dataset.now,
    lang: state.lang,
  };
  const visible = visibleConversations(context.dataset, actor);
  const loading = state.preview === 'loading';
  const forcedEmpty = state.preview === 'empty';
  const filtered = forcedEmpty ? [] : applyFilter(visible, state.filter, context);
  const cards = filtered
    .map((record) => projectCard(record, actor, contactNameFor(context.dataset, record.contactId)))
    .filter((card): card is ListCard => card !== null);
  const chosen = selectedId(state);
  const selected =
    chosen === null ? null : (filtered.find((entry) => entry.id === chosen) ??
      findConversation(state, chosen) ??
      null);
  return {
    state,
    context,
    visible,
    filtered,
    cards,
    counts: segmentCounts(visible, actor.memberId),
    selected: forcedEmpty ? null : selected,
    denied: state.preview === 'denied',
    loading,
    stale: state.preview === 'offline',
  };
}

/** The conversation the inbox should show when the route names none. */
export function defaultConversationId(state: AppState): string | null {
  const model = buildInboxModel(state);
  return model.filtered[0]?.id ?? null;
}

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

function memberName(model: InboxModel, id: string): string {
  const member = model.context.dataset.members.find((entry) => entry.id === id);
  if (member === undefined) return id;
  return model.state.lang === 'ar' ? member.name : member.nameEn;
}

function inboxName(model: InboxModel, id: string): string {
  const inbox = model.context.dataset.inboxes.find((entry) => entry.id === id);
  if (inbox === undefined) return id;
  return model.state.lang === 'ar' ? inbox.name : inbox.nameEn;
}

function teamName(model: InboxModel, id: string): string {
  const team = model.context.dataset.teams.find((entry) => entry.id === id);
  if (team === undefined) return id;
  return model.state.lang === 'ar' ? team.name : team.nameEn;
}

/* ------------------------------------------------------------------ views -- */

interface ViewGroupSpec {
  readonly id: string;
  readonly title: string;
  readonly addAct?: string;
  readonly rows: readonly HTMLElement[];
}

function viewItem(options: {
  readonly label: string;
  readonly iconName: IconName;
  readonly act: string;
  readonly arg: string;
  readonly current: boolean;
  readonly count?: number;
  readonly scope?: string;
  readonly trailing?: HTMLElement;
}): HTMLElement {
  return h('div', { class: 'viewrow' }, [
    h(
      'button',
      {
        type: 'button',
        class: 'viewitem',
        'data-act': options.act,
        'data-arg': options.arg,
        'aria-current': String(options.current),
      },
      [
        h('span', { class: 'viewitem__icon' }, [icon(options.iconName, 14)]),
        h('span', { class: 'viewitem__label', title: options.label }, [options.label]),
        options.scope === undefined ? null : h('span', { class: 'viewitem__scope' }, [options.scope]),
        options.count === undefined ? null : countBadge(options.count),
      ],
    ),
    options.trailing,
  ]);
}

function viewGroup(model: InboxModel, spec: ViewGroupSpec): HTMLElement {
  const collapsed = model.state.collapsedGroups.includes(spec.id);
  return h('section', { class: 'viewgroup' }, [
    h('div', { class: 'viewgroup__bar' }, [
      h(
        'button',
        {
          type: 'button',
          class: 'viewgroup__header',
          'data-act': 'group',
          'data-arg': spec.id,
          'aria-expanded': String(!collapsed),
        },
        [
          h('span', { class: 'viewgroup__chevron' }, [icon('chevronDown', 12)]),
          h('span', {}, [spec.title]),
          h('span', { class: 'viewgroup__spacer' }),
        ],
      ),
      spec.addAct === undefined
        ? null
        : h(
            'button',
            {
              type: 'button',
              class: 'viewgroup__add',
              'data-act': 'dialog',
              'data-arg': spec.addAct,
              title: t(model.state, 'حفظ الفلاتر الحالية كعرض', 'Save current filters as a view'),
              'aria-label': t(model.state, 'حفظ عرض جديد', 'Save a new view'),
            },
            [icon('plus', 12)],
          ),
    ]),
    collapsed ? null : h('div', { class: 'viewgroup__list' }, spec.rows),
  ]);
}

function renderViewsColumn(model: InboxModel): HTMLElement {
  const state = model.state;
  const standard: QueueSegment[] = ['all', 'mine', 'unassigned'];
  const standardIcons: Record<QueueSegment, IconName> = {
    all: 'inbox',
    unread: 'inbox',
    read: 'check',
    mine: 'user',
    unassigned: 'users',
  };
  const groups: ViewGroupSpec[] = [
    {
      id: 'g-standard',
      title: t(state, 'قوائم قياسية', 'Standard'),
      rows: standard.map((value) =>
        viewItem({
          label: queueLabel(value, state.lang),
          iconName: standardIcons[value],
          act: 'queue',
          arg: value,
          current: state.filter.queue === value && state.activeViewId === null,
          count: model.counts[value],
        }),
      ),
    },
    {
      id: 'g-inboxes',
      title: t(state, 'صناديق الوارد', 'Inboxes'),
      rows: model.context.dataset.inboxes.map((inbox) =>
        viewItem({
          label: model.state.lang === 'ar' ? inbox.name : inbox.nameEn,
          iconName: CHANNEL_ICON[inbox.channel],
          act: 'toggle-filter',
          arg: `inboxes:${inbox.id}`,
          current: state.filter.inboxes.includes(inbox.id),
          count: model.visible.filter((entry) => entry.inboxId === inbox.id).length,
        }),
      ),
    },
    {
      id: 'g-teams',
      title: t(state, 'الفرق', 'Teams'),
      rows: model.context.dataset.teams.map((team) =>
        viewItem({
          label: model.state.lang === 'ar' ? team.name : team.nameEn,
          iconName: 'users',
          act: 'toggle-filter',
          arg: `teams:${team.id}`,
          current: state.filter.teams.includes(team.id),
          count: model.visible.filter((entry) => entry.teamId === team.id).length,
        }),
      ),
    },
    {
      id: 'g-views',
      title: t(state, 'عروض محفوظة', 'Saved views'),
      addAct: 'save-view',
      rows: state.views.map((view) =>
        viewItem({
          label: state.lang === 'ar' ? view.name : view.nameEn,
          iconName: 'bookmark',
          act: 'view',
          arg: view.id,
          current: state.activeViewId === view.id,
          scope: t(
            state,
            { private: 'خاص', team: 'فريق', workspace: 'الجميع' }[view.scope],
            { private: 'Private', team: 'Team', workspace: 'Workspace' }[view.scope],
          ),
          trailing: h(
            'button',
            {
              type: 'button',
              class: 'viewitem__action',
              'data-act': 'delete-view',
              'data-arg': view.id,
              title: t(state, `حذف العرض ${view.name}`, `Delete view ${view.nameEn}`),
              'aria-label': t(state, `حذف العرض ${view.name}`, `Delete view ${view.nameEn}`),
            },
            [icon('close', 12)],
          ),
        }),
      ),
    },
  ];

  return h('section', { class: 'zone zone--views', 'aria-label': t(state, 'العروض', 'Views') }, [
    h('div', { class: 'zone__header' }, [
      h('h2', { class: 'zone__title' }, [t(state, 'مساحة العمل', 'Workspace')]),
      h('span', { class: 'card__spacer' }),
      button({
        icon: 'close',
        act: 'sidebar',
        variant: 'ghost',
        small: true,
        title: t(state, 'إغلاق القائمة', 'Close list'),
        extraClass: 'views-close',
      }),
    ]),
    h('div', { class: 'zone__body' }, [h('div', { class: 'views' }, groups.map((spec) => viewGroup(model, spec)))]),
  ]);
}

/* -------------------------------------------------------------------- list -- */

function filterMenu(model: InboxModel, id: string, title: string, options: readonly PopoverOption[], act: string): HTMLElement | null {
  return model.state.openMenu === id ? popover(title, options, act) : null;
}

function assigneeOptions(model: InboxModel): readonly PopoverOption[] {
  const chosen = model.state.filter.assignees;
  return [
    {
      label: t(model.state, 'غير مُسندة', 'Unassigned'),
      value: `assignees:${UNASSIGNED_TOKEN}`,
      checked: chosen.includes(UNASSIGNED_TOKEN),
    },
    ...model.context.dataset.members
      .filter((member) => member.inboxIds.length > 0)
      .map((member) => ({
        label: model.state.lang === 'ar' ? member.name : member.nameEn,
        value: `assignees:${member.id}`,
        checked: chosen.includes(member.id),
        hint: String(member.openLoad),
      })),
  ];
}

function renderListTools(model: InboxModel): HTMLElement {
  const state = model.state;
  const count = activeFilterCount(state.filter);
  const chips = activeChips(state.filter, model.context);
  return h('div', { class: 'listtools' }, [
    h('div', { class: 'listtools__row' }, [
      h('span', { class: 'searchbox', style: 'flex:1 1 auto' }, [
        h('span', { class: 'searchbox__icon' }, [icon('search', 14)]),
        h('input', {
          class: 'input',
          type: 'search',
          value: state.filter.query,
          placeholder: t(state, 'ابحث بالاسم أو الرقم أو CV-…', 'Search name, number or CV-…'),
          'aria-label': t(state, 'بحث في المحادثات', 'Search conversations'),
          'data-act': 'search',
        }),
      ]),
    ]),
    segment(
      QUEUE_SEGMENTS.map((value) => ({
        value,
        label: queueLabel(value, state.lang),
        count: model.counts[value],
      })),
      state.filter.queue,
      'queue',
      t(state, 'تصفية سريعة', 'Quick segments'),
    ),
    h('div', { class: 'filterbar' }, [
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'f-assignee',
            'aria-expanded': String(state.openMenu === 'f-assignee'),
            'data-active': String(state.filter.assignees.length > 0),
          },
          [
            icon('assign', 12),
            t(state, 'الموظف', 'Assignee'),
            state.filter.assignees.length === 0
              ? null
              : h('span', { class: 'filterbtn__count' }, [String(state.filter.assignees.length)]),
            icon('chevronDown', 11),
          ],
        ),
        filterMenu(
          model,
          'f-assignee',
          t(state, 'الموظف المسؤول', 'Assigned employee'),
          assigneeOptions(model),
          'toggle-filter',
        ),
      ]),
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'f-status',
            'aria-expanded': String(state.openMenu === 'f-status'),
            'data-active': String(state.filter.statuses.length > 0),
          },
          [t(state, 'الحالة', 'Status'), icon('chevronDown', 11)],
        ),
        filterMenu(
          model,
          'f-status',
          t(state, 'حالة المحادثة', 'Conversation status'),
          STATUS_VALUES.map((value) => ({
            label: statusLabel(value, state.lang),
            value: `statuses:${value}`,
            checked: state.filter.statuses.includes(value),
          })),
          'toggle-filter',
        ),
      ]),
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'f-channel',
            'aria-expanded': String(state.openMenu === 'f-channel'),
            'data-active': String(state.filter.channels.length > 0),
          },
          [t(state, 'القناة', 'Channel'), icon('chevronDown', 11)],
        ),
        filterMenu(
          model,
          'f-channel',
          t(state, 'القناة', 'Channel'),
          CHANNEL_VALUES.map((value) => ({
            label: channelLabel(value, state.lang),
            value: `channels:${value}`,
            checked: state.filter.channels.includes(value),
          })),
          'toggle-filter',
        ),
      ]),
      h(
        'button',
        {
          type: 'button',
          class: 'filterbtn',
          'data-act': 'dialog',
          'data-arg': 'filters',
          'data-active': String(count > 0),
        },
        [
          icon('filter', 12),
          t(state, 'مرشّحات', 'Filters'),
          count === 0 ? null : h('span', { class: 'filterbtn__count' }, [String(count)]),
        ],
      ),
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'f-sort',
            'aria-expanded': String(state.openMenu === 'f-sort'),
          },
          [t(state, 'ترتيب', 'Sort'), icon('chevronDown', 11)],
        ),
        filterMenu(
          model,
          'f-sort',
          t(state, 'الترتيب', 'Sort order'),
          SORT_VALUES.map((value) => ({
            label: sortLabel(value, state.lang),
            value,
            checked: state.filter.sort === value,
          })),
          'sort',
        ),
      ]),
    ]),
    chips.length === 0
      ? null
      : h('div', { class: 'chipbar' }, [
          ...chips.map((chip) =>
            h('span', { class: 'chip' }, [
              h('span', { class: 'chip__label' }, [chip.label]),
              h(
                'button',
                {
                  type: 'button',
                  class: 'chip__remove',
                  'data-act': chip.key === 'query' ? 'search' : chip.key === 'date' ? 'date' : 'toggle-filter',
                  'data-arg': chip.key === 'query' ? '' : chip.key === 'date' ? 'any' : `${chip.key}:${chip.value}`,
                  'aria-label': t(state, `إزالة ${chip.label}`, `Remove ${chip.label}`),
                },
                [icon('close', 10)],
              ),
            ]),
          ),
          h('button', { type: 'button', class: 'chipbar__clear', 'data-act': 'clear-filters' }, [
            t(state, 'مسح الكل', 'Clear all'),
          ]),
        ]),
  ]);
}

function conversationRow(model: InboxModel, card: ListCard): HTMLElement {
  const state = model.state;
  const selected = selectedId(state) === card.id;
  const unread = card.access === 'full' && card.unreadCount > 0;
  const classes = ['convrow'];
  if (unread) classes.push('convrow--unread');

  const meta: HTMLElement[] = [];
  if (card.status !== 'open') {
    meta.push(pill(statusLabel(card.status, state.lang), STATUS_TONE[card.status]));
  }
  if (card.priority === 'urgent' || card.priority === 'high') {
    meta.push(pill(priorityLabel(card.priority, state.lang), PRIORITY_TONE[card.priority], 'flag'));
  }

  if (card.access === 'queue') {
    const waited = minutesSince(card.waitingSinceAt, model.context.now);
    meta.push(pill(durationLabel(waited, state.lang), waited > 45 ? 'danger' : 'warning', 'clock'));
    return h(
      'button',
      {
        type: 'button',
        class: classes.join(' '),
        'data-act': 'open',
        'data-arg': card.id,
        'aria-current': String(selected),
      },
      [
        avatar({ initials: '••', channel: CHANNEL_ICON[card.channel] }),
        h('span', { class: 'convrow__body' }, [
          h('span', { class: 'convrow__top' }, [
            h('span', { class: 'convrow__name' }, [isolated(card.maskedLabel)]),
            h('span', { class: 'convrow__time' }, [
              isolated(relativeTime(card.lastActivityAt, model.context.now, state.lang)),
            ]),
          ]),
          // No snippet exists on a queue card — the type has no such field.
          h('span', { class: 'convrow__preview' }, [
            h('span', { class: 'convrow__dir' }, [icon('lock', 11)]),
            h('span', { class: 'convrow__snippet convrow__snippet--masked' }, [
              t(state, 'المحتوى محجوب حتى الاستلام', 'Content withheld until claimed'),
            ]),
          ]),
          h('span', { class: 'convrow__meta' }, [
            pill(inboxName(model, card.inboxId), 'neutral', CHANNEL_ICON[card.channel]),
            ...meta,
            button({
              label: t(state, 'استلام', 'Claim'),
              act: 'claim',
              arg: card.id,
              variant: 'primary',
              small: true,
            }),
          ]),
        ]),
      ],
    );
  }

  if (card.sla !== 'none' && card.sla !== 'healthy') {
    meta.push(pill(slaLabel(card.sla, state.lang), SLA_TONE[card.sla], 'clock'));
  }

  /*
   * Row anatomy is fixed by task §3: contact, one-line preview, channel badge,
   * unread count, assignee, priority/SLA cue, timestamp. Labels belong to the
   * customer panel and the filter chips, not to a 332px queue row — pushing
   * every label in here is what sheared the cues off the end of the row.
   * Anything past the first two cues collapses into a count.
   */
  const CUE_LIMIT = 2;
  const overflow = meta.length - CUE_LIMIT;
  const cues =
    overflow > 0
      ? [...meta.slice(0, CUE_LIMIT), pill(`+${formatNumber(overflow, state.lang)}`, 'neutral')]
      : meta;

  return h(
    'button',
    {
      type: 'button',
      class: classes.join(' '),
      'data-act': 'open',
      'data-arg': card.id,
      'aria-current': String(selected),
    },
    [
      avatar({ initials: initials(card.contactName), channel: CHANNEL_ICON[card.channel] }),
      h('span', { class: 'convrow__body' }, [
        h('span', { class: 'convrow__top' }, [
          unread ? h('span', { class: 'convrow__dot', 'data-unread': 'true' }) : null,
          h('span', { class: 'convrow__name' }, [card.contactName]),
          h('span', { class: 'convrow__time' }, [
            isolated(relativeTime(card.lastActivityAt, model.context.now, state.lang)),
          ]),
        ]),
        h('span', { class: 'convrow__preview' }, [
          h(
            'span',
            { class: card.snippetDirection === 'out' ? 'convrow__dir convrow__dir--out' : 'convrow__dir' },
            [icon(card.snippetDirection === 'out' ? 'arrowOut' : 'arrowIn', 11)],
          ),
          h('span', { class: 'convrow__snippet' }, [card.snippet]),
          unread ? countBadge(card.unreadCount, true) : null,
        ]),
        h('span', { class: 'convrow__meta' }, [
          card.assigneeId === null
            ? pill(t(state, 'غير مُسندة', 'Unassigned'), 'warning', 'user')
            : h('span', { class: 'convrow__assignee' }, [
                avatar({ initials: initials(memberName(model, card.assigneeId)), size: 'sm' }),
                h('span', {}, [memberName(model, card.assigneeId)]),
              ]),
          ...cues,
        ]),
      ]),
    ],
  );
}

function renderListColumn(model: InboxModel): HTMLElement {
  const state = model.state;
  let body: HTMLElement;
  if (model.loading) {
    body = skeletonList(6);
  } else if (model.cards.length === 0) {
    body = stateBox({
      kind: 'empty',
      iconName: 'inboxEmpty',
      title: t(state, 'لا توجد محادثات مطابقة', 'No conversations match'),
      body: t(
        state,
        'جرّب توسيع المرشّحات أو اختيار قائمة أخرى. لا شيء هنا لا يعني أن الصندوق فارغ.',
        'Widen the filters or pick another queue. Nothing here does not mean the inbox is empty.',
      ),
      actionLabel: t(state, 'مسح المرشّحات', 'Clear filters'),
      act: 'clear-filters',
    });
  } else {
    body = h(
      'div',
      { class: 'convlist', role: 'list' },
      model.cards.map((card) =>
        h('div', { class: 'convlist__item', role: 'listitem' }, [conversationRow(model, card)]),
      ),
    );
  }

  return h('section', { class: 'zone zone--list', 'aria-label': t(state, 'قائمة المحادثات', 'Conversation list') }, [
    listResizer(model),
    // The result count lives in the header rather than on a strip of its own:
    // a separate 28px row cost the queue most of an eighth visible conversation.
    h('div', { class: 'zone__header' }, [
      h('h2', { class: 'zone__title' }, [t(state, 'المحادثات', 'Conversations')]),
      h('span', { class: 'listmeta' }, [conversationCount(model.cards.length, state.lang)]),
      h('span', { class: 'card__spacer' }),
      button({
        icon: 'refresh',
        act: 'reset-inbox',
        variant: 'ghost',
        small: true,
        title: t(state, 'إعادة ضبط العرض', 'Reset the view'),
      }),
    ]),
    renderListTools(model),
    h('div', { class: 'zone__body' }, [body]),
  ]);
}

/**
 * Queue-list separator. A real `separator` with an accessible name, keyboard
 * value semantics and arrow-key stepping — a bare drag handle would be
 * unreachable without a pointer. The pointer drag is wired in app.ts, which is
 * the only place that owns document-level pointer events.
 */
function listResizer(model: InboxModel): HTMLElement {
  const state = model.state;
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

/* ------------------------------------------------------------------ thread -- */

function timelineItem(model: InboxModel, item: TimelineItem): HTMLElement {
  const state = model.state;
  if (item.kind === 'event') {
    return h('div', { class: 'msg msg--event' }, [
      h('span', { class: 'eventline' }, [icon('info', 11), item.text, ' · ', isolated(clockTime(item.at, state.lang))]),
    ]);
  }
  if (item.kind === 'note') {
    return h('div', { class: 'msg msg--note' }, [
      h('div', { class: 'msg__bubble' }, [item.body]),
      h('div', { class: 'msg__meta' }, [
        icon('lock', 11),
        h('span', {}, [t(state, 'ملاحظة داخلية — لا تصل للعميل أبدًا', 'Private note — never reaches the customer')]),
        h('span', { class: 'msg__author' }, [item.authorName]),
        isolated(clockTime(item.at, state.lang)),
      ]),
    ]);
  }
  const deliveryLabels: Record<DeliveryState, string> = {
    sending: t(state, 'جارٍ الإرسال', 'Sending'),
    sent: t(state, 'أُرسلت', 'Sent'),
    delivered: t(state, 'وصلت', 'Delivered'),
    read: t(state, 'قُرئت', 'Read'),
    failed: t(state, 'فشلت', 'Failed'),
    unknown: t(state, 'نتيجة غير معروفة', 'Outcome unknown'),
  };
  return h('div', { class: item.direction === 'out' ? 'msg msg--out' : 'msg' }, [
    h('div', { class: 'msg__bubble' }, [item.body]),
    ...(item.attachments ?? []).map((attachment) =>
      h('span', { class: 'msg__attachment' }, [
        icon('paperclip', 12),
        isolated(attachment.name),
        h('span', {}, [attachment.size]),
      ]),
    ),
    h('div', { class: 'msg__meta' }, [
      h('span', { class: 'msg__author' }, [item.authorName]),
      isolated(clockTime(item.at, state.lang)),
      item.direction === 'out'
        ? pill(deliveryLabels[item.delivery], item.delivery === 'unknown' ? 'unknown' : 'neutral')
        : null,
    ]),
  ]);
}

function renderTimeline(model: InboxModel, items: readonly TimelineItem[]): HTMLElement {
  const nodes: HTMLElement[] = [];
  let lastDay = '';
  for (const item of items) {
    const label = dayLabel(item.at, model.context.now, model.state.lang);
    if (label !== lastDay) {
      lastDay = label;
      nodes.push(h('div', { class: 'daysep' }, [h('span', {}, [label])]));
    }
    nodes.push(timelineItem(model, item));
  }
  return h(
    'div',
    {
      class: 'thread__body',
      role: 'log',
      tabindex: '0',
      'data-scroll': 'timeline',
      'aria-label': t(model.state, 'سجل المحادثة', 'Conversation log'),
    },
    nodes,
  );
}

function windowState(model: InboxModel, conversation: ConversationRecord): {
  readonly open: boolean;
  readonly text: string;
} {
  const left = windowMinutesLeft(model.state, conversation.id);
  if (left === null) {
    return { open: false, text: t(model.state, 'المحادثة محلولة — لا نافذة نشطة', 'Resolved — no active window') };
  }
  if (left <= 0) {
    return {
      open: false,
      text: t(model.state, 'انتهت نافذة الـ 24 ساعة — يلزم قالب معتمد', 'The 24-hour window has closed — an approved template is required'),
    };
  }
  return {
    open: true,
    text: t(
      model.state,
      `نافذة الرد مفتوحة — يتبقّى ${durationLabel(left, model.state.lang)}`,
      `Reply window open — ${durationLabel(left, model.state.lang)} left`,
    ),
  };
}

function threadHeader(model: InboxModel, conversation: ConversationRecord, name: string): HTMLElement {
  const state = model.state;
  const actor = currentActor(state);
  const win = windowState(model, conversation);
  const assignOptions: PopoverOption[] = [
    {
      label: t(state, 'إلغاء الإسناد', 'Unassign'),
      value: '',
      checked: conversation.assigneeId === null,
    },
    ...model.context.dataset.members
      .filter((member) => member.inboxIds.includes(conversation.inboxId))
      .map((member) => ({
        label: state.lang === 'ar' ? member.name : member.nameEn,
        value: member.id,
        checked: conversation.assigneeId === member.id,
        hint: t(state, `${member.openLoad} مفتوحة`, `${member.openLoad} open`),
      })),
  ];
  return h('header', { class: 'thread__header' }, [
    button({
      icon: 'inbox',
      act: 'list',
      variant: 'ghost',
      small: true,
      title: t(state, 'عرض قائمة المحادثات', 'Show conversation list'),
      extraClass: 'thread__back',
    }),
    h('div', { class: 'thread__ident' }, [
      avatar({ initials: initials(name), size: 'lg', channel: CHANNEL_ICON[conversation.channel] }),
      h('div', { class: 'thread__names' }, [
        h('h2', { class: 'thread__name' }, [name]),
        h('div', { class: 'thread__sub' }, [
          isolated(conversation.reference, true),
          '·',
          h('span', {}, [inboxName(model, conversation.inboxId)]),
          '·',
          h('span', {}, [teamName(model, conversation.teamId)]),
          '·',
          pill(statusLabel(conversation.status, state.lang), STATUS_TONE[conversation.status]),
          pill(priorityLabel(conversation.priority, state.lang), PRIORITY_TONE[conversation.priority], 'flag'),
          conversation.sla === 'none'
            ? null
            : pill(slaLabel(conversation.sla, state.lang), SLA_TONE[conversation.sla], 'clock'),
        ]),
      ]),
    ]),
    h('div', { class: 'thread__primary' }, [
      button({
        label: t(state, 'حلّ', 'Resolve'),
        icon: 'resolve',
        act: 'status',
        arg: 'resolved',
        variant: 'primary',
        small: true,
      }),
      button({
        icon: state.panelOpen ? 'chevronEnd' : 'user',
        act: 'panel',
        small: true,
        pressed: state.panelOpen,
        title: t(state, 'لوحة العميل', 'Customer panel'),
      }),
      // Focus mode: closes both optional side zones and hands every remaining
      // pixel to the timeline. Task §3, "Desktop density and layout".
      button({
        icon: state.focusMode ? 'chevronStart' : 'expand',
        act: 'focus',
        small: true,
        pressed: state.focusMode,
        title: state.focusMode
          ? t(state, 'إنهاء وضع التركيز', 'Leave focus mode')
          : t(state, 'وضع التركيز', 'Focus mode'),
        extraClass: 'thread__focus',
      }),
    ]),
    h('div', { class: 'thread__toolbar' }, [
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'th-assign',
            'aria-expanded': String(state.openMenu === 'th-assign'),
          },
          [
            icon('assign', 12),
            conversation.assigneeId === null
              ? t(state, 'إسناد', 'Assign')
              : memberName(model, conversation.assigneeId),
            icon('chevronDown', 11),
          ],
        ),
        state.openMenu === 'th-assign'
          ? popover(
              canAssignOthers(actor)
                ? t(state, 'إسناد إلى', 'Assign to')
                : t(state, 'إسناد (لك فقط)', 'Assign (self only)'),
              assignOptions,
              'assign',
              undefined,
              true,
            )
          : null,
      ]),
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'th-status',
            'aria-expanded': String(state.openMenu === 'th-status'),
          },
          [t(state, 'الحالة', 'Status'), icon('chevronDown', 11)],
        ),
        state.openMenu === 'th-status'
          ? popover(
              t(state, 'حالة المحادثة', 'Conversation status'),
              [
                { label: statusLabel('open', state.lang), value: 'open', checked: conversation.status === 'open' },
                { label: statusLabel('pending', state.lang), value: 'pending', checked: conversation.status === 'pending' },
                { label: statusLabel('resolved', state.lang), value: 'resolved', checked: conversation.status === 'resolved' },
              ],
              'status',
              undefined,
              true,
            )
          : null,
      ]),
      button({
        icon: 'snooze',
        act: 'dialog',
        arg: 'snooze',
        small: true,
        title: t(state, 'تأجيل', 'Snooze'),
      }),
      anchored([
        h(
          'button',
          {
            type: 'button',
            class: 'filterbtn',
            'data-act': 'menu',
            'data-arg': 'th-priority',
            'aria-expanded': String(state.openMenu === 'th-priority'),
          },
          [icon('flag', 12), t(state, 'الأولوية', 'Priority'), icon('chevronDown', 11)],
        ),
        state.openMenu === 'th-priority'
          ? popover(
              t(state, 'الأولوية', 'Priority'),
              PRIORITY_VALUES.map((value) => ({
                label: priorityLabel(value, state.lang),
                value,
                checked: conversation.priority === value,
              })),
              'priority',
              undefined,
              true,
            )
          : null,
      ]),
      anchored([
        button({
          icon: 'dots',
          act: 'menu',
          arg: 'th-more',
          small: true,
          expanded: state.openMenu === 'th-more',
          title: t(state, 'إجراءات أخرى', 'More actions'),
        }),
        state.openMenu === 'th-more'
          ? popover(
              t(state, 'إجراءات', 'Actions'),
              [
                { label: t(state, 'تعليم كغير مقروءة', 'Mark unread'), value: '', checked: false },
              ],
              'mark-unread',
              undefined,
              true,
            )
          : null,
      ]),
      h('span', { class: 'thread__toolspacer' }),
      h('span', { class: 'composer__window' }, [icon(win.open ? 'clock' : 'alert', 12), win.text]),
    ]),
  ]);
}

function renderComposer(model: InboxModel, conversation: ConversationRecord): HTMLElement {
  const state = model.state;
  const tab = state.composerTab;
  const win = windowState(model, conversation);
  const blocked = tab === 'reply' && !win.open;
  const draft = readDraft(state, conversation.id, tab);
  const macros = [
    t(state, 'تم تحويل طلبك لفريق التسجيل وسنوافيك بالتحديث خلال ساعة.', 'Escalated to the enrollment team; we will update you within the hour.'),
    t(state, 'ممكن تأكيد رقم التسجيل من فضلك؟', 'Could you confirm the enrollment ID, please?'),
    t(state, 'تم تسجيل مراجعة الدفع وسيصلك إشعار عند اعتمادها.', 'The payment review is recorded; you will be notified on approval.'),
  ];
  return h('div', { class: 'composer' }, [
    h('div', { class: 'composer__tabs', role: 'tablist' }, [
      h(
        'button',
        {
          type: 'button',
          class: 'composer__tab',
          role: 'tab',
          'aria-selected': String(tab === 'reply'),
          'data-act': 'composer-tab',
          'data-arg': 'reply',
        },
        [icon('reply', 13), t(state, 'رد عام', 'Public reply')],
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'composer__tab composer__tab--note',
          role: 'tab',
          'aria-selected': String(tab === 'note'),
          'data-act': 'composer-tab',
          'data-arg': 'note',
        },
        [icon('note', 13), t(state, 'ملاحظة داخلية', 'Private note')],
      ),
      h('span', { class: 'composer__tabspacer' }),
    ]),
    h('div', { class: 'composer__area', 'data-tab': tab }, [
      blocked
        ? h('div', { class: 'composer__blocked' }, [
            icon('alert', 14),
            h('span', {}, [
              t(
                state,
                'الرد الحر غير متاح: نافذة القناة مغلقة. الملاحظة الداخلية ما زالت متاحة، والمسودة محفوظة.',
                'Free-form reply unavailable: the channel window is closed. Private notes still work and your draft is kept.',
              ),
            ]),
          ])
        : null,
      h('textarea', {
        class: 'composer__input',
        'data-act': 'composer-input',
        'aria-label': tab === 'reply' ? t(state, 'نص الرد', 'Reply text') : t(state, 'نص الملاحظة', 'Note text'),
        placeholder:
          tab === 'reply'
            ? t(state, 'اكتب ردًا للعميل…', 'Write a reply to the customer…')
            : t(state, 'ملاحظة داخلية لن يراها العميل…', 'Internal note the customer never sees…'),
        rows: 1,
      }, [draft]),
      h('div', { class: 'composer__toolbar' }, [
        button({
          icon: 'paperclip',
          act: 'attach',
          variant: 'ghost',
          small: true,
          title: t(state, 'إرفاق ملف', 'Attach a file'),
        }),
        anchored([
          button({
            icon: 'macro',
            act: 'menu',
            arg: 'c-macro',
            variant: 'ghost',
            small: true,
            expanded: state.openMenu === 'c-macro',
            title: t(state, 'ردود جاهزة', 'Macros'),
          }),
          state.openMenu === 'c-macro'
            ? popover(
                t(state, 'ردود جاهزة', 'Canned replies'),
                macros.map((text) => ({ label: text, value: text, checked: false })),
                'insert',
              )
            : null,
        ]),
        anchored([
          button({
            icon: 'emoji',
            act: 'menu',
            arg: 'c-emoji',
            variant: 'ghost',
            small: true,
            expanded: state.openMenu === 'c-emoji',
            title: t(state, 'رموز', 'Emoji'),
          }),
          state.openMenu === 'c-emoji'
            ? popover(
                t(state, 'رموز', 'Emoji'),
                ['🙏', '✅', '🚚', '😊'].map((glyph) => ({ label: glyph, value: glyph, checked: false })),
                'insert',
              )
            : null,
        ]),
        h('span', { class: 'composer__toolspacer' }),
        h('span', { class: 'composer__hint' }, [
          tab === 'note'
            ? t(state, 'لا يُنشأ أمر إرسال للملاحظات', 'Notes create no send command')
            : t(state, 'الرد وحده لا يُغلق المحادثة', 'A reply alone does not resolve'),
        ]),
        button({
          label: tab === 'reply' ? t(state, 'إرسال', 'Send') : t(state, 'إضافة ملاحظة', 'Add note'),
          icon: 'send',
          act: 'send',
          variant: 'primary',
          small: true,
        }),
      ]),
    ]),
  ]);
}

function renderThreadColumn(model: InboxModel): HTMLElement {
  const state = model.state;
  const zone = (children: readonly Child[]): HTMLElement =>
    h('section', { class: 'zone zone--thread thread', 'aria-label': t(state, 'المحادثة', 'Conversation') }, children);

  if (model.denied) {
    return zone([
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'لا تملك صلاحية قراءة هذه المحادثة', 'You do not have permission to read this conversation'),
        body: t(
          state,
          'الإجراء موجود لكن المنحة conversation.read غير مسندة لدورك في هذا الصندوق. الطلب مرفوض على الخادم أيضًا، وإخفاء الزر ليس ضابط تفويض.',
          'The action exists, but conversation.read is not granted to your role for this inbox. The server rejects it too — hiding a button is not an authorization control.',
        ),
        actionLabel: t(state, 'طلب صلاحية من المشرف', 'Request access'),
        act: 'demo',
        arg: t(state, 'أُرسل طلب الصلاحية إلى المشرف (عرض تجريبي)', 'Access request sent to your supervisor (demo)'),
      }),
    ]);
  }
  if (model.loading) {
    return zone([
      h('div', { class: 'thread__body' }, [
        h('div', { class: 'skeleton', style: 'width:48%;height:44px;border-radius:10px' }),
        h('div', { class: 'skeleton', style: 'width:62%;height:64px;border-radius:10px;align-self:flex-end' }),
        h('div', { class: 'skeleton', style: 'width:40%;height:38px;border-radius:10px' }),
        h('div', { class: 'skeleton', style: 'width:56%;height:52px;border-radius:10px;align-self:flex-end' }),
      ]),
    ]);
  }
  const conversation = model.selected;
  if (conversation === null) {
    return zone([
      stateBox({
        kind: 'empty',
        iconName: 'inboxEmpty',
        title: t(state, 'لم تُختر محادثة', 'No conversation selected'),
        body: t(
          state,
          'اختر محادثة من القائمة، أو غيّر المرشّحات لعرض قوائم أخرى.',
          'Pick a conversation from the list, or change the filters to see other queues.',
        ),
      }),
    ]);
  }

  const actor = currentActor(state);
  const projected = projectThread(conversation, actor, model.context.dataset);
  if (projected.access === 'queue') {
    return zone([
      stateBox({
        kind: 'info',
        iconName: 'eyeOff',
        title: t(state, 'بطاقة طابور — المحتوى غير متاح', 'Queue card — content unavailable'),
        body: t(
          state,
          `هذه محادثة غير مُسندة (${conversation.reference}). لا يُعرض نصّ ولا ملاحظات ولا بيانات تواصل قبل الاستلام — الخادم نفسه لا يرسلها.`,
          `This is an unassigned conversation (${conversation.reference}). No transcript, notes or contact details are shown before a claim — the server does not send them either.`,
        ),
        actionLabel: t(state, 'استلام المحادثة', 'Claim the conversation'),
        act: 'claim',
        arg: conversation.id,
      }),
    ]);
  }
  if (projected.access === 'none') {
    return zone([
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'غير متاحة', 'Not available'),
        body: t(state, 'المحادثة خارج نطاق وصولك.', 'This conversation is outside your scope.'),
      }),
    ]);
  }

  const name = contactNameFor(model.context.dataset, conversation.contactId);
  return zone([
    threadHeader(model, conversation, name),
    model.stale
      ? banner(
          'warning',
          'wifiOff',
          t(
            state,
            'أنت غير متصل — المعروض لقطة قديمة والإرسال معطّل حتى عودة الاتصال',
            'You are offline — this is a stale snapshot and sending is disabled until the connection returns',
          ),
          { label: t(state, 'إعادة المحاولة', 'Retry'), act: 'preview', arg: 'ready' },
        )
      : null,
    renderTimeline(model, projected.items),
    model.stale
      ? h('div', { class: 'composer' }, [
          h('div', { class: 'composer__area' }, [
            notice(
              'warning',
              'wifiOff',
              t(
                state,
                'الإرسال معطّل بلا اتصال. المسودة محفوظة محليًا وستبقى كما هي.',
                'Sending is disabled while offline. Your draft is kept locally and stays intact.',
              ),
            ),
          ]),
        ])
      : renderComposer(model, conversation),
  ]);
}

/* ------------------------------------------------------------------- panel -- */

function renderPanelColumn(model: InboxModel): HTMLElement {
  const state = model.state;
  const zone = (children: readonly Child[]): HTMLElement =>
    h('aside', { class: 'zone zone--panel', 'aria-label': t(state, 'بيانات العميل', 'Customer details') }, [
      h('div', { class: 'zone__header' }, [
        h('h2', { class: 'zone__title' }, [t(state, 'بيانات العميل', 'Customer')]),
        h('span', { class: 'card__spacer' }),
        button({
          icon: 'close',
          act: 'panel',
          variant: 'ghost',
          small: true,
          title: t(state, 'إخفاء اللوحة', 'Hide panel'),
        }),
      ]),
      h('div', { class: 'zone__body' }, children),
    ]);

  const conversation = model.selected;
  if (model.denied || conversation === null) {
    return zone([
      stateBox({
        kind: model.denied ? 'denied' : 'empty',
        iconName: model.denied ? 'lock' : 'user',
        title: model.denied
          ? t(state, 'بيانات العميل محجوبة', 'Customer details withheld')
          : t(state, 'لا يوجد عميل معروض', 'No customer shown'),
        body: model.denied
          ? t(state, 'المنحة contact.read غير مسندة لدورك هنا.', 'contact.read is not granted to your role here.')
          : t(state, 'اختر محادثة لعرض بياناتها.', 'Select a conversation to see its details.'),
      }),
    ]);
  }

  const actor = currentActor(state);
  if (conversationAccess(actor, conversation) !== 'full') {
    return zone([
      stateBox({
        kind: 'info',
        iconName: 'eyeOff',
        title: t(state, 'بيانات التواصل غير متاحة', 'Contact details unavailable'),
        body: t(
          state,
          'بطاقة الطابور لا تحمل اسمًا ولا هاتفًا ولا بريدًا. استلم المحادثة أولًا.',
          'A queue card carries no name, phone or email. Claim the conversation first.',
        ),
      }),
    ]);
  }

  const contact = model.context.dataset.contacts.find((entry) => entry.id === conversation.contactId);
  if (contact === undefined) {
    return zone([
      stateBox({
        kind: 'empty',
        iconName: 'user',
        title: t(state, 'لا يوجد سجل عميل', 'No contact record'),
        body: t(state, 'لم يُربط سجل عميل بهذه المحادثة بعد.', 'No contact is linked to this conversation yet.'),
      }),
    ]);
  }

  const consent = contact.consent[0];
  return zone([
    h('div', { class: 'panel__section' }, [
      h('div', { class: 'panel__identity' }, [
        avatar({ initials: initials(contact.name), size: 'lg' }),
        h('div', { class: 'panel__identitytext' }, [
          h('h3', { class: 'panel__name' }, [contact.name]),
          h('span', { class: 'field__hint' }, [
            t(state, contact.city, contact.cityEn),
            ' · ',
            isolated(contact.locale, true),
          ]),
        ]),
      ]),
      h('dl', { class: 'attrgrid' }, [
        h('dt', {}, [t(state, 'الهاتف', 'Phone')]),
        h('dd', {}, [contact.phone === null ? t(state, 'غير متاح', 'Not available') : isolated(contact.phone, true)]),
        h('dt', {}, [t(state, 'البريد', 'Email')]),
        h('dd', {}, [contact.email === null ? t(state, 'غير متاح', 'Not available') : isolated(contact.email, true)]),
        h('dt', {}, [t(state, 'الحساب', 'Handle')]),
        h('dd', {}, [contact.handle === null ? t(state, 'غير متاح', 'Not available') : isolated(contact.handle, true)]),
      ]),
      notice(
        'plain',
        'shield',
        t(
          state,
          'حقول مسموح بها فقط — لا تُعرض الحقول خارج سياسة الحقل حتى لو كانت في السجل.',
          'Allowlisted fields only — anything outside the field policy is not sent to the browser.',
        ),
      ),
    ]),
    h('div', { class: 'panel__section' }, [
      h('h4', { class: 'panel__sectiontitle' }, [icon('tag', 12), t(state, 'الوسوم', 'Labels')]),
      h(
        'div',
        { class: 'labelset' },
        conversation.labels.length === 0
          ? [h('span', { class: 'field__hint' }, [t(state, 'لا وسوم', 'No labels')])]
          : conversation.labels.map((id) => pill(labelName(model.context, id), 'neutral', 'tag')),
      ),
    ]),
    h('div', { class: 'panel__section' }, [
      h('h4', { class: 'panel__sectiontitle' }, [icon('shield', 12), t(state, 'الموافقة والحجب', 'Consent & suppression')]),
      h('div', { class: 'consent' }, [
        h('div', { class: 'consent__row' }, [
          h('span', {}, [t(state, 'الموافقة', 'Consent')]),
          pill(
            consent === undefined
              ? t(state, 'غير مسجّلة', 'Not recorded')
              : consent.state === 'granted'
                ? t(state, 'ممنوحة', 'Granted')
                : consent.state === 'withdrawn'
                  ? t(state, 'مسحوبة', 'Withdrawn')
                  : t(state, 'غير مسجّلة', 'Not recorded'),
            consent !== undefined && consent.state === 'granted' ? 'success' : 'warning',
          ),
        ]),
        consent === undefined
          ? null
          : h('span', { class: 'field__hint' }, [
              t(state, 'المصدر: ', 'Source: '),
              t(state, consent.source, consent.sourceEn),
            ]),
        h('div', { class: 'consent__row' }, [
          h('span', {}, [t(state, 'الحجب', 'Suppression')]),
          pill(
            contact.suppression.active ? t(state, 'نشط', 'Active') : t(state, 'غير نشط', 'Inactive'),
            contact.suppression.active ? 'danger' : 'neutral',
          ),
        ]),
        contact.suppression.reason === null || contact.suppression.reasonEn === null
          ? null
          : h('span', { class: 'field__hint' }, [
              t(state, contact.suppression.reason, contact.suppression.reasonEn),
            ]),
        h('span', { class: 'field__hint' }, [
          t(
            state,
            'الحجب يتقدّم على الموافقة، ولا يوجد زر «إلغاء حجب».',
            'Suppression beats consent, and there is no “unsuppress” button.',
          ),
        ]),
      ]),
    ]),
    h('div', { class: 'panel__section' }, [
      h('h4', { class: 'panel__sectiontitle' }, [icon('info', 12), t(state, 'سمات', 'Attributes')]),
      h(
        'dl',
        { class: 'attrgrid' },
        contact.attributes.flatMap((attribute) => [
          h('dt', {}, [t(state, attribute.label, attribute.labelEn)]),
          h('dd', {}, [isolated(attribute.value)]),
        ]),
      ),
    ]),
    h('div', { class: 'panel__section' }, [
      h('h4', { class: 'panel__sectiontitle' }, [icon('link', 12), t(state, 'الربط بـ CRM', 'CRM linkage')]),
      contact.crm === null
        ? notice('plain', 'link', t(state, 'غير مرتبط بأي نظام خارجي.', 'Not linked to an external system.'))
        : h('dl', { class: 'attrgrid' }, [
            h('dt', {}, [t(state, 'النظام', 'System')]),
            h('dd', {}, [contact.crm.system]),
            h('dt', {}, [t(state, 'المرجع', 'Reference')]),
            h('dd', {}, [isolated(contact.crm.reference, true)]),
            h('dt', {}, [t(state, 'المرحلة', 'Stage')]),
            h('dd', {}, [t(state, contact.crm.stage, contact.crm.stageEn)]),
            h('dt', {}, [t(state, 'آخر مزامنة', 'Last sync')]),
            h('dd', {}, [isolated(relativeTime(contact.crm.syncedAt, model.context.now, state.lang))]),
          ]),
    ]),
    h('div', { class: 'panel__section' }, [
      h('h4', { class: 'panel__sectiontitle' }, [icon('history', 12), t(state, 'سجل سابق', 'History')]),
      contact.history.length === 0
        ? h('span', { class: 'field__hint' }, [t(state, 'لا محادثات سابقة.', 'No previous conversations.')])
        : h(
            'div',
            { class: 'history' },
            contact.history.map((entry) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'history__item',
                  'data-act': 'demo',
                  'data-arg': t(state, entry.title, entry.titleEn),
                },
                [
                  icon('history', 12),
                  h('span', {}, [
                    h('span', { class: 'history__title' }, [t(state, entry.title, entry.titleEn)]),
                    ' · ',
                    isolated(relativeTime(entry.at, model.context.now, state.lang)),
                    ' · ',
                    t(state, entry.outcome, entry.outcomeEn),
                  ]),
                ],
              ),
            ),
          ),
      h('span', { class: 'field__hint' }, [
        t(
          state,
          `الحلقة الحالية رقم ${conversation.episode} — إعادة الفتح تبدأ حلقة قياس جديدة ولا تمحو القديمة.`,
          `Current episode ${conversation.episode} — reopening starts a new reporting episode without erasing the old one.`,
        ),
      ]),
    ]),
  ]);
}

/* -------------------------------------------------------------------- root -- */

export function renderInbox(state: AppState): HTMLElement {
  const actor = currentActor(state);
  if (!canOpenInbox(actor)) {
    return h('div', { class: 'workspace' }, [
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'صندوق الوارد غير متاح لدورك', 'The inbox is not available to your role'),
        body: t(
          state,
          'هذا الدور لا يملك conversation.read ولا conversation.unassigned.preview. الأدوار التسويقية والتحليلية لا ترى محتوى المحادثات إطلاقًا.',
          'This role holds neither conversation.read nor conversation.unassigned.preview. Campaign and analyst roles never see conversation content.',
        ),
        actionLabel: t(state, 'العودة كمشرف', 'Switch back to Supervisor'),
        act: 'role',
        arg: 'supervisor',
      }),
    ]);
  }
  const model = buildInboxModel(state);
  return h(
    'div',
    {
      class: 'inbox',
      'data-panel': state.panelOpen ? 'open' : 'closed',
      'data-list': state.listOpen ? 'open' : 'closed',
      'data-views': state.viewsOpen ? 'open' : 'closed',
      'data-focus': state.focusMode ? 'on' : 'off',
      // The one place the resizable width reaches CSS. Everything else reads
      // `--list-width`, so the token stays the single definition of the column.
      style: `--list-width:${String(state.listWidth)}px`,
    },
    [
      state.viewsOpen ? renderViewsColumn(model) : null,
      // A scrim exists whenever a zone is open; the shell layer hides it at the
      // widths where that zone is promoted to a real column instead of a drawer.
      state.viewsOpen ? scrim('views', t(state, 'إغلاق العروض', 'Close views')) : null,
      renderListColumn(model),
      state.listOpen ? scrim('list', t(state, 'إغلاق القائمة', 'Close list')) : null,
      renderThreadColumn(model),
      state.panelOpen ? renderPanelColumn(model) : null,
      state.panelOpen ? scrim('panel', t(state, 'إغلاق لوحة العميل', 'Close customer panel')) : null,
    ],
  );
}

/** Dismiss surface for a drawer-mode side zone. */
function scrim(zone: string, label: string): HTMLElement {
  return h('button', {
    type: 'button',
    class: `zone-scrim zone-scrim--${zone}`,
    'data-act': 'close-overlays',
    'data-arg': zone,
    'aria-label': label,
    tabindex: '-1',
  });
}

/** Advanced-filter dialog: the remaining attributes from the research set. */
export function renderFilterDialogBody(state: AppState): readonly HTMLElement[] {
  const model = buildInboxModel(state);
  const group = (title: string, children: readonly HTMLElement[]): HTMLElement =>
    h('div', { class: 'field' }, [h('span', { class: 'field__label' }, [title]), h('div', { class: 'labelset' }, children)]);
  const toggle = (label: string, key: string, value: string, on: boolean): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        class: on ? 'chip' : 'pill pill--outline',
        'data-act': 'toggle-filter',
        'data-arg': `${key}:${value}`,
        'aria-pressed': String(on),
      },
      [label],
    );
  return [
    group(
      t(state, 'صندوق الوارد', 'Inbox'),
      model.context.dataset.inboxes.map((inbox) =>
        toggle(
          state.lang === 'ar' ? inbox.name : inbox.nameEn,
          'inboxes',
          inbox.id,
          state.filter.inboxes.includes(inbox.id),
        ),
      ),
    ),
    group(
      t(state, 'الفريق', 'Team'),
      model.context.dataset.teams.map((team) =>
        toggle(state.lang === 'ar' ? team.name : team.nameEn, 'teams', team.id, state.filter.teams.includes(team.id)),
      ),
    ),
    group(
      t(state, 'الأولوية', 'Priority'),
      PRIORITY_VALUES.map((value) =>
        toggle(priorityLabel(value, state.lang), 'priorities', value, state.filter.priorities.includes(value)),
      ),
    ),
    group(
      t(state, 'الوسوم', 'Labels'),
      model.context.dataset.labels.map((label) =>
        toggle(
          state.lang === 'ar' ? label.name : label.nameEn,
          'labels',
          label.id,
          state.filter.labels.includes(label.id),
        ),
      ),
    ),
    group(
      t(state, 'حالة الـ SLA', 'SLA state'),
      SLA_VALUES.map((value) => toggle(slaLabel(value, state.lang), 'slas', value, state.filter.slas.includes(value))),
    ),
    group(
      t(state, 'آخر نشاط', 'Last activity'),
      DATE_VALUES.map((value) =>
        h(
          'button',
          {
            type: 'button',
            class: state.filter.date === value ? 'chip' : 'pill pill--outline',
            'data-act': 'date',
            'data-arg': value,
            'aria-pressed': String(state.filter.date === value),
          },
          [dateLabel(value, state.lang)],
        ),
      ),
    ),
    h('div', { class: 'field' }, [
      switchControl(
        t(state, 'إظهار المحلولة ضمن النتائج', 'Include resolved conversations'),
        state.filter.statuses.includes('resolved'),
        'toggle-filter',
        'statuses:resolved',
      ),
    ]),
  ];
}
