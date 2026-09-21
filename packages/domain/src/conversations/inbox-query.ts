import { INBOX_FILTER_KEYS, type InboxFilterKey } from './inbox-filters.js';

export const INBOX_SORTS = ['activity_desc', 'activity_asc', 'created_desc', 'created_asc', 'waiting_desc', 'priority_desc'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];
export type InboxQueue = 'mine' | 'all';

export interface InboxFilter {
  readonly key: InboxFilterKey;
  readonly operator: string;
  readonly value?: string | boolean | readonly string[];
  readonly fieldId?: string;
}

export interface InboxQuery {
  readonly queue: InboxQueue;
  readonly filters: readonly InboxFilter[];
  readonly search: string | null;
  readonly sort: InboxSort;
  readonly cursor: string | null;
  readonly limit: number;
}

export const INBOX_QUERY_DEFAULT: InboxQuery = { queue: 'mine', filters: [], search: null, sort: 'activity_desc', cursor: null, limit: 50 };

/** Bounded, shape-only guard; per-key value semantics belong to the API compiler. */
export function isInboxQuery(value: unknown): value is InboxQuery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const query = value as Partial<InboxQuery>;
  return (query.queue === 'mine' || query.queue === 'all') &&
    Array.isArray(query.filters) && query.filters.length <= 20 && query.filters.every(isFilter) &&
    (query.search === null || typeof query.search === 'string') &&
    typeof query.sort === 'string' && (INBOX_SORTS as readonly string[]).includes(query.sort) &&
    (query.cursor === null || typeof query.cursor === 'string') &&
    typeof query.limit === 'number' && Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100;
}

function isFilter(value: unknown): value is InboxFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as Partial<InboxFilter>;
  const hasValue = typeof filter.value === 'string' || typeof filter.value === 'boolean' ||
    (Array.isArray(filter.value) && filter.value.length > 0 && filter.value.length <= 100 && filter.value.every((item) => typeof item === 'string'));
  return typeof filter.key === 'string' && (INBOX_FILTER_KEYS as readonly string[]).includes(filter.key) &&
    typeof filter.operator === 'string' && (filter.value === undefined || hasValue) &&
    (filter.fieldId === undefined || typeof filter.fieldId === 'string');
}
