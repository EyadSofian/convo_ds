/**
 * The business-field vocabulary shared by the API, filters and browser.
 *
 * A field definition chooses one type once. Values are validated here before
 * they reach SQL, and the original value is kept beside a normalized search
 * representation. This keeps Arabic text byte-for-byte intact while making a
 * search for the same text without tashkeel deterministic (CT-05).
 */

export const CUSTOM_FIELD_TARGETS = ['contact', 'conversation'] as const;
export type CustomFieldTarget = (typeof CUSTOM_FIELD_TARGETS)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'boolean',
  'date',
  'email',
  'phone',
  'single_select',
  'multi_select',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDefinition {
  readonly type: CustomFieldType;
  readonly options: readonly string[];
}

export type CustomFieldValue = string | number | boolean | readonly string[];

export type FieldValueResult =
  | { readonly ok: true; readonly value: CustomFieldValue; readonly search: string }
  | { readonly ok: false; readonly code: 'invalid_type' | 'invalid_value' | 'unknown_option' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE = /^\+[1-9]\d{6,14}$/;

export function isCustomFieldTarget(value: string): value is CustomFieldTarget {
  return (CUSTOM_FIELD_TARGETS as readonly string[]).includes(value);
}

export function isCustomFieldType(value: string): value is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

/** A stable representation used only for matching; the original is never changed. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/gu, '')
    .toLocaleLowerCase('und')
    .trim();
}

export function validateFieldValue(
  definition: CustomFieldDefinition,
  candidate: unknown,
): FieldValueResult {
  if (definition.type === 'text') {
    if (typeof candidate !== 'string') return { ok: false, code: 'invalid_type' };
    const trimmed = candidate.trim();
    return trimmed.length === 0 || trimmed.length > 500
      ? { ok: false, code: 'invalid_value' }
      : { ok: true, value: candidate, search: normalizeSearchText(candidate) };
  }
  if (definition.type === 'number') {
    return typeof candidate !== 'number' || !Number.isFinite(candidate)
      ? { ok: false, code: 'invalid_type' }
      : { ok: true, value: candidate, search: String(candidate) };
  }
  if (definition.type === 'boolean') {
    return typeof candidate !== 'boolean'
      ? { ok: false, code: 'invalid_type' }
      : { ok: true, value: candidate, search: candidate ? 'true' : 'false' };
  }
  if (definition.type === 'date') {
    if (typeof candidate !== 'string') return { ok: false, code: 'invalid_type' };
    return validDate(candidate)
      ? { ok: true, value: candidate, search: candidate }
      : { ok: false, code: 'invalid_value' };
  }
  if (definition.type === 'email') {
    if (typeof candidate !== 'string') return { ok: false, code: 'invalid_type' };
    const value = candidate.trim();
    return value.length <= 254 && EMAIL.test(value)
      ? { ok: true, value, search: value.toLocaleLowerCase('und') }
      : { ok: false, code: 'invalid_value' };
  }
  if (definition.type === 'phone') {
    if (typeof candidate !== 'string') return { ok: false, code: 'invalid_type' };
    const value = candidate.replace(/[\s().-]/gu, '');
    return PHONE.test(value)
      ? { ok: true, value, search: value }
      : { ok: false, code: 'invalid_value' };
  }
  if (definition.type === 'single_select') {
    if (typeof candidate !== 'string') return { ok: false, code: 'invalid_type' };
    return definition.options.includes(candidate)
      ? { ok: true, value: candidate, search: normalizeSearchText(candidate) }
      : { ok: false, code: 'unknown_option' };
  }
  if (!Array.isArray(candidate) || candidate.some((value) => typeof value !== 'string')) {
    return { ok: false, code: 'invalid_type' };
  }
  const values = candidate as string[];
  if (values.length === 0 || values.length > 20 || new Set(values).size !== values.length) {
    return { ok: false, code: 'invalid_value' };
  }
  return values.every((value) => definition.options.includes(value))
    ? { ok: true, value: values, search: values.map(normalizeSearchText).sort().join('\n') }
    : { ok: false, code: 'unknown_option' };
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
