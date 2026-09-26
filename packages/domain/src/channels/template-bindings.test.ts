import { describe, expect, it } from 'vitest';
import {
  bindingsComplete,
  bindingVariable,
  isBindingVariable,
  parseTemplateBindings,
  resolveTemplateValues,
  variableKeyOf,
} from './template-bindings.js';
import { defineWhatsAppTemplate } from './whatsapp-template.js';

const FIELD = '11111111-1111-4111-8111-111111111111';

const TEMPLATE = defineWhatsAppTemplate([
  { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
  { type: 'BODY', text: 'Your class {{1}} starts on {{2}}.' },
  { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://school.example/c/{{1}}' }] },
]);

describe('reading bindings', () => {
  it('keeps each source with what it needs, trimmed', () => {
    expect(parseTemplateBindings({
      'header:1': { source: 'display_name', fallback: ' there ' },
      'body:1': { source: 'field', fieldId: FIELD.toUpperCase() },
      'body:2': { source: 'static', value: ' Sunday ', fallback: 'ignored' },
      'button:0:1': { source: 'phone', fallback: null },
    })).toEqual({
      'header:1': { source: 'display_name', fallback: 'there' },
      'body:1': { source: 'field', fieldId: FIELD },
      'body:2': { source: 'static', value: 'Sunday' },
      'button:0:1': { source: 'phone' },
    });
    expect(parseTemplateBindings({})).toEqual({});
  });

  it.each([
    ['not an object', 'nope'],
    ['a list', []],
    ['null', null],
    ['a key that is no parameter', { 'footer:1': { source: 'phone' } }],
    ['a binding that is not an object', { 'body:1': 'display_name' }],
    ['an unknown source', { 'body:1': { source: 'course' } }],
    ['a field without an id', { 'body:1': { source: 'field', fieldId: 'nope' } }],
    ['a static source with no text', { 'body:1': { source: 'static', value: '  ' } }],
    ['a static source with a number', { 'body:1': { source: 'static', value: 4 } }],
    ['an over-long fallback', { 'body:1': { source: 'display_name', fallback: 'x'.repeat(1025) } }],
  ])('refuses %s', (_label, raw) => {
    expect(parseTemplateBindings(raw)).toBeNull();
  });
});

describe('whether a template is fully bound', () => {
  const all = { 'header:1': { source: 'display_name' as const }, 'body:1': { source: 'phone' as const }, 'body:2': { source: 'phone' as const }, 'button:0:1': { source: 'phone' as const } };
  it('needs every parameter and nothing else, on a template that can be sent', () => {
    expect(bindingsComplete(TEMPLATE, all)).toBe(true);
    const short = Object.fromEntries(Object.entries(all).filter(([key]) => key !== 'body:2'));
    expect(bindingsComplete(TEMPLATE, short)).toBe(false);
    expect(bindingsComplete(TEMPLATE, { ...short, 'body:3': { source: 'phone' } })).toBe(false);
    expect(bindingsComplete(defineWhatsAppTemplate('nope'), {})).toBe(false);
  });
});

describe('the frozen form of a binding', () => {
  it('names the source in one string, and reads it back', () => {
    expect(variableKeyOf('button:0:1')).toBe('button_0_1');
    expect(bindingVariable({ source: 'display_name' })).toBe('display_name');
    expect(bindingVariable({ source: 'phone' })).toBe('phone');
    expect(bindingVariable({ source: 'field', fieldId: FIELD })).toBe(`field:${FIELD}`);
    expect(bindingVariable({ source: 'static', value: 'Sunday' })).toBe('static:Sunday');
    for (const value of ['display_name', 'phone', `field:${FIELD}`, 'static:Sunday']) expect(isBindingVariable(value)).toBe(true);
    for (const value of ['field:nope', 'static:', `static:${'x'.repeat(1025)}`, 'course', 7]) expect(isBindingVariable(value)).toBe(false);
  });
});

describe('the values one recipient gets', () => {
  const bindings = {
    'header:1': { source: 'display_name' as const, fallback: 'there' },
    'body:1': { source: 'field' as const, fieldId: FIELD },
    'body:2': { source: 'static' as const, value: 'Sunday' },
  };

  it('takes what was found, falls back where nothing was, and uses static text as is', () => {
    const found: Record<string, unknown> = { 'header:1': '  ', 'body:1': 42 };
    expect(resolveTemplateValues(bindings, (key) => found[key])).toEqual({ 'header:1': 'there', 'body:1': '42', 'body:2': 'Sunday' });
    expect(resolveTemplateValues({ 'body:1': { source: 'phone' } }, () => true)).toEqual({ 'body:1': 'true' });
    expect(resolveTemplateValues({ 'body:1': { source: 'phone' } }, () => 'x'.repeat(2000))?.['body:1']).toHaveLength(1024);
  });

  it('leaves the recipient out when a parameter ends up empty', () => {
    expect(resolveTemplateValues(bindings, () => undefined)).toBeNull();
    expect(resolveTemplateValues({ 'body:1': { source: 'phone' } }, () => ({}))).toBeNull();
  });
});
