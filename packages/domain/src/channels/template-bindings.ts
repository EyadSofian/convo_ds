import type { WhatsAppTemplateDefinition } from './whatsapp-template.js';

/**
 * Where each `{{n}}` of an approved WhatsApp template gets its value when one
 * message goes to many people — a broadcast, or an automation step.
 *
 * The same model serves both, so a template that works in a campaign works the
 * same way in an automation:
 *
 * - `display_name` — the contact's name;
 * - `phone` — the identity the message is sent to;
 * - `field` — one of the contact's custom fields;
 * - `static` — the same text for everybody.
 *
 * A `fallback` is used when the contact has no value, so a missing name
 * becomes "there" rather than a message nobody can send. A parameter with
 * neither a value nor a fallback leaves that recipient out.
 */
export type TemplateBindingSource = 'display_name' | 'phone' | 'field' | 'static';

export interface TemplateBinding {
  readonly source: TemplateBindingSource;
  readonly fieldId?: string;
  readonly value?: string;
  readonly fallback?: string;
}

export type TemplateBindings = Readonly<Record<string, TemplateBinding>>;

export const TEMPLATE_BINDING_SOURCES: readonly TemplateBindingSource[] = ['display_name', 'phone', 'field', 'static'];

const PARAMETER_KEY = /^(?:(?:header|body):\d{1,2}|button:\d{1,2}:\d{1,2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 1024;

/** The bindings, normalised, or `null` when any of them is malformed. */
export function parseTemplateBindings(raw: unknown): TemplateBindings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const bindings: Record<string, TemplateBinding> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const binding = parseBinding(entry);
    if (!PARAMETER_KEY.test(key) || binding === null) return null;
    bindings[key] = binding;
  }
  return bindings;
}

function parseBinding(raw: unknown): TemplateBinding | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const source = entry['source'];
  const fallback = text(entry['fallback']);
  if (fallback === null) return null;
  const extra = fallback === '' ? {} : { fallback };
  if (source === 'display_name' || source === 'phone') return { source, ...extra };
  if (source === 'field') {
    const fieldId = entry['fieldId'];
    return typeof fieldId === 'string' && UUID.test(fieldId) ? { source, fieldId: fieldId.toLowerCase(), ...extra } : null;
  }
  if (source === 'static') {
    const value = text(entry['value']);
    return value === null || value === '' ? null : { source, value };
  }
  return null;
}

/** Optional text: absent is empty, anything but bounded text is malformed. */
function text(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' && raw.trim().length <= MAX_TEXT ? raw.trim() : null;
}

/** Whether every parameter the template has is bound, and nothing else is. */
export function bindingsComplete(definition: WhatsAppTemplateDefinition, bindings: TemplateBindings): boolean {
  const expected = new Set(definition.parameters.map((entry) => entry.key));
  const bound = Object.keys(bindings);
  return definition.sendSupported && bound.length === expected.size && bound.every((key) => expected.has(key));
}

/** A parameter key as a variable name: `body:1` → `body_1`. */
export function variableKeyOf(parameterKey: string): string {
  return parameterKey.replace(/:/g, '_');
}

/**
 * The binding as the one string a frozen audience resolves per contact:
 * `display_name`, `phone`, `field:<uuid>` or `static:<text>`.
 */
export function bindingVariable(binding: TemplateBinding): string {
  if (binding.source === 'field') return `field:${binding.fieldId!}`;
  if (binding.source === 'static') return `static:${binding.value!}`;
  return binding.source;
}

/** Whether a stored variable source is one this model writes. */
export function isBindingVariable(value: unknown): boolean {
  if (value === 'display_name' || value === 'phone') return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('field:')) return UUID.test(value.slice(6));
  return value.startsWith('static:') && value.length > 7 && value.length <= 7 + MAX_TEXT;
}

/**
 * The value of every parameter for one recipient, from what `valueOf` finds
 * for each binding, falling back where it finds nothing. `null` when any
 * parameter ends up with no text: that message cannot be sent.
 */
export function resolveTemplateValues(
  bindings: TemplateBindings,
  valueOf: (key: string, binding: TemplateBinding) => unknown,
): Readonly<Record<string, string>> | null {
  const values: Record<string, string> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    const found = valueOf(key, binding);
    const direct = typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean' ? String(found).trim() : '';
    const value = binding.source === 'static' ? binding.value! : direct === '' ? binding.fallback ?? '' : direct;
    if (value === '') return null;
    values[key] = value.slice(0, MAX_TEXT);
  }
  return values;
}
