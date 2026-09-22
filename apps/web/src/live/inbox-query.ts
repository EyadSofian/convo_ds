import type { InboxQuery } from '@convo/domain';

export type SimpleInboxFilter = 'unread' | 'priority' | 'channel' | 'labelId';

/** Temporary controls are projections of the one authoritative server query. */
export function simpleFilterValue(query: InboxQuery, key: SimpleInboxFilter): string {
  const filterKey = key === 'labelId' ? 'label_id' : key;
  const filter = query.filters.find((candidate) => candidate.key === filterKey);
  return typeof filter?.value === 'string' ? filter.value : typeof filter?.value === 'boolean' ? String(filter.value) : '';
}

export function setSimpleFilter(query: InboxQuery, key: SimpleInboxFilter, value: string): InboxQuery {
  const filterKey = key === 'labelId' ? 'label_id' : key;
  const filters = query.filters.filter((filter) => filter.key !== filterKey);
  if (value !== '') {
    filters.push({
      key: filterKey,
      operator: 'eq',
      value: key === 'unread' ? value === 'true' : value,
    });
  }
  return { ...query, filters, cursor: null };
}

export function unassignedFilterProjection(query: InboxQuery): {
  readonly priority: string;
  readonly channel: string;
  readonly labelId: string;
} {
  return {
    priority: simpleFilterValue(query, 'priority'),
    channel: simpleFilterValue(query, 'channel'),
    labelId: simpleFilterValue(query, 'labelId'),
  };
}

export function activeFilterCount(query: InboxQuery): number {
  return query.filters.length + (query.search === null || query.search === '' ? 0 : 1);
}
