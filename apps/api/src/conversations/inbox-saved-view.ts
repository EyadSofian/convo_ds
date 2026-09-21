import type { ConditionDocument, ConditionNode, ConditionPredicate, InboxFilter } from '@convo/domain';
import { inboxFilterDefinition } from '@convo/domain';

export type SavedViewInboxAdapterResult =
  | { readonly status: 'supported'; readonly filters: readonly InboxFilter[] }
  | { readonly status: 'unsupported'; readonly code: 'campaign_name_deprecated' | 'unsupported_condition'; readonly field: string };

/**
 * Saved views share the InboxQuery compiler. This adapter is intentionally
 * narrow: it exposes no SQL and declines groups that cannot retain their
 * semantics (notably OR) rather than broadening a view silently.
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
