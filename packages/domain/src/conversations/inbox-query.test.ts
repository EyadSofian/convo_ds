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
});
