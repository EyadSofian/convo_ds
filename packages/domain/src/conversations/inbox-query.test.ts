import { describe, expect, it } from 'vitest';
import { INBOX_QUERY_DEFAULT, isInboxQuery } from './inbox-query.js';

describe('InboxQuery', () => {
  it('accepts a bounded closed query contract', () => {
    expect(isInboxQuery({ ...INBOX_QUERY_DEFAULT, filters: [{ key: 'assigned_agent_id', operator: 'eq', value: '11111111-1111-4111-8111-111111111111' }] })).toBe(true);
  });
  it('rejects unknown keys, sorts and unbounded pages', () => {
    expect(isInboxQuery({ ...INBOX_QUERY_DEFAULT, sort: 'DROP TABLE' })).toBe(false);
    expect(isInboxQuery({ ...INBOX_QUERY_DEFAULT, filters: [{ key: 'sql', operator: 'eq', value: 'x' }] })).toBe(false);
    expect(isInboxQuery({ ...INBOX_QUERY_DEFAULT, limit: 101 })).toBe(false);
  });
  it('rejects malformed query shapes at every optional boundary', () => {
    const malformed = [
      null, [], { ...INBOX_QUERY_DEFAULT, filters: null },
      { ...INBOX_QUERY_DEFAULT, filters: Array.from({ length: 21 }, () => ({ key: 'status', operator: 'eq', value: 'open' })) },
      { ...INBOX_QUERY_DEFAULT, queue: 'other' }, { ...INBOX_QUERY_DEFAULT, search: 2 },
      { ...INBOX_QUERY_DEFAULT, sort: 'other' }, { ...INBOX_QUERY_DEFAULT, cursor: 2 },
      { ...INBOX_QUERY_DEFAULT, limit: 0 }, { ...INBOX_QUERY_DEFAULT, limit: 1.5 },
      { ...INBOX_QUERY_DEFAULT, filters: [null] }, { ...INBOX_QUERY_DEFAULT, filters: [[]] },
      { ...INBOX_QUERY_DEFAULT, filters: [{ key: 'unknown', operator: 'eq' }] },
      { ...INBOX_QUERY_DEFAULT, filters: [{ key: 'status', operator: 1 }] },
      { ...INBOX_QUERY_DEFAULT, filters: [{ key: 'status', operator: 'eq', value: [] }] },
      { ...INBOX_QUERY_DEFAULT, filters: [{ key: 'status', operator: 'eq', fieldId: 1 }] },
    ];
    for (const value of malformed) expect(isInboxQuery(value)).toBe(false);
  });
  it('accepts bounded scalar and string-list filter values', () => {
    expect(isInboxQuery({ ...INBOX_QUERY_DEFAULT, queue: 'all', search: '', cursor: '', limit: 100, filters: [
      { key: 'status', operator: 'in', value: ['open', 'pending'] },
      { key: 'unread', operator: 'eq', value: false },
      { key: 'custom_field', fieldId: 'field-1', operator: 'is_set' },
    ] })).toBe(true);
  });
});
