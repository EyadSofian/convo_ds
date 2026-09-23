import { createHash } from 'node:crypto';
import { normalizeSearchText, type CustomFieldType, type InboxFilter, type InboxQuery, type Principal } from '@convo/domain';
import { conversationUnrepliedPredicate } from './event-boundary.js';

export interface InboxCustomField {
  readonly id: string;
  readonly type: CustomFieldType;
}

export interface CompiledInboxQuery {
  readonly where: string;
  readonly params: readonly unknown[];
  readonly order: string;
  readonly fingerprint: string;
}

/** Browser values only ever become bound values. This module owns all SQL. */
export function compileInboxQuery(
  query: InboxQuery,
  principal: Principal,
  customFields: ReadonlyMap<string, InboxCustomField>,
): CompiledInboxQuery {
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = ["c.status <> 'archived'", readableScope(principal, add)];
  if (query.queue === 'mine') clauses.push(`c.assignee_membership_id = ${add(principal.membershipId)}::uuid`);
  for (const filter of query.filters) clauses.push(predicate(filter, customFields, add));
  if (query.search !== null) clauses.push(searchPredicate(query.search, add));
  return {
    where: clauses.join(' AND '),
    params,
    order: sortOf(query.sort),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ queue: query.queue, filters: query.filters, search: query.search, sort: query.sort }))
      .digest('hex'),
  };
}

function predicate(filter: InboxFilter, customFields: ReadonlyMap<string, InboxCustomField>, add: (value: unknown) => string): string {
  const one = () => add(filter.value as string | boolean);
  const many = () => add(filter.value as readonly string[]);
  switch (filter.key) {
    case 'status': return listOrOne('c.status', filter.operator, one, many, 'text');
    case 'priority': return listOrOne('c.priority', filter.operator, one, many, 'text');
    case 'channel': return listOrOne('n.kind', filter.operator, one, many, 'text');
    case 'connection_id': return listOrOne('c.connection_id', filter.operator, one, many, 'uuid');
    case 'team_id': return listOrOne('c.team_id', filter.operator, one, many, 'uuid');
    case 'assigned_agent_id': return listOrOne('c.assignee_membership_id', filter.operator, one, many, 'uuid');
    case 'assignment_state': return filter.value === 'assigned' ? 'c.assignee_membership_id IS NOT NULL' : 'c.assignee_membership_id IS NULL';
    case 'label_id': return labelPredicate(filter, add);
    case 'unread': return `(r.read_through IS NULL OR r.read_through < c.last_activity_at) = ${one()}::boolean`;
    case 'unreplied': return unrepliedPredicate(one());
    case 'created_at': return datePredicate('c.created_at', filter.operator, one);
    case 'last_activity_at': return datePredicate('c.last_activity_at', filter.operator, one);
    case 'waiting_since': return filter.operator === 'is_set' ? 'c.waiting_since IS NOT NULL' : datePredicate('c.waiting_since', filter.operator, one);
    case 'customer_name': return textPredicate('(SELECT search_name FROM contacts customer WHERE customer.id = c.contact_id)', filter.operator, filter.value as string, add);
    case 'customer_phone': return textPredicate('(SELECT external_id FROM contact_identities phone WHERE phone.contact_id = c.contact_id AND phone.valid_to IS NULL ORDER BY phone.valid_from DESC LIMIT 1)', filter.operator, filter.value as string, add);
    case 'collaborator_id': return membershipExists('conversation_collaborators', 'collaborator', 'membership_id', filter, add, 'collaborator.removed_at IS NULL');
    case 'participant_id': return membershipExists('conversation_participants', 'participant', 'membership_id', filter, add, 'TRUE');
    case 'handoff_target_id': return membershipExists('conversation_handoffs', 'handoff', 'to_membership_id', filter, add, "handoff.state = 'pending'");
    case 'campaign_id': return campaignAttributionPredicate(filter, add);
    case 'custom_field': return customPredicate(filter, customFields.get(filter.fieldId ?? ''), add);
  }
}

function campaignAttributionPredicate(filter: InboxFilter, add: (value: unknown) => string): string {
  const values = Array.isArray(filter.value) ? filter.value : [filter.value as string];
  return `c.id = ANY(ARRAY(SELECT attribution.conversation_id FROM campaign_conversation_attributions attribution WHERE attribution.campaign_id = ANY(${add(values)}::uuid[])))`;
}

function listOrOne(column: string, operator: string, one: () => string, many: () => string, cast: 'text' | 'uuid'): string {
  if (operator === 'eq') return `${column} = ${one()}::${cast}`;
  if (operator === 'in') return `${column} = ANY(${many()}::${cast}[])`;
  if (operator === 'not_in') return `${column} <> ALL(${many()}::${cast}[])`;
  throw new Error(`Unexpected validated list operator: ${operator}`);
}

function labelPredicate(filter: InboxFilter, add: (value: unknown) => string): string {
  const value = filter.value as readonly string[] | string;
  const ids = Array.isArray(value) ? value : [value];
  const parameter = add(ids);
  if (filter.operator === 'not_in') return `NOT EXISTS (SELECT 1 FROM conversation_labels label WHERE label.conversation_id = c.id AND label.removed_at IS NULL AND label.label_id = ANY(${parameter}::uuid[]))`;
  return `(SELECT count(DISTINCT label.label_id) FROM conversation_labels label WHERE label.conversation_id = c.id AND label.removed_at IS NULL AND label.label_id = ANY(${parameter}::uuid[])) = cardinality(${parameter}::uuid[])`;
}

function membershipExists(table: string, alias: string, column: string, filter: InboxFilter, add: (value: unknown) => string, extra: string): string {
  const ids = Array.isArray(filter.value) ? filter.value : [filter.value as string];
  return `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${alias}.conversation_id = c.id AND ${extra} AND ${alias}.${column} = ANY(${add(ids)}::uuid[]))`;
}

function unrepliedPredicate(value: string): string {
  return `${conversationUnrepliedPredicate('c')} = ${value}::boolean`;
}

function datePredicate(column: string, operator: string, one: () => string): string {
  if (operator === 'before') return `${column} < ${one()}::timestamptz`;
  if (operator === 'after') return `${column} > ${one()}::timestamptz`;
  throw new Error(`Unexpected validated date operator: ${operator}`);
}

function textPredicate(column: string, operator: string, value: string, add: (value: unknown) => string): string {
  if (operator === 'eq') return `${column} = ${add(value)}`;
  if (operator === 'contains') return `${column} ILIKE ${add(`%${escapeLike(value)}%`)} ESCAPE '\\'`;
  throw new Error(`Unexpected validated text operator: ${operator}`);
}

function customPredicate(filter: InboxFilter, field: InboxCustomField | undefined, add: (value: unknown) => string): string {
  if (field === undefined) throw new Error('Custom field must be validated before compilation.');
  const id = add(field.id);
  const exists = (condition: string) => `EXISTS (SELECT 1 FROM conversation_custom_field_values custom WHERE custom.conversation_id = c.id AND custom.field_id = ${id}::uuid AND ${condition})`;
  if (filter.operator === 'is_set') return exists('TRUE');
  if (filter.operator === 'is_not_set') return `NOT ${exists('TRUE')}`;
  if (field.type === 'boolean') return exists(`custom.search_value ${filter.operator === 'neq' ? '<>' : '='} ${add(String(filter.value === true))}`);
  if (field.type === 'number') return exists(`custom.search_value::numeric ${comparison(filter.operator)} ${add(filter.value)}::numeric`);
  if (field.type === 'date') return exists(`custom.search_value ${comparison(filter.operator === 'before' ? 'lt' : filter.operator === 'after' ? 'gt' : filter.operator)} ${add(filter.value)}`);
  if (field.type === 'single_select') return exists(`custom.search_value ${filter.operator === 'neq' ? '<>' : '='} ${add(normalizeSearchText(String(filter.value)))}`);
  if (field.type === 'text' || field.type === 'email' || field.type === 'phone') {
    const value = normalizeSearchText(String(filter.value));
    if (filter.operator === 'contains') return exists(`custom.search_value ILIKE ${add(`%${escapeLike(value)}%`)} ESCAPE '\\'`);
    return exists(`custom.search_value ${filter.operator === 'neq' ? '<>' : '='} ${add(value)}`);
  }
  throw new Error(`Unsupported validated custom field type: ${field.type}`);
}

function comparison(operator: string): string {
  switch (operator) {
    case 'eq': return '=';
    case 'neq': return '<>';
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
    default: throw new Error(`Unexpected validated comparison operator: ${operator}`);
  }
}

function searchPredicate(search: string, add: (value: unknown) => string): string {
  const text = add(`%${escapeLike(search)}%`);
  const id = add(search);
  return `(c.id::text = ${id} OR c.peer_identity ILIKE ${text} ESCAPE '\\' OR EXISTS (SELECT 1 FROM contacts search_contact WHERE search_contact.id = c.contact_id AND search_contact.search_name ILIKE ${text} ESCAPE '\\') OR EXISTS (SELECT 1 FROM contact_identities search_identity WHERE search_identity.contact_id = c.contact_id AND search_identity.external_id ILIKE ${text} ESCAPE '\\'))`;
}

export function readableScope(principal: Principal, add: (value: unknown) => string): string {
  const grant = principal.grants['conversation.read'] ?? 'none';
  if (grant === 'tenant') return 'TRUE';
  const teams = principal.scopes.filter((scope) => scope.type === 'team').map((scope) => scope.id);
  const inboxes = principal.scopes.filter((scope) => scope.type === 'inbox').map((scope) => scope.id);
  const scoped = principal.scopes.some((scope) => scope.type === 'tenant') ? 'TRUE' : `(c.team_id = ANY(${add(teams)}::uuid[]) OR c.connection_id = ANY(${add(inboxes)}::uuid[]))`;
  if (grant === 'scoped') return scoped;
  if (grant === 'own') {
    const member = add(principal.membershipId);
    return `(${scoped} AND (c.assignee_membership_id = ${member}::uuid OR EXISTS (SELECT 1 FROM conversation_participants own_participant WHERE own_participant.conversation_id = c.id AND own_participant.membership_id = ${member}::uuid) OR EXISTS (SELECT 1 FROM conversation_collaborators own_collaborator WHERE own_collaborator.conversation_id = c.id AND own_collaborator.removed_at IS NULL AND own_collaborator.membership_id = ${member}::uuid)))`;
  }
  return 'FALSE';
}

function sortOf(sort: InboxQuery['sort']): string {
  switch (sort) {
    case 'activity_asc': return 'c.last_activity_at ASC, c.id ASC';
    case 'created_desc': return 'c.created_at DESC, c.id DESC';
    case 'created_asc': return 'c.created_at ASC, c.id ASC';
    case 'waiting_desc': return 'c.waiting_since DESC NULLS LAST, c.id DESC';
    case 'priority_desc': return "CASE c.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC, c.id DESC";
    default: return 'c.last_activity_at DESC, c.id DESC';
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
