export type WhatsAppTemplateComponentKind = 'header' | 'body' | 'button';

export interface WhatsAppTemplateParameterDefinition {
  readonly key: string;
  readonly component: WhatsAppTemplateComponentKind;
  readonly index: number | null;
  readonly position: number;
  readonly example: string | null;
}

export interface WhatsAppTemplateParameter {
  readonly type: 'text';
  readonly text: string;
}

export interface WhatsAppTemplateSendComponent {
  readonly type: 'header' | 'body' | 'button';
  readonly subType?: 'url';
  readonly index?: string;
  readonly parameters: readonly WhatsAppTemplateParameter[];
}

export interface WhatsAppTemplateViewComponent {
  readonly type: 'header' | 'body' | 'footer' | 'buttons';
  readonly text: string | null;
  readonly format: string | null;
  readonly buttons: readonly { readonly type: string; readonly text: string }[];
}

export interface WhatsAppTemplateDefinition {
  readonly components: readonly WhatsAppTemplateViewComponent[];
  readonly parameters: readonly WhatsAppTemplateParameterDefinition[];
  readonly sendSupported: boolean;
  readonly unsupportedReason: string | null;
}

/**
 * Derives a deliberately bounded, display-safe and send-safe model from Meta's
 * component metadata. We currently support positional text placeholders in
 * text HEADER/BODY and dynamic URL buttons. Media uploads, named parameters,
 * flows and other button parameter forms remain visible but cannot be sent.
 */
export function defineWhatsAppTemplate(raw: unknown): WhatsAppTemplateDefinition {
  if (!Array.isArray(raw)) return unsupported('Template components are unavailable.');
  const components: WhatsAppTemplateViewComponent[] = [];
  const parameters: WhatsAppTemplateParameterDefinition[] = [];
  let unsupportedReason: string | null = null;
  for (const value of raw) {
    const component = object(value);
    const rawType = typeof component?.['type'] === 'string' ? component['type'].toUpperCase() : '';
    const text = typeof component?.['text'] === 'string' ? component['text'] : null;
    const format = typeof component?.['format'] === 'string' ? component['format'].toUpperCase() : null;
    if (rawType === 'HEADER' || rawType === 'BODY') {
      const kind = rawType.toLowerCase() as 'header' | 'body';
      components.push({ type: kind, text, format, buttons: [] });
      if (kind === 'header' && format !== null && format !== 'TEXT') unsupportedReason ??= 'Media headers require a media upload and are not supported yet.';
      if (text !== null) {
        const found = placeholders(text);
        if (found === null) unsupportedReason ??= 'Named or malformed template parameters are not supported yet.';
        else for (const position of found) parameters.push({ key: `${kind}:${position}`, component: kind, index: null, position, example: exampleFor(component!, position, kind) });
      }
      continue;
    }
    if (rawType === 'FOOTER') {
      components.push({ type: 'footer', text, format: null, buttons: [] });
      continue;
    }
    if (rawType === 'BUTTONS') {
      const rawButtons = Array.isArray(component?.['buttons']) ? component['buttons'] : [];
      const buttons = rawButtons.flatMap((buttonValue) => {
        const button = object(buttonValue);
        if (button === null || typeof button['type'] !== 'string') return [];
        const type = button['type'].toUpperCase();
        const label = typeof button['text'] === 'string' ? button['text'] : '';
        if (type === 'URL' && typeof button['url'] === 'string') {
          const found = placeholders(button['url']);
          if (found === null) unsupportedReason ??= 'Named button parameters are not supported yet.';
          else for (const position of found) parameters.push({ key: `button:${rawButtons.indexOf(buttonValue)}:${position}`, component: 'button', index: rawButtons.indexOf(buttonValue), position, example: exampleFor(button, position, 'body') });
        } else if (!['QUICK_REPLY', 'PHONE_NUMBER', 'OTP', 'COPY_CODE'].includes(type)) {
          unsupportedReason ??= 'This button type is not supported yet.';
        } else if (type === 'OTP' || type === 'COPY_CODE') {
          unsupportedReason ??= 'This button type requires a specialized send flow.';
        }
        return [{ type: type.toLowerCase(), text: label }];
      });
      components.push({ type: 'buttons', text: null, format: null, buttons });
      continue;
    }
    unsupportedReason ??= 'This template contains a component that is not supported yet.';
  }
  const unique = [...new Map(parameters.map((entry) => [entry.key, entry])).values()];
  return { components, parameters: unique, sendSupported: unsupportedReason === null, unsupportedReason };
}

/** Build the official Meta component payload from server-validated values. */
export function buildWhatsAppTemplateComponents(
  definition: WhatsAppTemplateDefinition,
  supplied: Readonly<Record<string, string>>,
): readonly WhatsAppTemplateSendComponent[] | null {
  if (!definition.sendSupported) return null;
  const expected = new Set(definition.parameters.map((entry) => entry.key));
  if (Object.keys(supplied).some((key) => !expected.has(key)) || definition.parameters.some((entry) => {
    const value = supplied[entry.key]; return value === undefined || value.trim() === '' || value.length > 1024;
  })) return null;
  const result: WhatsAppTemplateSendComponent[] = [];
  for (const component of definition.components) {
    if ((component.type === 'body' || component.type === 'header') && definition.parameters.some((entry) => entry.component === component.type)) {
      result.push({ type: component.type, parameters: definition.parameters.filter((entry) => entry.component === component.type).map((entry) => ({ type: 'text', text: supplied[entry.key]! })) });
    }
  }
  for (const index of new Set(definition.parameters.filter((entry) => entry.component === 'button').map((entry) => entry.index).filter((value): value is number => value !== null))) {
    result.push({ type: 'button', subType: 'url', index: String(index), parameters: definition.parameters.filter((entry) => entry.component === 'button' && entry.index === index).map((entry) => ({ type: 'text', text: supplied[entry.key]! })) });
  }
  return result;
}

export function renderWhatsAppTemplatePreview(
  definition: WhatsAppTemplateDefinition,
  supplied: Readonly<Record<string, string>>,
): string {
  const body = definition.components.find((component) => component.type === 'body')?.text ?? '';
  return body.replace(/\{\{(\d+)\}\}/g, (match, number: string) => supplied[`body:${number}`] ?? match);
}

function placeholders(text: string): number[] | null {
  const tokens = [...text.matchAll(/\{\{([^}]+)\}\}/g)];
  const residue = text.replace(/\{\{[^}]+\}\}/g, '');
  if (residue.includes('{{') || residue.includes('}}')) return null;
  // The capture group is guaranteed by the expression above, so avoid a
  // synthetic empty-string fallback that creates an unreachable coverage arm.
  if (tokens.some((token) => !/^\d+$/.test(token[1]!))) return null;
  return [...new Set(tokens.map((token) => Number(token[1])))].sort((a, b) => a - b);
}
function exampleFor(component: Record<string, unknown>, position: number, kind: 'header' | 'body'): string | null {
  const example = object(component['example']);
  const samples = example?.[kind === 'header' ? 'header_text' : 'body_text'];
  const value = Array.isArray(samples) ? samples[0] : null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[position - 1] === 'string') return value[position - 1] as string;
  return null;
}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function unsupported(reason: string): WhatsAppTemplateDefinition { return { components: [], parameters: [], sendSupported: false, unsupportedReason: reason }; }
