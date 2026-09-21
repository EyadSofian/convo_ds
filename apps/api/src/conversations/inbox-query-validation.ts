import type { CustomFieldType, InboxFilter, InboxQuery, SqlExecutor } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';
import type { InboxCustomField } from './inbox-query-compiler.js';

/**
 * Tenant-scoped semantic checks that cannot live in the shape-only domain
 * guard. Every lookup runs under the request's RLS transaction; callers get
 * the same generic invalid-query response for absent and cross-tenant IDs.
 */
export async function validateInboxQuery(sql: SqlExecutor, query: InboxQuery): Promise<ReadonlyMap<string, InboxCustomField>> {
  await assertReferences(sql, query.filters, 'assigned_agent_id', 'memberships');
  await assertReferences(sql, query.filters, 'collaborator_id', 'memberships');
  await assertReferences(sql, query.filters, 'participant_id', 'memberships');
  await assertReferences(sql, query.filters, 'handoff_target_id', 'memberships');
  await assertReferences(sql, query.filters, 'team_id', 'teams');
  await assertReferences(sql, query.filters, 'connection_id', 'channel_connections');
  await assertReferences(sql, query.filters, 'label_id', 'labels');

  const ids = [...new Set(query.filters.filter((filter) => filter.key === 'custom_field').map((filter) => filter.fieldId ?? ''))];
  if (ids.length === 0) return new Map();
  const fields = await sql.query<{ id: string; type: CustomFieldType }>(
    "SELECT id::text, type FROM custom_fields WHERE target = 'conversation' AND id = ANY($1::uuid[])",
    [ids],
  );
  if (fields.rows.length !== ids.length) throw invalidQuery();
  const byId = new Map(fields.rows.map((field) => [field.id, field] as const));
  for (const filter of query.filters) {
    if (filter.key !== 'custom_field') continue;
    const field = byId.get(filter.fieldId ?? '');
    if (field === undefined || !validCustomFilter(field.type, filter)) throw invalidQuery();
  }
  return byId;
}

async function assertReferences(sql: SqlExecutor, filters: readonly InboxFilter[], key: InboxFilter['key'], table: string): Promise<void> {
  const values = filters.filter((filter) => filter.key === key).flatMap((filter) => Array.isArray(filter.value) ? filter.value : [filter.value as string]);
  const ids = [...new Set(values)];
  if (ids.length === 0) return;
  // `table` is selected only by the fixed caller list above, never by input.
  const result = await sql.query<{ id: string }>(`SELECT id::text FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  if (result.rows.length !== ids.length) throw invalidQuery();
}

function validCustomFilter(type: CustomFieldType, filter: InboxFilter): boolean {
  if (filter.operator === 'is_set' || filter.operator === 'is_not_set') return true;
  if (type === 'boolean') return (filter.operator === 'eq' || filter.operator === 'neq') && typeof filter.value === 'boolean';
  if (type === 'number') return (filter.operator === 'eq' || filter.operator === 'neq') && typeof filter.value === 'string' && Number.isFinite(Number(filter.value));
  if (type === 'date') return (filter.operator === 'eq' || filter.operator === 'neq') && typeof filter.value === 'string' && isDate(filter.value);
  if (type === 'single_select') return (filter.operator === 'eq' || filter.operator === 'neq') && typeof filter.value === 'string';
  if (type === 'text' || type === 'email' || type === 'phone') return (filter.operator === 'eq' || filter.operator === 'contains') && typeof filter.value === 'string';
  // Multi-select comparison needs an explicit set semantic. It is intentionally
  // unsupported until that product/API contract exists.
  return false;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function invalidQuery(): ApiHttpError {
  return new ApiHttpError(400, 'validation_failed', 'The Inbox query is not valid.', [{ field: 'filter', code: 'invalid', message: 'Use a supported query value.' }]);
}
