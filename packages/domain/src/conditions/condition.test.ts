import { describe, expect, it } from 'vitest';
import { CONDITION_VERSION, validateConditionDocument } from './condition.js';

const predicate = (field = 'channel', operator = 'eq', value: unknown = 'whatsapp') => ({ kind: 'predicate', field, operator, value });
const document = (conditions: unknown[]) => ({ version: CONDITION_VERSION, root: { kind: 'group', match: 'all', conditions } });

describe('condition documents', () => {
  it('lets an audience narrow by conversation labels and hand-picked contacts, and nothing else does', () => {
    const picked = document([
      { kind: 'predicate', field: 'conversation_label_id', operator: 'in', value: ['11111111-1111-4111-8111-111111111111'] },
      { kind: 'predicate', field: 'contact_id', operator: 'in', value: ['22222222-2222-4222-8222-222222222222'] },
    ]);
    expect(validateConditionDocument(picked, 'audience')).toMatchObject({ ok: true });
    expect(validateConditionDocument(picked, 'routing')).toMatchObject({ ok: false });
  });

  it('accepts a nested, versioned audience tree and preserves its typed values', () => {
    const input = document([
      predicate('channel', 'in', ['whatsapp', 'instagram']),
      { kind: 'group', match: 'any', conditions: [predicate('consent', 'eq', true), predicate('custom.11111111-1111-4111-8111-111111111111', 'gte', 3)] },
    ]);
    expect(validateConditionDocument(input, 'audience')).toEqual({ ok: true, value: input });
  });

  it('keeps context-specific fields out of the wrong product surface', () => {
    expect(validateConditionDocument(document([predicate('campaign_name')]), 'conversation')).toMatchObject({ ok: true });
    expect(validateConditionDocument(document([predicate('campaign_name')]), 'audience')).toEqual({
      ok: false,
      issues: [{ path: '$.root.conditions[0].field', code: 'unsupported_field' }],
    });
    expect(validateConditionDocument(document([predicate('message_text', 'contains', 'Arabic')]), 'routing')).toMatchObject({ ok: true });
  });

  it.each([
    [null, 'invalid_shape'],
    [{ version: 2, root: {} }, 'invalid_shape'],
    [{ version: 1, root: { kind: 'group', match: 'none', conditions: [] } }, 'invalid_shape'],
    [document([]), 'invalid_shape'],
    [document([{ kind: 'other' }]), 'invalid_shape'],
    [document([predicate('custom.not-a-uuid')]), 'unsupported_field'],
    [document([predicate('channel', 'regex', 'x')]), 'unsupported_operator'],
    [document([{ kind: 'predicate', field: 'channel', operator: 'eq' }]), 'invalid_value'],
    [document([predicate('channel', 'in', [])]), 'invalid_value'],
    [document([predicate('channel', 'in', ['x', 'x'])]), 'invalid_value'],
    [document([predicate('customer_name', 'contains', '')]), 'invalid_value'],
    [document([predicate('priority', 'gt', Number.NaN)]), 'invalid_value'],
  ] as const)('rejects malformed or unsafe input %#', (input, code) => {
    const result = validateConditionDocument(input, 'conversation');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  });

  it('accepts valueless presence operators and rejects a smuggled value', () => {
    const valid = document([{ kind: 'predicate', field: 'customer_phone', operator: 'is_set' }]);
    expect(validateConditionDocument(valid, 'audience')).toMatchObject({ ok: true });
    expect(validateConditionDocument(document([predicate('customer_phone', 'is_set', true)]), 'audience')).toMatchObject({ ok: false });
  });

  it('bounds tree width, depth and total nodes', () => {
    expect(validateConditionDocument(document(Array.from({ length: 21 }, () => predicate())), 'conversation')).toMatchObject({ ok: false });
    const deep = document([{ kind: 'group', match: 'all', conditions: [{ kind: 'group', match: 'all', conditions: [{ kind: 'group', match: 'all', conditions: [{ kind: 'group', match: 'all', conditions: [predicate()] }] }] }] }]);
    expect(validateConditionDocument(deep, 'conversation')).toMatchObject({ ok: false });
    const broad = document(Array.from({ length: 20 }, () => ({ kind: 'group', match: 'all', conditions: [predicate(), predicate()] })));
    expect(validateConditionDocument(broad, 'conversation')).toMatchObject({ ok: false });
  });
});
