import type {
  ChannelKind,
  ConversationRecord,
  ConversationStatus,
  Dataset,
  Priority,
  SavedView,
  SlaState,
  SortOrder,
} from './data';
import type { Lang } from './format';

/**
 * Inbox filter model.
 *
 * Algebra is deliberately flat — OR inside one attribute, AND across attributes
 * — because that is exactly what the active-filter chip row can render
 * truthfully. See docs/design/ui-research.md §3 for why the nested condition
 * tree used by other products was rejected here.
 */

export type QueueSegment = 'all' | 'unread' | 'read' | 'mine' | 'unassigned';
export type DateWindow = 'any' | 'today' | 'week' | 'month';

export interface FilterState {
  queue: QueueSegment;
  query: string;
  assignees: readonly string[];
  inboxes: readonly string[];
  teams: readonly string[];
  channels: readonly ChannelKind[];
  statuses: readonly ConversationStatus[];
  priorities: readonly Priority[];
  labels: readonly string[];
  slas: readonly SlaState[];
  date: DateWindow;
  sort: SortOrder;
}

export const UNASSIGNED_TOKEN = 'unassigned';

export function createFilter(): FilterState {
  return {
    queue: 'all',
    query: '',
    assignees: [],
    inboxes: [],
    teams: [],
    channels: [],
    statuses: [],
    priorities: [],
    labels: [],
    slas: [],
    date: 'any',
    sort: 'recent',
  };
}

/** Immutable set toggle — the filter state is never mutated in place. */
export function toggleValue<T extends string>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

export const MULTI_KEYS = [
  'assignees',
  'inboxes',
  'teams',
  'channels',
  'statuses',
  'priorities',
  'labels',
  'slas',
] as const;

export type MultiKey = (typeof MULTI_KEYS)[number];

export function toggleFilterValue(
  filter: FilterState,
  key: MultiKey,
  value: string,
): FilterState {
  const current = filter[key] as readonly string[];
  return { ...filter, [key]: toggleValue(current, value) };
}

/** Number of *attribute* filters in force; the queue segment and sort are not filters. */
export function activeFilterCount(filter: FilterState): number {
  const fromLists = MULTI_KEYS.reduce(
    (total, key) => total + (filter[key] as readonly string[]).length,
    0,
  );
  return fromLists + (filter.date === 'any' ? 0 : 1) + (filter.query.trim() === '' ? 0 : 1);
}

export function clearFilters(filter: FilterState): FilterState {
  return { ...createFilter(), queue: filter.queue, sort: filter.sort };
}

export interface ActiveChip {
  readonly key: MultiKey | 'date' | 'query';
  readonly value: string;
  readonly label: string;
}

export interface FilterContext {
  readonly dataset: Dataset;
  readonly actorId: string;
  readonly now: Date;
  readonly lang: Lang;
}

const STATUS_LABELS: Record<ConversationStatus, Record<Lang, string>> = {
  open: { ar: 'مفتوحة', en: 'Open' },
  pending: { ar: 'بانتظار العميل', en: 'Pending' },
  snoozed: { ar: 'مؤجّلة', en: 'Snoozed' },
  resolved: { ar: 'محلولة', en: 'Resolved' },
};

const PRIORITY_LABELS: Record<Priority, Record<Lang, string>> = {
  urgent: { ar: 'عاجلة', en: 'Urgent' },
  high: { ar: 'مرتفعة', en: 'High' },
  normal: { ar: 'عادية', en: 'Normal' },
  low: { ar: 'منخفضة', en: 'Low' },
};

const SLA_LABELS: Record<SlaState, Record<Lang, string>> = {
  breached: { ar: 'تجاوز الـ SLA', en: 'SLA breached' },
  due: { ar: 'قارب الاستحقاق', en: 'Due soon' },
  healthy: { ar: 'ضمن المستهدف', en: 'On target' },
  none: { ar: 'بدون مؤقّت', en: 'No timer' },
};

const CHANNEL_LABELS: Record<ChannelKind, Record<Lang, string>> = {
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  instagram: { ar: 'إنستجرام', en: 'Instagram' },
  messenger: { ar: 'ماسنجر', en: 'Messenger' },
};

const DATE_LABELS: Record<DateWindow, Record<Lang, string>> = {
  any: { ar: 'أي وقت', en: 'Any time' },
  today: { ar: 'آخر 24 ساعة', en: 'Last 24 hours' },
  week: { ar: 'آخر 7 أيام', en: 'Last 7 days' },
  month: { ar: 'آخر 30 يومًا', en: 'Last 30 days' },
};

const SORT_LABELS: Record<SortOrder, Record<Lang, string>> = {
  recent: { ar: 'الأحدث نشاطًا', en: 'Newest activity' },
  oldest: { ar: 'الأقدم نشاطًا', en: 'Oldest activity' },
  sla: { ar: 'الأقرب لتجاوز الـ SLA', en: 'SLA risk first' },
  priority: { ar: 'الأولوية الأعلى', en: 'Highest priority' },
  unread: { ar: 'الأكثر رسائل غير مقروءة', en: 'Most unread' },
};

const QUEUE_LABELS: Record<QueueSegment, Record<Lang, string>> = {
  all: { ar: 'الكل', en: 'All' },
  unread: { ar: 'غير مقروءة', en: 'Unread' },
  read: { ar: 'مقروءة', en: 'Read' },
  mine: { ar: 'لديّ', en: 'Mine' },
  unassigned: { ar: 'غير مُسندة', en: 'Unassigned' },
};

export function statusLabel(value: ConversationStatus, lang: Lang): string {
  return STATUS_LABELS[value][lang];
}
export function priorityLabel(value: Priority, lang: Lang): string {
  return PRIORITY_LABELS[value][lang];
}
export function slaLabel(value: SlaState, lang: Lang): string {
  return SLA_LABELS[value][lang];
}
export function channelLabel(value: ChannelKind, lang: Lang): string {
  return CHANNEL_LABELS[value][lang];
}
export function dateLabel(value: DateWindow, lang: Lang): string {
  return DATE_LABELS[value][lang];
}
export function sortLabel(value: SortOrder, lang: Lang): string {
  return SORT_LABELS[value][lang];
}
export function queueLabel(value: QueueSegment, lang: Lang): string {
  return QUEUE_LABELS[value][lang];
}

export const QUEUE_SEGMENTS: readonly QueueSegment[] = [
  'all',
  'unread',
  'read',
  'mine',
  'unassigned',
];
export const STATUS_VALUES: readonly ConversationStatus[] = [
  'open',
  'pending',
  'snoozed',
  'resolved',
];
export const PRIORITY_VALUES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
export const SLA_VALUES: readonly SlaState[] = ['breached', 'due', 'healthy', 'none'];
export const CHANNEL_VALUES: readonly ChannelKind[] = ['whatsapp', 'instagram', 'messenger'];
export const DATE_VALUES: readonly DateWindow[] = ['any', 'today', 'week', 'month'];
export const SORT_VALUES: readonly SortOrder[] = ['recent', 'oldest', 'sla', 'priority', 'unread'];

function memberLabel(context: FilterContext, id: string): string {
  if (id === UNASSIGNED_TOKEN) return context.lang === 'ar' ? 'غير مُسندة' : 'Unassigned';
  const member = context.dataset.members.find((entry) => entry.id === id);
  if (member === undefined) return id;
  return context.lang === 'ar' ? member.name : member.nameEn;
}

function inboxLabel(context: FilterContext, id: string): string {
  const inbox = context.dataset.inboxes.find((entry) => entry.id === id);
  if (inbox === undefined) return id;
  return context.lang === 'ar' ? inbox.name : inbox.nameEn;
}

function teamLabel(context: FilterContext, id: string): string {
  const team = context.dataset.teams.find((entry) => entry.id === id);
  if (team === undefined) return id;
  return context.lang === 'ar' ? team.name : team.nameEn;
}

export function labelName(context: FilterContext, id: string): string {
  const label = context.dataset.labels.find((entry) => entry.id === id);
  if (label === undefined) return id;
  return context.lang === 'ar' ? label.name : label.nameEn;
}

/** One chip per value in force, in a stable order, for the active-filter row. */
export function activeChips(filter: FilterState, context: FilterContext): readonly ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filter.query.trim() !== '') {
    chips.push({ key: 'query', value: filter.query, label: `“${filter.query.trim()}”` });
  }
  for (const value of filter.assignees) {
    chips.push({ key: 'assignees', value, label: memberLabel(context, value) });
  }
  for (const value of filter.inboxes) {
    chips.push({ key: 'inboxes', value, label: inboxLabel(context, value) });
  }
  for (const value of filter.teams) {
    chips.push({ key: 'teams', value, label: teamLabel(context, value) });
  }
  for (const value of filter.channels) {
    chips.push({ key: 'channels', value, label: channelLabel(value, context.lang) });
  }
  for (const value of filter.statuses) {
    chips.push({ key: 'statuses', value, label: statusLabel(value, context.lang) });
  }
  for (const value of filter.priorities) {
    chips.push({ key: 'priorities', value, label: priorityLabel(value, context.lang) });
  }
  for (const value of filter.labels) {
    chips.push({ key: 'labels', value, label: labelName(context, value) });
  }
  for (const value of filter.slas) {
    chips.push({ key: 'slas', value, label: slaLabel(value, context.lang) });
  }
  if (filter.date !== 'any') {
    chips.push({ key: 'date', value: filter.date, label: dateLabel(filter.date, context.lang) });
  }
  return chips;
}

export function removeChip(filter: FilterState, chip: ActiveChip): FilterState {
  if (chip.key === 'query') return { ...filter, query: '' };
  if (chip.key === 'date') return { ...filter, date: 'any' };
  return toggleFilterValue(filter, chip.key, chip.value);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS: Record<DateWindow, number> = { any: 0, today: 1, week: 7, month: 30 };

function matchesSegment(
  conversation: ConversationRecord,
  segment: QueueSegment,
  actorId: string,
): boolean {
  if (segment === 'unread') return conversation.unreadCount > 0;
  if (segment === 'read') return conversation.unreadCount === 0;
  if (segment === 'mine') return conversation.assigneeId === actorId;
  if (segment === 'unassigned') return conversation.assigneeId === null;
  return true;
}

function matchesList(values: readonly string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

function matchesQuery(
  conversation: ConversationRecord,
  query: string,
  context: FilterContext,
): boolean {
  if (query === '') return true;
  const contact = context.dataset.contacts.find((entry) => entry.id === conversation.contactId);
  const haystack = [
    conversation.reference,
    conversation.snippet,
    contact === undefined ? '' : contact.name,
    contact === undefined || contact.phone === null ? '' : contact.phone,
    contact === undefined || contact.handle === null ? '' : contact.handle,
  ]
    .join(' ')
    .toLocaleLowerCase();
  return haystack.includes(query);
}

export function applyFilter(
  records: readonly ConversationRecord[],
  filter: FilterState,
  context: FilterContext,
): readonly ConversationRecord[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const cutoff =
    filter.date === 'any' ? 0 : context.now.getTime() - WINDOW_DAYS[filter.date] * DAY_MS;
  const matched = records.filter((conversation) => {
    if (!matchesSegment(conversation, filter.queue, context.actorId)) return false;
    if (!matchesList(filter.assignees, conversation.assigneeId ?? UNASSIGNED_TOKEN)) return false;
    if (!matchesList(filter.inboxes, conversation.inboxId)) return false;
    if (!matchesList(filter.teams, conversation.teamId)) return false;
    if (!matchesList(filter.channels, conversation.channel)) return false;
    if (!matchesList(filter.statuses, conversation.status)) return false;
    if (!matchesList(filter.priorities, conversation.priority)) return false;
    if (!matchesList(filter.slas, conversation.sla)) return false;
    if (
      filter.labels.length > 0 &&
      !conversation.labels.some((label) => filter.labels.includes(label))
    ) {
      return false;
    }
    if (cutoff !== 0 && new Date(conversation.lastActivityAt).getTime() < cutoff) return false;
    return matchesQuery(conversation, query, context);
  });
  return sortRecords(matched, filter.sort);
}

const SLA_WEIGHT: Record<SlaState, number> = { breached: 0, due: 1, healthy: 2, none: 3 };
const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function sortRecords(
  records: readonly ConversationRecord[],
  sort: SortOrder,
): readonly ConversationRecord[] {
  const byRecent = (left: ConversationRecord, right: ConversationRecord): number =>
    right.lastActivityAt.localeCompare(left.lastActivityAt);
  const copy = [...records];
  if (sort === 'oldest') {
    return copy.sort((left, right) => left.lastActivityAt.localeCompare(right.lastActivityAt));
  }
  if (sort === 'sla') {
    return copy.sort(
      (left, right) => SLA_WEIGHT[left.sla] - SLA_WEIGHT[right.sla] || byRecent(left, right),
    );
  }
  if (sort === 'priority') {
    return copy.sort(
      (left, right) =>
        PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority] || byRecent(left, right),
    );
  }
  if (sort === 'unread') {
    return copy.sort((left, right) => right.unreadCount - left.unreadCount || byRecent(left, right));
  }
  return copy.sort(byRecent);
}

/** Counts for the queue segment control — computed on what the actor may see. */
export function segmentCounts(
  records: readonly ConversationRecord[],
  actorId: string,
): Record<QueueSegment, number> {
  return {
    all: records.length,
    unread: records.filter((entry) => entry.unreadCount > 0).length,
    read: records.filter((entry) => entry.unreadCount === 0).length,
    mine: records.filter((entry) => entry.assigneeId === actorId).length,
    unassigned: records.filter((entry) => entry.assigneeId === null).length,
  };
}

/** Applies a saved view's criteria on top of a clean filter. */
export function filterFromView(view: SavedView, base: FilterState): FilterState {
  const criteria = view.criteria;
  return {
    ...createFilter(),
    queue: criteria.queue ?? 'all',
    statuses: criteria.statuses ?? [],
    priorities: criteria.priorities ?? [],
    channels: criteria.channels ?? [],
    slas: criteria.slas ?? [],
    labels: criteria.labels ?? [],
    inboxes: criteria.inboxes ?? [],
    teams: criteria.teams ?? [],
    sort: criteria.sort ?? base.sort,
  };
}

/** Turns the filter in force into criteria a new saved view can carry. */
export function criteriaFromFilter(filter: FilterState): SavedView['criteria'] {
  return {
    queue: filter.queue,
    statuses: filter.statuses,
    priorities: filter.priorities,
    channels: filter.channels,
    slas: filter.slas,
    labels: filter.labels,
    inboxes: filter.inboxes,
    teams: filter.teams,
    sort: filter.sort,
  };
}
