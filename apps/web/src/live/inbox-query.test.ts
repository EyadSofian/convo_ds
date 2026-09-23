import { describe, expect, it } from 'vitest';
import type { InboxQuery } from '@convo/domain';
import { activeFilterCount, setSimpleFilter, simpleFilterValue, unassignedFilterProjection } from './inbox-query.js';

const base: InboxQuery = { queue: 'mine', search: null, sort: 'activity_desc', filters: [], cursor: null, limit: 25 };

describe('inbox query projections', () => {
  it('reads string, boolean and missing simple filters', () => {
    const query: InboxQuery = {
      ...base,
      search: 'alice',
      filters: [
        { key: 'priority', operator: 'eq', value: 'high' },
        { key: 'channel', operator: 'eq', value: true },
        { key: 'unread', operator: 'eq', value: false },
        { key: 'label_id', operator: 'eq', value: 'label-1' },
      ],
    };
    expect(simpleFilterValue(base, 'priority')).toBe('');
    expect(simpleFilterValue(query, 'priority')).toBe('high');
    expect(simpleFilterValue(query, 'channel')).toBe('true');
    expect(simpleFilterValue(query, 'unread')).toBe('false');
    expect(simpleFilterValue(query, 'labelId')).toBe('label-1');
    expect(simpleFilterValue(query, 'priority')).not.toBe('');
    expect(unassignedFilterProjection(query)).toEqual({ priority: 'high', channel: 'true', labelId: 'label-1' });
    expect(activeFilterCount(query)).toBe(5);
    expect(activeFilterCount({ ...base, search: '' })).toBe(0);
  });

  it('sets typed filters and removes them when cleared', () => {
    const withUnread = setSimpleFilter(base, 'unread', 'true');
    expect(withUnread).toMatchObject({ cursor: null, filters: [{ key: 'unread', operator: 'eq', value: true }] });
    const withLabel = setSimpleFilter(withUnread, 'labelId', 'label-1');
    expect(withLabel.filters).toEqual([
      { key: 'unread', operator: 'eq', value: true },
      { key: 'label_id', operator: 'eq', value: 'label-1' },
    ]);
    expect(setSimpleFilter(withLabel, 'unread', '').filters).toEqual([{ key: 'label_id', operator: 'eq', value: 'label-1' }]);
  });
});
