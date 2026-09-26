import type { ConditionDocument, ConditionPredicate } from './condition.js';

/**
 * Who a message to many people is addressed to: contacts narrowed by name,
 * by labels they carry, by labels on their conversations, or hand-picked.
 * Every list narrows; an absent or empty one does not.
 *
 * A saved audience stores the same thing as a condition document, so both a
 * campaign and an automation can reach "the audience called VIPs". The two
 * conversions here are exact: a document that says anything a filter cannot
 * express is refused rather than approximated, because approximating an
 * audience would message people it did not name.
 */
export interface AudienceFilter {
  readonly search?: string;
  readonly labelIds?: readonly string[];
  readonly conversationLabelIds?: readonly string[];
  readonly contactIds?: readonly string[];
}

/** The condition document a saved audience stores for a filter; `null` for "everyone". */
export function conditionsFromFilter(filter: AudienceFilter): ConditionDocument | null {
  const conditions: ConditionPredicate[] = [];
  if (filter.search !== undefined) conditions.push({ kind: 'predicate', field: 'customer_name', operator: 'contains', value: filter.search });
  for (const id of filter.labelIds ?? []) conditions.push({ kind: 'predicate', field: 'label_id', operator: 'eq', value: id });
  const conversationLabelIds = filter.conversationLabelIds ?? [];
  if (conversationLabelIds.length > 0) conditions.push({ kind: 'predicate', field: 'conversation_label_id', operator: 'in', value: conversationLabelIds });
  const contactIds = filter.contactIds ?? [];
  if (contactIds.length > 0) conditions.push({ kind: 'predicate', field: 'contact_id', operator: 'in', value: contactIds });
  return conditions.length === 0 ? null : { version: 1, root: { kind: 'group', match: 'all', conditions } };
}

/**
 * The filter a saved audience describes, or `null` when it uses anything a
 * filter cannot apply exactly — a nested group, an "any" match, or a field
 * and operator this model never writes.
 */
export function filterFromConditions(document: ConditionDocument): AudienceFilter | null {
  if (document.root.match !== 'all') return null;
  let search: string | undefined;
  const labelIds: string[] = [];
  const conversationLabelIds: string[] = [];
  const contactIds: string[] = [];
  for (const node of document.root.conditions) {
    if (node.kind !== 'predicate') return null;
    const { field, operator, value } = node;
    if (field === 'customer_name' && operator === 'contains' && typeof value === 'string') search = value;
    else if (field === 'label_id' && operator === 'eq' && typeof value === 'string') labelIds.push(value);
    else if (field === 'conversation_label_id' && operator === 'in' && Array.isArray(value)) conversationLabelIds.push(...(value as readonly string[]));
    else if (field === 'contact_id' && operator === 'in' && Array.isArray(value)) contactIds.push(...(value as readonly string[]));
    else return null;
  }
  return {
    ...(search === undefined ? {} : { search }),
    ...(labelIds.length === 0 ? {} : { labelIds }),
    ...(conversationLabelIds.length === 0 ? {} : { conversationLabelIds }),
    ...(contactIds.length === 0 ? {} : { contactIds }),
  };
}

/** Every narrowing of a filter, with the ones it leaves out as empty. */
export function filterParts(filter: AudienceFilter): {
  readonly search: string;
  readonly labelIds: readonly string[];
  readonly conversationLabelIds: readonly string[];
  readonly contactIds: readonly string[];
} {
  return {
    search: filter.search ?? '',
    labelIds: filter.labelIds ?? [],
    conversationLabelIds: filter.conversationLabelIds ?? [],
    contactIds: filter.contactIds ?? [],
  };
}
