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

  it('accepts campaign IDs only through the closed attribution filter', () => {
    expect(parseInboxQuery(filter({ key: 'campaign_id', operator: 'eq', value: id }))).toMatchObject({
      filters: [{ key: 'campaign_id', operator: 'eq', value: id }],
    });
    expect(() => parseInboxQuery(filter({ key: 'campaign_id', operator: 'eq', value: 'Campaign Summer' }))).toThrow();
    expect(() => parseInboxQuery(filter({ key: 'campaign_name', operator: 'eq', value: 'Campaign Summer' }))).toThrow();
  });

  it('bounds search, cursor and limit', () => {
    expect(parseInboxQuery({ search: '  hello  ', limit: '100' })).toMatchObject({ search: 'hello', limit: 100 });
    expect(() => parseInboxQuery({ search: 'x'.repeat(201) })).toThrow();
    expect(() => parseInboxQuery({ cursor: 'x'.repeat(4097) })).toThrow();
    expect(() => parseInboxQuery({ cursor: 'not-a-signed-cursor' })).toThrow();
    expect(() => parseInboxQuery({ priority: 'urgent' })).toThrow();
  });

  it('rejects malformed top-level values and accepts bounded defaults', () => {
    expect(parseInboxQuery({})).toMatchObject({ queue: 'mine', sort: 'activity_desc', limit: 50, filters: [] });
    expect(parseInboxQuery({ queue: 'all', sort: 'priority_desc', limit: '1', search: '' })).toMatchObject({ queue: 'all', limit: 1, search: null });
    for (const query of [
      { queue: 'other' }, { queue: ['all'] }, { sort: 'newest' }, { sort: ['activity_desc'] },
      { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: 'abc' }, { limit: ['10'] },
      { cursor: '' }, { cursor: 'bad' }, { cursor: 'x'.repeat(4097) }, { search: ['x'] },
      { unknown: 'value' },
    ]) expect(() => parseInboxQuery(query), JSON.stringify(query)).toThrow();
  });

  it('validates custom field shape, operators and date boundaries', () => {
    expect(parseInboxQuery(filter({ key: 'custom_field', fieldId: id, operator: 'is_set' }))).toMatchObject({ filters: [{ fieldId: id, operator: 'is_set' }] });
    expect(parseInboxQuery(filter({ key: 'status', operator: 'in', value: ['open', 'pending'] }))).toMatchObject({ filters: [{ value: ['open', 'pending'] }] });
    expect(parseInboxQuery(filter({ key: 'custom_field', fieldId: id, operator: 'eq', value: false }))).toMatchObject({ filters: [{ value: false }] });
    expect(parseInboxQuery(filter({ key: 'custom_field', fieldId: id, operator: 'eq', value: 'present' }))).toMatchObject({ filters: [{ value: 'present' }] });
    for (const value of [
      { key: 'custom_field', operator: 'eq', value: 'x' },
      { key: 'custom_field', fieldId: 'bad', operator: 'eq', value: 'x' },
      { key: 'custom_field', fieldId: id, operator: 'is_set', value: true },
      { key: 'custom_field', fieldId: id, operator: 'eq' },
      { key: 'status', operator: 'eq', value: true },
      { key: 'status', operator: 'in', value: [] },
      { key: 'custom_field', fieldId: id, operator: 'eq', value: [] },
      { key: 'custom_field', fieldId: id, operator: 'eq', value: [''] },
      { key: 'status', operator: 'in', value: ['open', 'pending', 'resolved', 'archived', 'snoozed', 'open', 'pending', 'resolved', 'archived', 'snoozed', 'open', 'pending', 'resolved', 'archived', 'snoozed', 'open', 'pending', 'resolved', 'archived', 'snoozed', 'open'] },
      { key: 'created_at', operator: 'eq', value: '2026-02-30' },
    ]) expect(() => parseInboxQuery(filter(value))).toThrow();
    expect(parseInboxQuery(filter({ key: 'created_at', operator: 'after', value: '2026-02-28T12:00:00Z' }))).toMatchObject({ filters: [{ value: '2026-02-28T12:00:00Z' }] });
  });

  it('rejects malformed filters and query arrays at the HTTP boundary', () => {
    for (const query of [
      { filter: ['null'] }, { filter: 'null' }, { filter: '[]' }, { filter: '{' },
      { filter: JSON.stringify({ key: 'status', operator: 'eq' }) },
      { filter: JSON.stringify({ key: 7, operator: 'eq', value: 'open' }) },
      { filter: JSON.stringify({ key: 'status', operator: 'is_set', value: 'open' }) },
      { filter: JSON.stringify({ key: 'status', operator: 'eq', value: 'open', fieldId: id }) },
      { filter: JSON.stringify({ key: 'custom_field', operator: 'eq', fieldId: 'bad', value: 'x' }) },
      { filter: JSON.stringify({ key: 'custom_field', operator: 'in', fieldId: id, value: ['x'] }) },
      { filter: JSON.stringify({ key: 'custom_field', operator: 'eq', fieldId: id, value: 'x'.repeat(501) }) },
      { filter: JSON.stringify({ key: 'created_at', operator: 'after', value: '' }) },
      { filter: JSON.stringify({ key: 'created_at', operator: 'after', value: '2026-02-30' }) },
      { filter: JSON.stringify({ key: 'unread', operator: 'eq', value: 'true' }) },
      { filter: JSON.stringify({ key: 'status', operator: 'in', value: ['open', ...Array.from({ length: 20 }, () => 'pending')] }) },
      { filter: Array.from({ length: 21 }, () => JSON.stringify({ key: 'status', operator: 'eq', value: 'open' })) },
      { search: 'x'.repeat(201) }, { limit: '101' }, { limit: '0' },
    ]) {
      let rejected = false;
      try { parseInboxQuery(query); } catch { rejected = true; }
      expect(rejected, `expected rejection for ${JSON.stringify(query)}`).toBe(true);
    }
    expect(parseInboxQuery({ filter: JSON.stringify({ key: 'unread', operator: 'eq', value: false }) }).filters).toEqual([
      { key: 'unread', operator: 'eq', value: false },
    ]);
    for (const [key, value] of [['priority', 'urgent'], ['channel', 'whatsapp'], ['assignment_state', 'assigned']] as const) {
      expect(parseInboxQuery({ filter: JSON.stringify({ key, operator: 'eq', value }) }).filters).toMatchObject([{ key, value }]);
    }
    expect(parseInboxQuery({ filter: JSON.stringify({ key: 'assignment_state', operator: 'eq', value: 'unassigned' }) }).filters).toMatchObject([
      { key: 'assignment_state', value: 'unassigned' },
    ]);
  });
});
