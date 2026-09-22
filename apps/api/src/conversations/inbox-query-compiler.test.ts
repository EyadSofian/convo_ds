import { describe, expect, it } from 'vitest';
import type { InboxQuery, Principal } from '@convo/domain';
import { compileInboxQuery } from './inbox-query-compiler.js';

const member = '11111111-1111-4111-8111-111111111111';
const label = '22222222-2222-4222-8222-222222222222';
const principal: Principal = {
  membershipId: member,
  membershipStatus: 'active',
  tenantStatus: 'active',
  grants: { 'conversation.read': 'scoped' },
  scopes: [{ type: 'tenant', id: null }],
  delegationCeiling: null,
};

const base: InboxQuery = { queue: 'all', search: null, sort: 'activity_desc', cursor: null, limit: 50, filters: [] };

describe('compileInboxQuery', () => {
  it('binds browser strings and implements labels as ALL', () => {
    const query: InboxQuery = {
      ...base,
      search: "100%_safe' OR TRUE --",
      filters: [
        { key: 'label_id', operator: 'in', value: [label, member] },
        { key: 'customer_name', operator: 'contains', value: "O'Hara" },
      ],
    };
    const compiled = compileInboxQuery(query, principal, new Map());
    expect(compiled.where).toContain('count(DISTINCT label.label_id)');
    expect(compiled.where).toContain('cardinality(');
    expect(compiled.where).not.toContain("O'Hara");
    expect(compiled.where).not.toContain('100%_safe');
    expect(compiled.params).toContain("%O'Hara%");
    expect(compiled.params).toContain('%100\\%\\_safe\' OR TRUE --%');
  });

  it('uses the authenticated membership for unread, never a filter value', () => {
    const compiled = compileInboxQuery({ ...base, filters: [{ key: 'unread', operator: 'eq', value: true }] }, principal, new Map());
    expect(compiled.where).toContain('r.read_through');
    expect(compiled.params).toEqual([true]);
  });

  it('keeps human outbound evidence distinct from automation sends', () => {
    const compiled = compileInboxQuery({ ...base, filters: [{ key: 'unreplied', operator: 'eq', value: true }] }, principal, new Map());
    expect(compiled.where).toContain('outbound.author_membership IS NOT NULL');
    expect(compiled.where).toContain("inbound.kind = 'message'");
  });

  it('normalizes scalar membership filters to UUID arrays', () => {
    const compiled = compileInboxQuery({ ...base, filters: [{ key: 'participant_id', operator: 'eq', value: member }] }, principal, new Map());
    expect(compiled.where).toContain('participant.membership_id = ANY(');
    expect(compiled.params).toEqual([[member]]);
  });

  it('filters on immutable campaign attribution rather than campaign names', () => {
    const compiled = compileInboxQuery({ ...base, filters: [{ key: 'campaign_id', operator: 'eq', value: label }] }, principal, new Map());
    expect(compiled.where).toContain('campaign_conversation_attributions attribution');
    expect(compiled.where).toContain('attribution.campaign_id = ANY(');
    expect(compiled.where).toContain('ANY(ARRAY(SELECT');
    expect(compiled.where).not.toContain('campaign_name');
    expect(compiled.params).toEqual([[label]]);
  });

  it('honours a typed boolean custom-field inequality', () => {
    const compiled = compileInboxQuery(
      { ...base, filters: [{ key: 'custom_field', fieldId: label, operator: 'neq', value: true }] },
      principal,
      new Map([[label, { id: label, type: 'boolean' }]]),
    );
    expect(compiled.where).toContain('custom.search_value');
    expect(compiled.where).toContain('<>');
    expect(compiled.params).toContain('true');
  });

  it('matches text custom fields through their normalized search representation', () => {
    const compiled = compileInboxQuery(
      { ...base, filters: [{ key: 'custom_field', fieldId: label, operator: 'contains', value: 'ÉYAD' }] },
      principal,
      new Map([[label, { id: label, type: 'text' }]]),
    );
    expect(compiled.where).toContain('custom.search_value ILIKE');
    expect(compiled.params).toContain('%eyad%');
  });
});
