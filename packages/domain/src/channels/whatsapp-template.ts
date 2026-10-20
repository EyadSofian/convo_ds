export type WhatsAppTemplateComponentKind = 'header' | 'body' | 'button';

export interface WhatsAppTemplateParameterDefinition {
  readonly key: string;
  readonly component: WhatsAppTemplateComponentKind;
  readonly index: number | null;
  readonly position: number;
  readonly example: string | null;
  readonly name?: string;
  readonly mediaFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
}

export type WhatsAppTemplateParameter =
  | { readonly type: 'text'; readonly text: string; readonly parameter_name?: string }
  | { readonly type: 'image'; readonly image: { readonly link: string } }
  | { readonly type: 'video'; readonly video: { readonly link: string } }
  | { readonly type: 'document'; readonly document: { readonly link: string } };

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
 * component metadata. Text HEADER/BODY support positional and named placeholders;
 * HTTPS media headers and dynamic URL buttons are supported too. Flows and
 * specialized buttons remain visible but cannot be sent from this editor.
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
      if (kind === 'header' && format !== null && format !== 'TEXT') {
        if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
          parameters.push({ key: 'header:0', component: 'header', index: null, position: 0, example: null, mediaFormat: format });
        } else unsupportedReason ??= `Header format ${format} is not supported yet.`;
      }
      if (text !== null) {
        const found = textPlaceholders(text);
        if (found === null) unsupportedReason ??= /\{\{\s*\}\}/.test(text)
          ? 'This Meta template has empty {{}} variables. Name or number each variable in WhatsApp Manager, then sync templates again.'
          : 'Malformed or mixed template parameters are not supported.';
        else found.forEach((token, index) => {
          const name = /^\d+$/.test(token) ? undefined : token;
          const position = name === undefined ? Number(token) : index + 1;
          parameters.push({ key: `${kind}:${token}`, component: kind, index: null, position, example: exampleFor(component!, position, kind, name), ...(name === undefined ? {} : { name }) });
        });
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
  const media = definition.parameters.find((entry) => entry.mediaFormat !== undefined);
  if (media !== undefined && !isPublicHttpsTemplateMediaUrl(supplied[media.key]!)) return null;
  const result: WhatsAppTemplateSendComponent[] = [];
  for (const component of definition.components) {
    if (component.type === 'header' && media !== undefined) {
      const link = supplied[media.key]!;
      const parameter: WhatsAppTemplateParameter = media.mediaFormat === 'IMAGE'
        ? { type: 'image', image: { link } }
        : media.mediaFormat === 'VIDEO'
          ? { type: 'video', video: { link } }
          : { type: 'document', document: { link } };
      result.push({ type: 'header', parameters: [parameter] });
      continue;
    }
    if ((component.type === 'body' || component.type === 'header') && definition.parameters.some((entry) => entry.component === component.type)) {
      result.push({ type: component.type, parameters: definition.parameters.filter((entry) => entry.component === component.type && entry.mediaFormat === undefined).map((entry) => ({ type: 'text', text: supplied[entry.key]!, ...(entry.name === undefined ? {} : { parameter_name: entry.name }) })) });
    }
  }
  for (const index of new Set(definition.parameters.filter((entry) => entry.component === 'button').map((entry) => entry.index).filter((value): value is number => value !== null))) {
    result.push({ type: 'button', subType: 'url', index: String(index), parameters: definition.parameters.filter((entry) => entry.component === 'button' && entry.index === index).map((entry) => ({ type: 'text', text: supplied[entry.key]! })) });
  }
  return result;
}

export function isPublicHttpsTemplateMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || host === 'localhost' || host.endsWith('.localhost')) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(host)) return false;
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host.split('.').map(Number) : null;
    return ipv4 === null || !(ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31);
  } catch { return false; }
}

export function renderWhatsAppTemplatePreview(
  definition: WhatsAppTemplateDefinition,
  supplied: Readonly<Record<string, string>>,
): string {
  const body = definition.components.find((component) => component.type === 'body')?.text ?? '';
  return body.replace(/\{\{([^}]+)\}\}/g, (match, token: string) => supplied[`body:${token}`] ?? match);
}

function textPlaceholders(text: string): string[] | null {
  const tokens = [...text.matchAll(/\{\{([^}]+)\}\}/g)];
  const residue = text.replace(/\{\{[^}]+\}\}/g, '');
  if (residue.includes('{{') || residue.includes('}}')) return null;
  const values = [...new Set(tokens.map((token) => token[1]!))];
  const positional = values.every((value) => /^[1-9]\d{0,2}$/.test(value));
  const named = values.every((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value));
  if (!positional && !named) return null;
  return positional ? values.sort((a, b) => Number(a) - Number(b)) : values;
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
function exampleFor(component: Record<string, unknown>, position: number, kind: 'header' | 'body', name?: string): string | null {
  const example = object(component['example']);
  if (name !== undefined) {
    const named = example?.[kind === 'header' ? 'header_text_named_params' : 'body_text_named_params'];
    const matched = Array.isArray(named) ? named.map(object).find((entry) => entry?.['param_name'] === name) : undefined;
    if (typeof matched?.['example'] === 'string') return matched['example'];
  }
  const samples = example?.[kind === 'header' ? 'header_text' : 'body_text'];
  const value = Array.isArray(samples) ? samples[0] : null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[position - 1] === 'string') return value[position - 1] as string;
  return null;
}
function object(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function unsupported(reason: string): WhatsAppTemplateDefinition { return { components: [], parameters: [], sendSupported: false, unsupportedReason: reason }; }
