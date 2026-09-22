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
    ]) expect(() => parseInboxQuery(query)).toThrow();
  });

  it('validates custom field shape, operators and date boundaries', () => {
    expect(parseInboxQuery(filter({ key: 'custom_field', fieldId: id, operator: 'is_set' }))).toMatchObject({ filters: [{ fieldId: id, operator: 'is_set' }] });
    expect(parseInboxQuery(filter({ key: 'status', operator: 'in', value: ['open', 'pending'] }))).toMatchObject({ filters: [{ value: ['open', 'pending'] }] });
    expect(parseInboxQuery(filter({ key: 'custom_field', fieldId: id, operator: 'eq', value: false }))).toMatchObject({ filters: [{ value: false }] });
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
});
