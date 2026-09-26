import { describe, expect, it } from 'vitest';
import type { WhatsAppTemplate } from '../api/automations.js';
import type { CustomField } from '../api/metadata.js';
import { bindingKey, bindingsFromForm, defaultSource, sampleValues, storedBindings, templateDefinition, templateSegments } from './template-binding.js';

const FIELD = '11111111-1111-4111-8111-111111111111';
const TEMPLATE: WhatsAppTemplate = {
  id: 'wa-1', connectionId: 'c-1', providerTemplateId: 'p-1', templateName: 'class_open', language: 'en', category: 'MARKETING', status: 'approved',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
    { type: 'BODY', text: 'Your {{1}} class starts {{2}}.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://school.example/{{1}}' }] },
  ],
  variables: [], lastSyncedAt: '2026-09-26T00:00:00.000Z',
};
const DEFINITION = templateDefinition(TEMPLATE);
const LEVEL: CustomField = { id: FIELD, target: 'contact', key: 'level', name: 'Level', type: 'text', options: [], state: 'active', version: 1 };

describe('form keys and defaults', () => {
  it('keeps colons out of form keys, and guesses a name for the first variable only', () => {
    expect(bindingKey('p_', 'button:0:1', 'value')).toBe('p_button_0_1_value');
    expect(DEFINITION.parameters.map(defaultSource)).toEqual(['display_name', 'display_name', 'static', 'static']);
    expect(storedBindings({ 'body:1': { source: 'phone' } })).toEqual({ 'body:1': { source: 'phone' } });
    expect(storedBindings('nope')).toEqual({});
  });
});

describe('the bindings on screen', () => {
  it('reads what was typed over what was saved, and names what is still missing', () => {
    const form = {
      [bindingKey('p_', 'header:1', 'fallback')]: ' there ',
      [bindingKey('p_', 'body:1', 'source')]: 'field',
      [bindingKey('p_', 'body:2', 'source')]: 'static',
      [bindingKey('p_', 'button:0:1', 'source')]: 'nonsense',
    };
    const draft = bindingsFromForm(form, 'p_', DEFINITION, { 'body:2': { source: 'static', value: 'Sunday' } });
    expect(draft.bindings).toEqual({ 'header:1': { source: 'display_name', fallback: 'there' }, 'body:2': { source: 'static', value: 'Sunday' } });
    expect(draft.sources).toEqual({ 'header:1': 'display_name', 'body:1': 'field', 'body:2': 'static', 'button:0:1': 'static' });
    expect(draft.missing).toEqual(['body:1', 'button:0:1']);
    const filled = bindingsFromForm({ ...form, [bindingKey('p_', 'body:1', 'field')]: FIELD, [bindingKey('p_', 'body:1', 'fallback')]: 'English', [bindingKey('p_', 'button:0:1', 'value')]: 'abc' }, 'p_', DEFINITION, {});
    expect(filled.missing).toEqual(['body:2']);
    expect(filled.bindings['body:1']).toEqual({ source: 'field', fieldId: FIELD, fallback: 'English' });
    expect(filled.bindings['button:0:1']).toEqual({ source: 'static', value: 'abc' });
    // What was saved stands in for a form nobody touched.
    expect(bindingsFromForm({}, 'p_', DEFINITION, { 'body:1': { source: 'field', fieldId: FIELD }, 'button:0:1': { source: 'phone' } }).bindings)
      .toMatchObject({ 'body:1': { source: 'field', fieldId: FIELD }, 'button:0:1': { source: 'phone' } });
  });
});

describe('the preview', () => {
  it('shows a sample contact, a field by name, the typed text, or the bare placeholder', () => {
    const values = sampleValues(DEFINITION, {
      'header:1': { source: 'display_name' },
      'body:1': { source: 'field', fieldId: FIELD },
      'body:2': { source: 'static', value: 'Sunday' },
    }, [LEVEL], { name: 'Mona', phone: '+20' });
    expect(values).toEqual({ 'header:1': 'Mona', 'body:1': '[Level]', 'body:2': 'Sunday', 'button:0:1': '{{1}}' });
    expect(sampleValues(DEFINITION, { 'body:1': { source: 'field', fieldId: 'gone' }, 'button:0:1': { source: 'phone' } }, [], { name: 'Mona', phone: '+20' }))
      .toMatchObject({ 'body:1': '[…]', 'button:0:1': '+20' });
  });

  it('splits text into plain stretches and marked variables', () => {
    expect(templateSegments('Your {{1}} class starts {{2}}.', 'body', { 'body:1': 'IELTS' })).toEqual([
      { text: 'Your ' }, { key: 'body:1', value: 'IELTS' }, { text: ' class starts ' }, { key: 'body:2', value: '{{2}}' }, { text: '.' },
    ]);
    expect(templateSegments('{{1}}', 'header', { 'header:1': 'Hi' })).toEqual([{ key: 'header:1', value: 'Hi' }]);
  });
});
