import { describe, expect, it } from 'vitest';
import type { ConditionDocument } from '@convo/domain';
import { adaptSavedViewToInboxFilters } from './inbox-saved-view.js';

const fieldId = '11111111-1111-4111-8111-111111111111';
const document = (field: string, operator = 'eq', value: string | boolean = 'open'): ConditionDocument => ({
  version: 1,
  root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field, operator: operator as 'eq', value }] },
});

describe('adaptSavedViewToInboxFilters', () => {
  it('maps old conversation predicates into the shared query vocabulary', () => {
    expect(adaptSavedViewToInboxFilters(document('custom.' + fieldId, 'contains', 'gold'))).toEqual({
      status: 'supported', filters: [{ key: 'custom_field', fieldId, operator: 'contains', value: 'gold' }],
    });
  });

  it('returns campaign_name as deprecated rather than executing it', () => {
    expect(adaptSavedViewToInboxFilters(document('campaign_name'))).toEqual({
      status: 'unsupported', code: 'campaign_name_deprecated', field: 'campaign_name',
    });
  });
});
