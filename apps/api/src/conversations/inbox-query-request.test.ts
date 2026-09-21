import { describe, expect, it } from 'vitest';
import { parseInboxQuery } from './inbox-query-request.js';

const id = '11111111-1111-4111-8111-111111111111';
const filter = (value: unknown) => ({ filter: JSON.stringify(value) });

describe('parseInboxQuery', () => {
  it('accepts closed semantic filters', () => {
    const parsed = parseInboxQuery({
      ...filter({ key: 'assigned_agent_id', operator: 'eq', value: id }),
      sort: 'activity_desc',
    });
    expect(parsed.filters).toHaveLength(1);
  });

  it('rejects unsupported operators and values', () => {
    expect(() => parseInboxQuery(filter({ key: 'assigned_agent_id', operator: 'contains', value: id }))).toThrow();
    expect(() => parseInboxQuery(filter({ key: 'status', operator: 'eq', value: 'made_up' }))).toThrow();
    expect(() => parseInboxQuery(filter({ key: 'team_id', operator: 'eq', value: 'not-a-uuid' }))).toThrow();
  });

  it('bounds search, cursor and limit', () => {
    expect(parseInboxQuery({ search: '  hello  ', limit: '100' })).toMatchObject({ search: 'hello', limit: 100 });
    expect(() => parseInboxQuery({ search: 'x'.repeat(201) })).toThrow();
    expect(() => parseInboxQuery({ cursor: 'x'.repeat(4097) })).toThrow();
    expect(() => parseInboxQuery({ cursor: 'not-a-signed-cursor' })).toThrow();
    expect(() => parseInboxQuery({ priority: 'urgent' })).toThrow();
  });
});
