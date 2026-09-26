import type {
  TemplateBinding,
  TemplateBindings,
  TemplateBindingSource,
  WhatsAppTemplateDefinition,
  WhatsAppTemplateParameterDefinition,
} from '@convo/domain';
import { defineWhatsAppTemplate, parseTemplateBindings, TEMPLATE_BINDING_SOURCES } from '@convo/domain';
import type { WhatsAppTemplate } from '../api/automations.js';
import type { CustomField } from '../api/metadata.js';

/**
 * Filling an approved WhatsApp template for many people, as the operator sets
 * it up: for each `{{n}}`, where its value comes from. The broadcast wizard and
 * the automation step share this, and the server reads the same bindings.
 */

export type BindingPart = 'source' | 'field' | 'value' | 'fallback';

/**
 * The form key for one part of one parameter's binding. A parameter key has
 * colons (`body:1`) and the generic form collector splits on the first colon,
 * so they become underscores here.
 */
export function bindingKey(prefix: string, parameter: string, part: BindingPart): string {
  return `${prefix}${parameter.replace(/:/g, '_')}_${part}`;
}

/** The first header or body variable is usually a name; anything else is text the operator types. */
export function defaultSource(parameter: WhatsAppTemplateParameterDefinition): TemplateBindingSource {
  return parameter.component !== 'button' && parameter.position === 1 ? 'display_name' : 'static';
}

export function templateDefinition(template: WhatsAppTemplate): WhatsAppTemplateDefinition {
  return defineWhatsAppTemplate(template.components);
}

/** The bindings a saved step or campaign holds, or none when they do not read. */
export function storedBindings(raw: unknown): TemplateBindings {
  return parseTemplateBindings(raw) ?? {};
}

export interface BindingDraft {
  readonly bindings: TemplateBindings;
  /** The source chosen for every parameter, bound or not yet. */
  readonly sources: Readonly<Record<string, TemplateBindingSource>>;
  /** Parameters whose chosen source still needs a field or a text. */
  readonly missing: readonly string[];
}

/**
 * The bindings on screen: what was typed, falling back to what was saved, and
 * to a sensible source for a parameter nobody has touched.
 */
export function bindingsFromForm(
  form: Readonly<Record<string, string>>,
  prefix: string,
  definition: WhatsAppTemplateDefinition,
  stored: TemplateBindings,
): BindingDraft {
  const bindings: Record<string, TemplateBinding> = {};
  const sources: Record<string, TemplateBindingSource> = {};
  const missing: string[] = [];
  for (const parameter of definition.parameters) {
    const saved = stored[parameter.key];
    const typed = (part: BindingPart): string | undefined => form[bindingKey(prefix, parameter.key, part)];
    const chosen = typed('source') ?? saved?.source;
    const source = (TEMPLATE_BINDING_SOURCES as readonly (string | undefined)[]).includes(chosen) ? chosen as TemplateBindingSource : defaultSource(parameter);
    sources[parameter.key] = source;
    const fallback = (typed('fallback') ?? saved?.fallback ?? '').trim();
    const extra = fallback === '' ? {} : { fallback };
    if (source === 'field') {
      const fieldId = typed('field') ?? saved?.fieldId ?? '';
      if (fieldId === '') missing.push(parameter.key);
      else bindings[parameter.key] = { source, fieldId, ...extra };
    } else if (source === 'static') {
      const value = (typed('value') ?? saved?.value ?? '').trim();
      if (value === '') missing.push(parameter.key);
      else bindings[parameter.key] = { source, value };
    } else {
      bindings[parameter.key] = { source, ...extra };
    }
  }
  return { bindings, sources, missing };
}

export interface PreviewSample {
  readonly name: string;
  readonly phone: string;
}

/** What each variable shows in the preview: a sample contact, a field's name, or the typed text. */
export function sampleValues(
  definition: WhatsAppTemplateDefinition,
  bindings: TemplateBindings,
  fields: readonly CustomField[],
  sample: PreviewSample,
): Readonly<Record<string, string>> {
  return Object.fromEntries(definition.parameters.map((parameter) => {
    const binding = bindings[parameter.key];
    const value = binding === undefined ? `{{${String(parameter.position)}}}`
      : binding.source === 'display_name' ? sample.name
        : binding.source === 'phone' ? sample.phone
          : binding.source === 'static' ? binding.value!
            : `[${fields.find((field) => field.id === binding.fieldId)?.name ?? '…'}]`;
    return [parameter.key, value];
  }));
}

/** One stretch of template text: plain, or a variable with its key and what it shows. */
export type TemplateSegment = { readonly text: string } | { readonly key: string; readonly value: string };

/** Splits a header or body into text and variables, for a preview that marks what varies. */
export function templateSegments(
  text: string,
  component: 'header' | 'body',
  values: Readonly<Record<string, string>>,
): readonly TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    const key = `${component}:${match[1]!}`;
    segments.push({ key, value: values[key] ?? match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
