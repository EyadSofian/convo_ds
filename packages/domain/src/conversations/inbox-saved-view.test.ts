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

  it('preserves nested ALL groups and rejects nested ANY or unmappable predicates', () => {
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'status', operator: 'eq', value: 'open' }] },
    ] } })).toEqual({ status: 'supported', filters: [{ key: 'status', operator: 'eq', value: 'open' }] });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'group', match: 'any', conditions: [{ kind: 'predicate', field: 'status', operator: 'eq', value: 'open' }] },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'group.any' });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'unassigned', operator: 'eq', value: 'wrong-type' },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'unassigned' });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'unknown', operator: 'eq', value: 'open' },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'unknown' });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'unassigned', operator: 'eq', value: false },
    ] } })).toEqual({ status: 'supported', filters: [{ key: 'assignment_state', operator: 'eq', value: 'assigned' }] });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'last_message_at', operator: 'after', value: '2026-01-01' },
    ] } })).toEqual({ status: 'supported', filters: [{ key: 'last_activity_at', operator: 'after', value: '2026-01-01' }] });
  });

  it('rejects empty, valueless and malformed Inbox filters on saved-view conversion', () => {
    expect(inboxFiltersToSavedViewDocument([])).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'empty' });
    expect(inboxFiltersToSavedViewDocument([{ key: 'custom_field', operator: 'eq', value: 'x' }])).toEqual({
      status: 'unsupported', code: 'unsupported_condition', field: 'custom_field',
    });
    expect(inboxFiltersToSavedViewDocument([{ key: 'custom_field', fieldId: ID, operator: 'is_set', value: 'unexpected' }])).toEqual({
      status: 'supported', document: { version: 1, root: { kind: 'group', match: 'all', conditions: [
        { kind: 'predicate', field: `custom.${ID}`, operator: 'is_set', value: 'unexpected' },
      ] } },
    });
    expect(inboxFiltersToSavedViewDocument([{ key: 'custom_field', fieldId: ID, operator: 'eq', value: 'gold' }])).toMatchObject({
      status: 'supported', document: { root: { conditions: [{ field: `custom.${ID}`, value: 'gold' }] } },
    });
    expect(inboxFiltersToSavedViewDocument([{ key: 'assignment_state', operator: 'eq', value: 'unknown' }])).toEqual({
      status: 'unsupported', code: 'unsupported_condition', field: 'assignment_state',
    });
    expect(inboxFiltersToSavedViewDocument([{ key: 'last_activity_at', operator: 'after', value: '2026-01-01' }])).toMatchObject({
      status: 'supported', document: { root: { conditions: [{ field: 'last_message_at' }] } },
    });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: `custom.${ID}`, operator: 'is_set', value: 'unexpected' },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: `custom.${ID}` });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'priority', operator: 'eq' },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'priority' });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'priority', operator: 'eq', value: 1 },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'priority' });
    expect(adaptSavedViewToInboxFilters({ version: 1, root: { kind: 'group', match: 'all', conditions: [
      { kind: 'predicate', field: 'priority', operator: 'eq', value: ['open', 1] },
    ] } })).toEqual({ status: 'unsupported', code: 'unsupported_condition', field: 'priority' });
  });
});
