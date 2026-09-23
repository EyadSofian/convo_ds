import type { ConditionDocument, ConditionNode, ConditionPredicate } from '../conditions/condition.js';
import { inboxFilterDefinition } from './inbox-filters.js';
import type { InboxFilter } from './inbox-query.js';

export type SavedViewInboxAdapterResult =
  | { readonly status: 'supported'; readonly filters: readonly InboxFilter[] }
  | { readonly status: 'unsupported'; readonly code: 'campaign_name_deprecated' | 'unsupported_condition'; readonly field: string };

/**
 * The sole translation boundary between the durable condition document used by
 * saved views and the closed InboxQuery filter vocabulary. It deliberately
 * declines OR trees and unmappable conditions rather than weakening a saved
 * view's meaning on the way into the Inbox.
 */
export function adaptSavedViewToInboxFilters(document: ConditionDocument): SavedViewInboxAdapterResult {
  const predicates = flattenAll(document.root);
  if (predicates === null) return { status: 'unsupported', code: 'unsupported_condition', field: 'group.any' };
  const filters: InboxFilter[] = [];
  for (const predicate of predicates) {
    if (predicate.field === 'campaign_name') return { status: 'unsupported', code: 'campaign_name_deprecated', field: predicate.field };
    const mapped = mapPredicate(predicate);
    if (mapped === null) return { status: 'unsupported', code: 'unsupported_condition', field: predicate.field };
    filters.push(mapped);
  }
  return { status: 'supported', filters };
}

/** Converts only lossless Inbox filters into an AND-only saved-view document. */
export function inboxFiltersToSavedViewDocument(filters: readonly InboxFilter[]):
  | { readonly status: 'supported'; readonly document: ConditionDocument }
  | { readonly status: 'unsupported'; readonly code: 'unsupported_condition'; readonly field: string } {
  if (filters.length === 0) return { status: 'unsupported', code: 'unsupported_condition', field: 'empty' };
  const conditions: ConditionPredicate[] = [];
  for (const filter of filters) {
    const definition = inboxFilterDefinition(filter.key);
    if (definition === null || !definition.savedView) return { status: 'unsupported', code: 'unsupported_condition', field: filter.key };
    if (filter.key === 'assignment_state') {
      if (filter.operator !== 'eq' || (filter.value !== 'assigned' && filter.value !== 'unassigned')) return { status: 'unsupported', code: 'unsupported_condition', field: filter.key };
      conditions.push({ kind: 'predicate', field: 'unassigned', operator: 'eq', value: filter.value === 'unassigned' });
      continue;
    }
    const field = filter.key === 'custom_field'
      ? filter.fieldId === undefined ? null : `custom.${filter.fieldId}`
      : filter.key === 'last_activity_at' ? 'last_message_at' : filter.key;
    if (field === null) return { status: 'unsupported', code: 'unsupported_condition', field: filter.key };
    conditions.push({
      kind: 'predicate', field, operator: filter.operator as ConditionPredicate['operator'],
      ...(filter.value === undefined ? {} : { value: filter.value }),
    });
  }
  return { status: 'supported', document: { version: 1, root: { kind: 'group', match: 'all', conditions } } };
}

function flattenAll(node: ConditionNode): readonly ConditionPredicate[] | null {
  if (node.kind === 'predicate') return [node];
  if (node.match !== 'all') return null;
  const flattened: ConditionPredicate[] = [];
  for (const child of node.conditions) {
    const next = flattenAll(child);
    if (next === null) return null;
    flattened.push(...next);
  }
  return flattened;
}

function mapPredicate(predicate: ConditionPredicate): InboxFilter | null {
  if (predicate.field === 'unassigned') {
    if (predicate.operator !== 'eq' || typeof predicate.value !== 'boolean') return null;
    return { key: 'assignment_state', operator: 'eq', value: predicate.value ? 'unassigned' : 'assigned' };
  }
  const custom = /^custom\.([0-9a-f-]+)$/i.exec(predicate.field);
  const key = custom === null ? predicate.field === 'last_message_at' ? 'last_activity_at' : predicate.field : 'custom_field';
  const definition = inboxFilterDefinition(key);
  if (definition === null || !definition.savedView || !definition.operators.includes(predicate.operator)) return null;
  const value = predicate.value;
  if ((predicate.operator === 'is_set' || predicate.operator === 'is_not_set') && value !== undefined) return null;
  if (predicate.operator !== 'is_set' && predicate.operator !== 'is_not_set' && value === undefined) return null;
  if (typeof value === 'number' || Array.isArray(value) && !value.every((item) => typeof item === 'string')) return null;
  return {
    key: definition.key,
    operator: predicate.operator,
    ...(value === undefined ? {} : { value: value as string | boolean | readonly string[] }),
    ...(custom === null ? {} : { fieldId: custom[1] as string }),
  };
}
