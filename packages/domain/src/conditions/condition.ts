/**
 * Versioned condition trees shared by views, audiences, routing, labels and
 * automation. This module validates shape and vocabulary only. Each consumer
 * compiles the accepted tree to parameterized SQL or evaluates it against a
 * trusted event projection; no consumer interpolates field names from input.
 */

export const CONDITION_VERSION = 1 as const;
export const CONDITION_OPERATORS = [
  'eq', 'neq', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte',
  'before', 'after', 'is_set', 'is_not_set',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type ConditionContext = 'conversation' | 'audience' | 'routing' | 'label_rule' | 'automation';
export type ConditionScalar = string | number | boolean;

export interface ConditionPredicate {
  readonly kind: 'predicate';
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: ConditionScalar | readonly ConditionScalar[];
}

export interface ConditionGroup {
  readonly kind: 'group';
  readonly match: 'all' | 'any';
  readonly conditions: readonly ConditionNode[];
}

export type ConditionNode = ConditionPredicate | ConditionGroup;

export interface ConditionDocument {
  readonly version: typeof CONDITION_VERSION;
  readonly root: ConditionGroup;
}

export interface ConditionIssue {
  readonly path: string;
  readonly code: 'invalid_shape' | 'unsupported_field' | 'unsupported_operator' | 'invalid_value' | 'too_complex';
}

export type ConditionValidation =
  | { readonly ok: true; readonly value: ConditionDocument }
  | { readonly ok: false; readonly issues: readonly ConditionIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOM_FIELD = /^custom\.([0-9a-f-]+)$/i;
const MAX_DEPTH = 4;
const MAX_NODES = 50;
const MAX_GROUP_CHILDREN = 20;

const FIELD_SETS: Readonly<Record<ConditionContext, ReadonlySet<string>>> = {
  conversation: new Set([
    'channel', 'team_id', 'assigned_agent_id', 'status', 'priority', 'label_id',
    'customer_name', 'customer_phone', 'created_at', 'last_message_at', 'waiting_since',
    'unread', 'unreplied', 'unassigned', 'connection_id', 'campaign_id',
    // Kept only to surface old saved views as deprecated; new UI never writes it.
    'campaign_name',
  ]),
  audience: new Set([
    'channel', 'customer_status', 'label_id', 'last_contact_at', 'consent',
    'created_at', 'customer_name', 'customer_phone',
  ]),
  routing: new Set([
    'channel', 'customer_status', 'label_id', 'created_at', 'customer_name',
    'customer_phone', 'message_text', 'business_hours',
  ]),
  label_rule: new Set([
    'channel', 'customer_status', 'label_id', 'created_at', 'customer_name',
    'customer_phone', 'message_text', 'conversation_status', 'priority',
  ]),
  automation: new Set([
    'trigger', 'channel', 'team_id', 'assigned_agent_id', 'conversation_status',
    'customer_status', 'priority', 'label_id', 'created_at', 'last_contact_at',
    'customer_name', 'customer_phone', 'consent',
  ]),
};

const VALUELESS = new Set<ConditionOperator>(['is_set', 'is_not_set']);
const LIST = new Set<ConditionOperator>(['in', 'not_in']);
const TEXT = new Set<ConditionOperator>(['contains']);

export function validateConditionDocument(input: unknown, context: ConditionContext): ConditionValidation {
  const record = object(input);
  if (record === null || record['version'] !== CONDITION_VERSION) {
    return { ok: false, issues: [{ path: '$', code: 'invalid_shape' }] };
  }
  const issues: ConditionIssue[] = [];
  const count = { value: 0 };
  const root = readGroup(record['root'], '$.root', context, 1, count, issues);
  if (root === null) return { ok: false, issues };
  return issues.length === 0
    ? { ok: true, value: { version: CONDITION_VERSION, root } }
    : { ok: false, issues };
}

function readGroup(
  input: unknown,
  path: string,
  context: ConditionContext,
  depth: number,
  count: { value: number },
  issues: ConditionIssue[],
): ConditionGroup | null {
  const record = object(input);
  count.value += 1;
  if (depth > MAX_DEPTH || count.value > MAX_NODES) {
    issues.push({ path, code: 'too_complex' });
    return null;
  }
  if (record === null || record['kind'] !== 'group' || (record['match'] !== 'all' && record['match'] !== 'any') || !Array.isArray(record['conditions'])) {
    issues.push({ path, code: 'invalid_shape' });
    return null;
  }
  if (record['conditions'].length === 0 || record['conditions'].length > MAX_GROUP_CHILDREN) {
    issues.push({ path: `${path}.conditions`, code: record['conditions'].length > MAX_GROUP_CHILDREN ? 'too_complex' : 'invalid_shape' });
    return null;
  }
  const conditions: ConditionNode[] = [];
  for (const [index, candidate] of record['conditions'].entries()) {
    const childPath = `${path}.conditions[${String(index)}]`;
    const childRecord = object(candidate);
    if (childRecord?.['kind'] === 'group') {
      const group = readGroup(candidate, childPath, context, depth + 1, count, issues);
      if (group !== null) conditions.push(group);
    } else {
      const predicate = readPredicate(candidate, childPath, context, count, issues);
      if (predicate !== null) conditions.push(predicate);
    }
  }
  return { kind: 'group', match: record['match'], conditions };
}

function readPredicate(
  input: unknown,
  path: string,
  context: ConditionContext,
  count: { value: number },
  issues: ConditionIssue[],
): ConditionPredicate | null {
  count.value += 1;
  if (count.value > MAX_NODES) {
    issues.push({ path, code: 'too_complex' });
    return null;
  }
  const record = object(input);
  if (record === null || record['kind'] !== 'predicate' || typeof record['field'] !== 'string' || typeof record['operator'] !== 'string') {
    issues.push({ path, code: 'invalid_shape' });
    return null;
  }
  const field = record['field'];
  if (!fieldAllowed(field, context)) issues.push({ path: `${path}.field`, code: 'unsupported_field' });
  const operator = record['operator'];
  if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
    issues.push({ path: `${path}.operator`, code: 'unsupported_operator' });
    return null;
  }
  const typedOperator = operator as ConditionOperator;
  if (!valueAllowed(typedOperator, record['value'], Object.hasOwn(record, 'value'))) {
    issues.push({ path: `${path}.value`, code: 'invalid_value' });
  }
  return Object.hasOwn(record, 'value')
    ? { kind: 'predicate', field, operator: typedOperator, value: record['value'] as ConditionScalar | readonly ConditionScalar[] }
    : { kind: 'predicate', field, operator: typedOperator };
}

function fieldAllowed(field: string, context: ConditionContext): boolean {
  if (FIELD_SETS[context].has(field)) return true;
  const match = CUSTOM_FIELD.exec(field);
  return match !== null && UUID.test(match[1] as string);
}

function valueAllowed(operator: ConditionOperator, value: unknown, supplied: boolean): boolean {
  if (VALUELESS.has(operator)) return !supplied;
  if (!supplied) return false;
  if (LIST.has(operator)) {
    return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
      value.every(scalar) && new Set(value.map((item) => JSON.stringify(item))).size === value.length;
  }
  if (TEXT.has(operator)) return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
  return scalar(value);
}

function scalar(value: unknown): value is ConditionScalar {
  return typeof value === 'boolean' ||
    (typeof value === 'string' && value.length > 0 && value.length <= 500) ||
    (typeof value === 'number' && Number.isFinite(value));
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
