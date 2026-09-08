import { describe, expect, it } from 'vitest';
import { buildDataset, CURRENT_MEMBER_ID } from './data';
import type { FilterContext } from './filters';
import {
  activeChips,
  activeFilterCount,
  applyFilter,
  channelLabel,
  clearFilters,
  createFilter,
  criteriaFromFilter,
  dateLabel,
  filterFromView,
  labelName,
  priorityLabel,
  queueLabel,
  removeChip,
  segmentCounts,
  slaLabel,
  sortLabel,
  sortRecords,
  statusLabel,
  toggleFilterValue,
  toggleValue,
  UNASSIGNED_TOKEN,
} from './filters';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const dataset = buildDataset(NOW);
const context: FilterContext = { dataset, actorId: CURRENT_MEMBER_ID, now: NOW, lang: 'ar' };
const english: FilterContext = { ...context, lang: 'en' };
const all = dataset.conversations;

describe('filter state', () => {
  it('starts clean', () => {
    const filter = createFilter();
    expect(activeFilterCount(filter)).toBe(0);
    expect(filter.queue).toBe('all');
    expect(filter.sort).toBe('recent');
  });

  it('toggles values immutably', () => {
    const first = toggleValue<string>([], 'a');
    expect(first).toEqual(['a']);
    expect(toggleValue(first, 'a')).toEqual([]);
  });

  it('toggles a keyed multi-select and counts it', () => {
    let filter = toggleFilterValue(createFilter(), 'channels', 'whatsapp');
    filter = toggleFilterValue(filter, 'statuses', 'open');
    expect(activeFilterCount(filter)).toBe(2);
    filter = { ...filter, date: 'week', query: ' شحن ' };
    expect(activeFilterCount(filter)).toBe(4);
  });

  it('clears attribute filters but keeps queue and sort', () => {
    const filter = clearFilters({
      ...toggleFilterValue(createFilter(), 'labels', 'lb-vip'),
      queue: 'mine',
      sort: 'sla',
      date: 'today',
      query: 'x',
    });
    expect(activeFilterCount(filter)).toBe(0);
    expect(filter.queue).toBe('mine');
    expect(filter.sort).toBe('sla');
  });
});

describe('labels', () => {
  it('translates every enumerated value', () => {
    expect(statusLabel('snoozed', 'ar')).toBe('مؤجّلة');
    expect(statusLabel('snoozed', 'en')).toBe('Snoozed');
    expect(priorityLabel('urgent', 'en')).toBe('Urgent');
    expect(slaLabel('breached', 'en')).toBe('SLA breached');
    expect(channelLabel('instagram', 'ar')).toBe('إنستجرام');
    expect(dateLabel('week', 'en')).toBe('Last 7 days');
    expect(sortLabel('unread', 'en')).toBe('Most unread');
    expect(queueLabel('unassigned', 'ar')).toBe('غير مُسندة');
    expect(labelName(context, 'lb-vip')).toBe('متدرب مميّز');
    expect(labelName(english, 'lb-vip')).toBe('VIP learner');
    expect(labelName(context, 'lb-nope')).toBe('lb-nope');
  });
});

describe('activeChips and removeChip', () => {
  it('emits one chip per value in force and removes each again', () => {
    let filter = createFilter();
    filter = { ...filter, query: 'شحن', date: 'today' };
    filter = toggleFilterValue(filter, 'assignees', UNASSIGNED_TOKEN);
    filter = toggleFilterValue(filter, 'assignees', 'm-tarek');
    filter = toggleFilterValue(filter, 'inboxes', 'ib-ig');
    filter = toggleFilterValue(filter, 'teams', 't-care');
    filter = toggleFilterValue(filter, 'channels', 'whatsapp');
    filter = toggleFilterValue(filter, 'statuses', 'open');
    filter = toggleFilterValue(filter, 'priorities', 'urgent');
    filter = toggleFilterValue(filter, 'labels', 'lb-vip');
    filter = toggleFilterValue(filter, 'slas', 'due');
    const chips = activeChips(filter, context);
    expect(chips).toHaveLength(11);
    expect(chips.map((chip) => chip.key)).toContain('query');
    expect(chips.map((chip) => chip.key)).toContain('date');
    let reduced = filter;
    for (const chip of chips) reduced = removeChip(reduced, chip);
    expect(activeFilterCount(reduced)).toBe(0);
  });

  it('labels the unassigned token in both languages', () => {
    const filter = toggleFilterValue(createFilter(), 'assignees', UNASSIGNED_TOKEN);
    expect(activeChips(filter, context)[0]?.label).toBe('غير مُسندة');
    expect(activeChips(filter, english)[0]?.label).toBe('Unassigned');
  });

  it('falls back to the raw id for unknown members, inboxes and teams', () => {
    let filter = toggleFilterValue(createFilter(), 'assignees', 'm-ghost');
    filter = toggleFilterValue(filter, 'inboxes', 'ib-ghost');
    filter = toggleFilterValue(filter, 'teams', 't-ghost');
    const labels = activeChips(filter, english).map((chip) => chip.label);
    expect(labels).toEqual(['m-ghost', 'ib-ghost', 't-ghost']);
  });

  it('names known members, inboxes and teams in both languages', () => {
    let filter = toggleFilterValue(createFilter(), 'assignees', 'm-tarek');
    filter = toggleFilterValue(filter, 'inboxes', 'ib-ig');
    filter = toggleFilterValue(filter, 'teams', 't-care');
    expect(activeChips(filter, context).map((chip) => chip.label)).toEqual([
      'طارق منير',
      'إنستجرام — @digitalschool',
      'دعم الطلاب',
    ]);
    expect(activeChips(filter, english).map((chip) => chip.label)).toEqual([
      'Tarek Mounir',
      'Instagram — @digitalschool',
      'Student Support',
    ]);
  });
});

describe('applyFilter', () => {
  it('filters by queue segment', () => {
    expect(applyFilter(all, { ...createFilter(), queue: 'unread' }, context).every((c) => c.unreadCount > 0)).toBe(true);
    expect(applyFilter(all, { ...createFilter(), queue: 'read' }, context).every((c) => c.unreadCount === 0)).toBe(true);
    expect(applyFilter(all, { ...createFilter(), queue: 'mine' }, context).every((c) => c.assigneeId === CURRENT_MEMBER_ID)).toBe(true);
    expect(applyFilter(all, { ...createFilter(), queue: 'unassigned' }, context).every((c) => c.assigneeId === null)).toBe(true);
    expect(applyFilter(all, createFilter(), context)).toHaveLength(all.length);
  });

  it('filters by each attribute', () => {
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'channels', 'instagram'), context).every((c) => c.channel === 'instagram')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'inboxes', 'ib-mg'), context).every((c) => c.inboxId === 'ib-mg')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'teams', 't-vip'), context).every((c) => c.teamId === 't-vip')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'statuses', 'resolved'), context).every((c) => c.status === 'resolved')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'priorities', 'urgent'), context).every((c) => c.priority === 'urgent')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'slas', 'breached'), context).every((c) => c.sla === 'breached')).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'assignees', UNASSIGNED_TOKEN), context).every((c) => c.assigneeId === null)).toBe(true);
    expect(applyFilter(all, toggleFilterValue(createFilter(), 'assignees', 'm-tarek'), context).every((c) => c.assigneeId === 'm-tarek')).toBe(true);
    const labelled = applyFilter(all, toggleFilterValue(createFilter(), 'labels', 'lb-vip'), context);
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.every((c) => c.labels.includes('lb-vip'))).toBe(true);
  });

  it('filters by date window', () => {
    const today = applyFilter(all, { ...createFilter(), date: 'today' }, context);
    const week = applyFilter(all, { ...createFilter(), date: 'week' }, context);
    const month = applyFilter(all, { ...createFilter(), date: 'month' }, context);
    expect(today.length).toBeLessThan(week.length);
    expect(week.length).toBeLessThanOrEqual(month.length);
  });

  it('searches reference, snippet, name, phone and handle', () => {
    expect(applyFilter(all, { ...createFilter(), query: 'CV-4821' }, context)).toHaveLength(1);
    expect(applyFilter(all, { ...createFilter(), query: 'مريم' }, context).length).toBeGreaterThan(0);
    expect(applyFilter(all, { ...createFilter(), query: '+20 100 234 8190' }, context)).toHaveLength(1);
    expect(applyFilter(all, { ...createFilter(), query: '@rana.style' }, context)).toHaveLength(1);
    expect(applyFilter(all, { ...createFilter(), query: 'zzzz' }, context)).toHaveLength(0);
  });

  it('tolerates a conversation whose contact is missing', () => {
    const first = all[0];
    if (first === undefined) throw new Error('fixture missing');
    const orphan = { ...first, id: 'cv-orphan', contactId: 'ct-missing' };
    expect(applyFilter([orphan], { ...createFilter(), query: 'zzz' }, context)).toHaveLength(0);
    expect(applyFilter([orphan], { ...createFilter(), query: orphan.reference }, context)).toHaveLength(1);
  });
});

describe('sortRecords', () => {
  it('orders by every supported key', () => {
    expect(sortRecords(all, 'recent')[0]?.id).toBe('cv-4821');
    expect(sortRecords(all, 'oldest')[0]?.id).toBe('cv-4806');
    expect(sortRecords(all, 'sla')[0]?.sla).toBe('breached');
    expect(sortRecords(all, 'priority')[0]?.priority).toBe('urgent');
    expect(sortRecords(all, 'unread')[0]?.id).toBe('cv-4817');
  });

  it('does not mutate its input', () => {
    const before = all.map((entry) => entry.id);
    sortRecords(all, 'oldest');
    expect(all.map((entry) => entry.id)).toEqual(before);
  });
});

describe('segmentCounts', () => {
  it('counts each segment against what the actor may see', () => {
    const counts = segmentCounts(all, CURRENT_MEMBER_ID);
    expect(counts.all).toBe(all.length);
    expect(counts.unread + counts.read).toBe(all.length);
    expect(counts.mine).toBeGreaterThan(0);
    expect(counts.unassigned).toBeGreaterThan(0);
  });
});

describe('saved views', () => {
  it('rebuilds a filter from view criteria', () => {
    const view = dataset.views.find((entry) => entry.id === 'v-sla');
    if (view === undefined) throw new Error('fixture missing');
    const filter = filterFromView(view, createFilter());
    expect(filter.slas).toEqual(['breached', 'due']);
    expect(filter.sort).toBe('sla');
    const results = applyFilter(all, filter, context);
    expect(results.every((entry) => entry.sla === 'breached' || entry.sla === 'due')).toBe(true);
  });

  it('falls back to the base sort when the view names none', () => {
    const view = dataset.views.find((entry) => entry.id === 'v-refunds');
    if (view === undefined) throw new Error('fixture missing');
    const filter = filterFromView(view, { ...createFilter(), sort: 'oldest' });
    expect(filter.sort).toBe('oldest');
    expect(filter.queue).toBe('all');
    expect(filter.channels).toEqual([]);
  });

  it('defaults every unset criterion when a view names only a few', () => {
    const view = dataset.views.find((entry) => entry.id === 'v-instagram');
    if (view === undefined) throw new Error('fixture missing');
    const filter = filterFromView(view, createFilter());
    expect(filter.channels).toEqual(['instagram']);
    expect(filter.statuses).toEqual([]);
    expect(filter.priorities).toEqual([]);
    expect(filter.slas).toEqual([]);
    expect(filter.labels).toEqual([]);
    expect(filter.inboxes).toEqual([]);
    expect(filter.teams).toEqual([]);
    expect(filter.sort).toBe('recent');
  });

  it('round-trips the filter in force into criteria', () => {
    const filter = toggleFilterValue(createFilter(), 'channels', 'messenger');
    const criteria = criteriaFromFilter(filter);
    expect(criteria.channels).toEqual(['messenger']);
    expect(criteria.queue).toBe('all');
  });
});
