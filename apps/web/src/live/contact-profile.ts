import type { CustomField, FieldType } from '../api/metadata.js';
import type { Lang } from '../format.js';

/**
 * The profile a new contact is created with.
 *
 * Contact details are typed fields in the company's own catalogue, never free
 * attributes, so the same "email" or "company" is searchable, filterable and
 * editable everywhere a field is. The standard set below is what a support
 * team expects on a customer card; a company that has not created one of them
 * yet gets it created the first time somebody fills it in.
 */

export interface StandardField {
  readonly key: string;
  readonly type: FieldType;
  readonly ar: string;
  readonly en: string;
  readonly placeholder: string;
  readonly wide?: boolean;
}

export const STANDARD_CONTACT_FIELDS: readonly StandardField[] = [
  { key: 'email', type: 'email', ar: 'البريد الإلكتروني', en: 'Email', placeholder: 'name@example.com' },
  { key: 'phone', type: 'phone', ar: 'رقم الهاتف', en: 'Phone', placeholder: '+201001234567' },
  { key: 'company', type: 'text', ar: 'الشركة أو المدرسة', en: 'Company', placeholder: 'Digital School' },
  { key: 'job_title', type: 'text', ar: 'المسمى الوظيفي', en: 'Job title', placeholder: 'Parent, Teacher…' },
  { key: 'city', type: 'text', ar: 'المدينة', en: 'City', placeholder: 'Cairo' },
  { key: 'country', type: 'text', ar: 'الدولة', en: 'Country', placeholder: 'Egypt' },
  { key: 'notes', type: 'text', ar: 'نبذة', en: 'About', placeholder: '', wide: true },
];

/** The form key a standard field's value is typed into. */
export function standardFieldKey(key: string): string {
  return `newContact_${key}`;
}

/** The form key a catalogue field's value is typed into. */
export function customFieldKey(fieldId: string): string {
  return `newContactField_${fieldId}`;
}

export interface NewContactField {
  /** `null` when the standard field does not exist yet and must be created. */
  readonly fieldId: string | null;
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  readonly value: unknown;
}

/** A typed value from what was typed; `null` for an empty box. */
export function typedValue(type: FieldType, raw: string): unknown {
  const value = raw.trim();
  if (value === '') return null;
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === 'true';
  if (type === 'multi_select') return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9 ().-]{6,20}$/;

/**
 * What the operator filled in, as field writes, plus the problems to show on
 * the form. Standard fields map onto the catalogue by key; ones the catalogue
 * lacks are created only when the operator may manage it, otherwise they are
 * not offered at all.
 */
export function newContactFields(
  form: Readonly<Record<string, string>>,
  catalogue: readonly CustomField[],
  mayManageCatalogue: boolean,
  lang: Lang,
): { readonly fields: readonly NewContactField[]; readonly errors: Readonly<Record<string, string>> } {
  const active = catalogue.filter((field) => field.target === 'contact' && field.state === 'active');
  const fields: NewContactField[] = [];
  const errors: Record<string, string> = {};
  for (const standard of STANDARD_CONTACT_FIELDS) {
    const existing = active.find((field) => field.key === standard.key);
    if (existing === undefined && !mayManageCatalogue) continue;
    const formKey = standardFieldKey(standard.key);
    const type = existing?.type ?? standard.type;
    const value = typedValue(type, form[formKey] ?? '');
    if (value === null) continue;
    if (type === 'email' && !EMAIL.test(value as string)) {
      errors[formKey] = lang === 'ar' ? 'اكتب بريدًا صحيحًا مثل name@example.com.' : 'Enter an email such as name@example.com.';
      continue;
    }
    if (type === 'phone' && !PHONE.test(value as string)) {
      errors[formKey] = lang === 'ar' ? 'اكتب الرقم بالصيغة الدولية مثل +201001234567.' : 'Use the international format, e.g. +201001234567.';
      continue;
    }
    fields.push({ fieldId: existing?.id ?? null, key: standard.key, name: lang === 'ar' ? standard.ar : standard.en, type, value });
  }
  const standardKeys = new Set(STANDARD_CONTACT_FIELDS.map((standard) => standard.key));
  for (const field of active) {
    if (standardKeys.has(field.key)) continue;
    const value = typedValue(field.type, form[customFieldKey(field.id)] ?? '');
    if (value !== null) fields.push({ fieldId: field.id, key: field.key, name: field.name, type: field.type, value });
  }
  return { fields, errors };
}

/** The hint under the channel ID box, in the terms of the chosen channel. */
export function channelIdHint(kind: string | undefined, lang: Lang): string {
  const hints: Readonly<Record<string, readonly [string, string]>> = {
    whatsapp: ['رقم واتساب بالصيغة الدولية بدون +، مثل 201001234567.', 'The WhatsApp number in international form without +, e.g. 201001234567.'],
    messenger: ['معرّف العميل الخاص بالصفحة (PSID) من ماسنجر.', 'The customer’s page-scoped ID (PSID) from Messenger.'],
    instagram: ['معرّف العميل الخاص بالحساب (IGSID) من إنستجرام.', 'The customer’s Instagram-scoped ID (IGSID).'],
    web_chat: ['معرّف الزائر الذي يرسله الموقع.', 'The visitor ID your website sends.'],
    custom: ['المعرّف الذي يستخدمه نظامك لهذا العميل.', 'The ID your own system uses for this customer.'],
  };
  const [ar, en] = hints[kind ?? ''] ?? ['اختر القناة أولًا.', 'Choose the channel first.'];
  return lang === 'ar' ? ar : en;
}
