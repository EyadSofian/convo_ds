import { describe, expect, it } from 'vitest';
import type { ConditionDocument } from './condition.js';
import { conditionsFromFilter, filterFromConditions, filterParts } from './audience-filter.js';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';

describe('an audience filter as a saved condition document', () => {
  it('round-trips every narrowing, and names nobody-in-particular as no document', () => {
    const filter = { search: 'Sa', labelIds: [L1, L2], conversationLabelIds: [L2], contactIds: [C1] };
    const document = conditionsFromFilter(filter) as ConditionDocument;
    expect(document.root.conditions).toHaveLength(5);
    expect(filterFromConditions(document)).toEqual(filter);
    expect(filterFromConditions(conditionsFromFilter({ contactIds: [C1] }) as ConditionDocument)).toEqual({ contactIds: [C1] });
    expect(filterFromConditions(conditionsFromFilter({ labelIds: [L1] }) as ConditionDocument)).toEqual({ labelIds: [L1] });
    expect(conditionsFromFilter({})).toBeNull();
    expect(conditionsFromFilter({ labelIds: [], conversationLabelIds: [], contactIds: [] })).toBeNull();
  });

  it('refuses a document it would have to approximate', () => {
    const any: ConditionDocument = { version: 1, root: { kind: 'group', match: 'any', conditions: [{ kind: 'predicate', field: 'label_id', operator: 'eq', value: L1 }] } };
    const nested: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [any.root] } };
    const unknown: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'channel', operator: 'eq', value: 'whatsapp' }] } };
    const labelAny: ConditionDocument = { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'label_id', operator: 'in', value: [L1] }] } };
    for (const document of [any, nested, unknown, labelAny]) expect(filterFromConditions(document)).toBeNull();
  });

  it('spells out every narrowing, empty where the filter leaves it out', () => {
    expect(filterParts({})).toEqual({ search: '', labelIds: [], conversationLabelIds: [], contactIds: [] });
    expect(filterParts({ search: 'a', labelIds: [L1], conversationLabelIds: [L2], contactIds: [C1] })).toEqual({ search: 'a', labelIds: [L1], conversationLabelIds: [L2], contactIds: [C1] });
  });
});
