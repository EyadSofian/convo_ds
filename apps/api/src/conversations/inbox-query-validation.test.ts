import { describe, expect, it, vi } from 'vitest';
import type { InboxQuery, SqlExecutor } from '@convo/domain';
import { validateInboxQuery } from './inbox-query-validation.js';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const base: InboxQuery = { queue: 'all', filters: [], search: null, sort: 'activity_desc', cursor: null, limit: 50 };

function sqlFor(rows: readonly { id: string; type?: string }[] = [{ id }]): SqlExecutor {
  return { query: vi.fn(async <T>(text: string) => ({ rows: (text.includes('custom_fields') ? rows : rows.map(({ id: value }) => ({ id: value }))) as T[], rowCount: rows.length })) } as unknown as SqlExecutor;
}

describe('validateInboxQuery', () => {
  it('does no database work for an unfiltered query', async () => {
    const sql = sqlFor();
    await expect(validateInboxQuery(sql, base)).resolves.toEqual(new Map());
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('validates tenant-scoped references and returns custom field metadata', async () => {
    const sql = sqlFor([{ id, type: 'text' }]);
    const query = { ...base, filters: [
      { key: 'assigned_agent_id', operator: 'eq', value: id },
      { key: 'team_id', operator: 'eq', value: id },
      { key: 'connection_id', operator: 'eq', value: id },
      { key: 'label_id', operator: 'eq', value: id },
      { key: 'custom_field', fieldId: id, operator: 'contains', value: 'vip' },
    ] } as InboxQuery;
    const fields = await validateInboxQuery(sql, query);
    expect(fields.get(id)).toEqual({ id, type: 'text' });
    expect(sql.query).toHaveBeenCalledTimes(5);
  });

  it('rejects missing references and incomplete custom-field rows', async () => {
    await expect(validateInboxQuery(sqlFor([]), { ...base, filters: [{ key: 'label_id', operator: 'eq', value: id }] })).rejects.toMatchObject({ status: 400 });
    await expect(validateInboxQuery(sqlFor([{ id, type: 'text' }]), { ...base, filters: [{ key: 'custom_field', fieldId: other, operator: 'eq', value: 'x' }] })).rejects.toMatchObject({ status: 400 });
    await expect(validateInboxQuery(sqlFor([]), { ...base, filters: [{ key: 'custom_field', fieldId: id, operator: 'eq', value: 'x' }] })).rejects.toMatchObject({ status: 400 });
  });

  it('validates multi-value references after flattening and deduplicating them', async () => {
    const query: InboxQuery = { ...base, filters: [
      { key: 'assigned_agent_id', operator: 'in', value: [id, other, id] },
      { key: 'label_id', operator: 'not_in', value: [id, other] },
      { key: 'custom_field', fieldId: id, operator: 'eq', value: 'x' },
    ] };
    const sql = { query: vi.fn(async <T>(text: string) => text.includes('custom_fields')
      ? { rows: [{ id, type: 'text' }] as T[], rowCount: 1 }
      : { rows: [{ id }, { id: other }] as T[], rowCount: 2 }) } as unknown as SqlExecutor;
    await expect(validateInboxQuery(sql, query)).resolves.toHaveProperty('size', 1);
    expect(sql.query).toHaveBeenCalledTimes(3);
  });

  it('fails closed for an internal custom-field filter with no field id', async () => {
    const sql = sqlFor([]);
    await expect(validateInboxQuery(sql, { ...base, filters: [{ key: 'custom_field', operator: 'eq', value: 'x' } as never] }))
      .rejects.toMatchObject({ status: 400 });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('enforces each supported custom field type and rejects unsupported comparisons', async () => {
    const cases: Array<[string, string, unknown, boolean]> = [
      ['boolean', 'eq', true, true], ['boolean', 'neq', false, true], ['boolean', 'contains', true, false],
      ['number', 'eq', '12.5', true], ['number', 'neq', '12.5', true], ['number', 'eq', 'nope', false],
      ['date', 'eq', '2026-02-28', true], ['date', 'neq', '2026-02-28', true], ['date', 'eq', '2026-02-30', false], ['date', 'eq', 'not-a-date', false],
      ['single_select', 'eq', 'vip', true], ['single_select', 'contains', 'vip', false],
      ['text', 'contains', 'vip', true], ['text', 'in', 'vip', false],
      ['email', 'eq', 'a@example.com', true], ['phone', 'contains', '123', true],
      ['multi_select', 'eq', 'vip', false],
    ];
    for (const [type, operator, value, valid] of cases) {
      const sql = sqlFor([{ id, type }]);
      const promise = validateInboxQuery(sql, { ...base, filters: [{ key: 'custom_field', fieldId: id, operator, value }] } as InboxQuery);
      if (valid) await expect(promise).resolves.toBeInstanceOf(Map);
      else await expect(promise).rejects.toMatchObject({ status: 400 });
    }
    await expect(validateInboxQuery(sqlFor([{ id, type: 'multi_select' }]), { ...base, filters: [{ key: 'custom_field', fieldId: id, operator: 'is_set' }] } as InboxQuery)).resolves.toBeInstanceOf(Map);
  });
});
