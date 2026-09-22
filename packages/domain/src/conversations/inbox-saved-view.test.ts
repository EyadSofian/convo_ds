import { describe, expect, it } from 'vitest';
import {
  adaptSavedViewToInboxFilters,
  inboxFiltersToSavedViewDocument,
} from './inbox-saved-view.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('Inbox saved-view adapter', () => {
  it('round-trips lossless AND-only Inbox filters through the durable condition document', () => {
    const saved = inboxFiltersToSavedViewDocument([
      { key: 'assignment_state', operator: 'eq', value: 'unassigned' },
      { key: 'label_id', operator: 'in', value: [ID] },
      { key: 'campaign_id', operator: 'eq', value: ID },
      { key: 'custom_field', fieldId: ID, operator: 'is_set' },
    ]);
    expect(saved.status).toBe('supported');
    if (saved.status !== 'supported') return;
    expect(adaptSavedViewToInboxFilters(saved.document)).toEqual({
      status: 'supported',
      filters: [
        { key: 'assignment_state', operator: 'eq', value: 'unassigned' },
        { key: 'label_id', operator: 'in', value: [ID] },
        { key: 'campaign_id', operator: 'eq', value: ID },
        { key: 'custom_field', fieldId: ID, operator: 'is_set' },
      ],
    });
  });

  it('gives legacy campaign-name saved views a precise migration warning', () => {
    const result = adaptSavedViewToInboxFilters({
      version: 1,
      root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'campaign_name', operator: 'eq', value: 'September' }] },
    });
    expect(result).toEqual({ status: 'unsupported', code: 'campaign_name_deprecated', field: 'campaign_name' });
  });

  it('does not silently weaken a saved view with OR semantics', () => {
    const result = adaptSavedViewToInboxFilters({
      version: 1,
      root: { kind: 'group', match: 'any', conditions: [{ kind: 'predicate', field: 'priority', operator: 'eq', value: 'urgent' }] },
    });
    expect(result).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'group.any' });
  });

  it('declines Inbox-only filters that the saved-view API does not support', () => {
    expect(inboxFiltersToSavedViewDocument([{ key: 'collaborator_id', operator: 'eq', value: ID }])).toEqual({
      status: 'unsupported', code: 'unsupported_condition', field: 'collaborator_id',
    });
  });
});
