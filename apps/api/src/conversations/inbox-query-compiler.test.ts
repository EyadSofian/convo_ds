import { describe, expect, it } from 'vitest';
import type { InboxQuery, Principal } from '@convo/domain';
import { compileInboxQuery, readableScope } from './inbox-query-compiler.js';

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
    expect(compiled.where).toMatch(/inbound\.kind\s*=\s*'message'/);
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

  it('compiles every supported Inbox predicate and sort without interpolating values', () => {
    const custom = new Map([
      [label, { id: label, type: 'boolean' as const }],
      [member, { id: member, type: 'number' as const }],
    ]);
    const filters: InboxQuery['filters'] = [
      { key: 'status', operator: 'in', value: ['open', 'pending'] },
      { key: 'priority', operator: 'eq', value: 'high' },
      { key: 'channel', operator: 'in', value: ['whatsapp', 'messenger'] },
      { key: 'connection_id', operator: 'in', value: [label] },
      { key: 'team_id', operator: 'eq', value: member },
      { key: 'assigned_agent_id', operator: 'not_in', value: [member] },
      { key: 'assignment_state', operator: 'eq', value: 'assigned' },
      { key: 'label_id', operator: 'not_in', value: [label] },
      { key: 'unread', operator: 'eq', value: true },
      { key: 'unreplied', operator: 'eq', value: false },
      { key: 'created_at', operator: 'before', value: '2026-01-01' },
      { key: 'last_activity_at', operator: 'after', value: '2026-01-01' },
      { key: 'waiting_since', operator: 'is_set' },
      { key: 'customer_name', operator: 'eq', value: 'Ahmed' },
      { key: 'customer_phone', operator: 'contains', value: '1555' },
      { key: 'collaborator_id', operator: 'in', value: [member] },
      { key: 'participant_id', operator: 'eq', value: member },
      { key: 'handoff_target_id', operator: 'eq', value: member },
      { key: 'campaign_id', operator: 'in', value: [label] },
    ];
    const compiled = compileInboxQuery({ ...base, filters, search: '100%_safe' }, principal, custom);
    expect(compiled.where).toContain('NOT EXISTS');
    expect(compiled.where).toContain('campaign_conversation_attributions');
    expect(compiled.params).toContain('%100\\%\\_safe%');
    for (const sort of ['activity_asc', 'created_desc', 'created_asc', 'waiting_desc', 'priority_desc'] as const) {
      expect(compileInboxQuery({ ...base, sort }, principal, new Map()).order).toBeTruthy();
    }
  });

  it('compiles custom field type comparisons and readable scopes', () => {
    const fieldCases = [
      [{ id: label, type: 'boolean' as const }, { key: 'custom_field', fieldId: label, operator: 'eq', value: false }],
      [{ id: member, type: 'number' as const }, { key: 'custom_field', fieldId: member, operator: 'gte', value: '2' }],
      [{ id: label, type: 'date' as const }, { key: 'custom_field', fieldId: label, operator: 'before', value: '2026-01-01' }],
      [{ id: label, type: 'single_select' as const }, { key: 'custom_field', fieldId: label, operator: 'neq', value: 'VIP' }],
      [{ id: label, type: 'email' as const }, { key: 'custom_field', fieldId: label, operator: 'eq', value: 'a@example.com' }],
      [{ id: label, type: 'phone' as const }, { key: 'custom_field', fieldId: label, operator: 'contains', value: '1555' }],
    ] as const;
    for (const [field, filter] of fieldCases) expect(compileInboxQuery({ ...base, filters: [filter] }, principal, new Map([[field.id, field]])).where).toContain('custom.search_value');
    expect(compileInboxQuery({ ...base, filters: [{ key: 'custom_field', fieldId: label, operator: 'is_not_set' }] }, principal, new Map([[label, { id: label, type: 'text' as const }]])).where).toContain('NOT EXISTS');
    const own = { ...principal, grants: { 'conversation.read': 'own' as const }, scopes: [{ type: 'tenant' as const, id: null }] };
    const none = { ...principal, grants: {} };
    expect(readableScope(own, () => '$1')).toContain('own_participant');
    expect(readableScope(none, () => '$1')).toBe('FALSE');
    expect(() => compileInboxQuery({ ...base, filters: [{ key: 'custom_field', fieldId: label, operator: 'bad', value: 'x' }] }, principal, new Map([[label, { id: label, type: 'number' as const }]])).where).toThrow();
  });
});
