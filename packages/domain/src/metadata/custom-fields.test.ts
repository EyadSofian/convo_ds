import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_TARGETS,
  CUSTOM_FIELD_TYPES,
  isCustomFieldTarget,
  isCustomFieldType,
  normalizeSearchText,
  validateFieldValue,
} from './custom-fields.js';

describe('typed custom fields', () => {
  it('recognises only the closed target and type vocabularies', () => {
    expect(CUSTOM_FIELD_TARGETS).toEqual(['contact', 'conversation']);
    expect(CUSTOM_FIELD_TYPES).toHaveLength(6);
    expect(isCustomFieldTarget('contact')).toBe(true);
    expect(isCustomFieldTarget('message')).toBe(false);
    expect(isCustomFieldType('multi_select')).toBe(true);
    expect(isCustomFieldType('json')).toBe(false);
  });

  it('normalizes Arabic and Latin search text without changing the original', () => {
    const original = '  مُحَمَّد École  ';
    expect(normalizeSearchText(original)).toBe('محمد ecole');
    expect(original).toBe('  مُحَمَّد École  ');
  });

  it.each([
    ['text', '  Cairo  ', true, 'cairo'],
    ['text', '', false, undefined],
    ['text', 4, false, undefined],
    ['number', 12.5, true, '12.5'],
    ['number', Number.NaN, false, undefined],
    ['number', '12', false, undefined],
    ['boolean', true, true, 'true'],
    ['boolean', false, true, 'false'],
    ['boolean', 'true', false, undefined],
    ['date', '2026-02-28', true, '2026-02-28'],
    ['date', '2026-02-30', false, undefined],
    ['date', '2026/02/28', false, undefined],
    ['date', 20260228, false, undefined],
  ] as const)('validates %s values', (type, value, ok, search) => {
    const result = validateFieldValue({ type, options: [] }, value);
    expect(result.ok).toBe(ok);
    if (result.ok) expect(result.search).toBe(search);
  });

  it('requires select values to be declared options', () => {
    const definition = { type: 'single_select' as const, options: ['New', 'Active'] };
    expect(validateFieldValue(definition, 'Active')).toMatchObject({ ok: true, value: 'Active' });
    expect(validateFieldValue(definition, 'Other')).toEqual({ ok: false, code: 'unknown_option' });
    expect(validateFieldValue(definition, 1)).toEqual({ ok: false, code: 'invalid_type' });
  });

  it('accepts a unique bounded multi-select and rejects every malformed shape', () => {
    const definition = { type: 'multi_select' as const, options: ['Arabic', 'English'] };
    expect(validateFieldValue(definition, ['English', 'Arabic'])).toEqual({
      ok: true,
      value: ['English', 'Arabic'],
      search: 'arabic\nenglish',
    });
    expect(validateFieldValue(definition, 'Arabic')).toEqual({ ok: false, code: 'invalid_type' });
    expect(validateFieldValue(definition, [1])).toEqual({ ok: false, code: 'invalid_type' });
    expect(validateFieldValue(definition, [])).toEqual({ ok: false, code: 'invalid_value' });
    expect(validateFieldValue(definition, ['Arabic', 'Arabic'])).toEqual({
      ok: false,
      code: 'invalid_value',
    });
    expect(validateFieldValue(definition, Array.from({ length: 21 }, (_, i) => String(i)))).toEqual({
      ok: false,
      code: 'invalid_value',
    });
    expect(validateFieldValue(definition, ['French'])).toEqual({
      ok: false,
      code: 'unknown_option',
    });
  });
});
