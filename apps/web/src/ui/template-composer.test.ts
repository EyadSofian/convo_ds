/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { WhatsAppTemplate } from '../api/automations';
import { createState } from '../state';
import type { AppState } from '../state';
import { templateComposer, whatsappPreview } from './template-composer';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const FIELD = '11111111-1111-4111-8111-111111111111';

function template(overrides: Partial<WhatsAppTemplate> = {}): WhatsAppTemplate {
  return {
    id: 'wa-1', connectionId: 'c-1', providerTemplateId: 'p-1', templateName: 'class_open', language: 'en', category: 'MARKETING', status: 'approved',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
      { type: 'BODY', text: 'Your {{1}} class starts {{2}}.' },
      { type: 'FOOTER', text: 'Digital School' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'Open', url: 'https://school.example/{{1}}' },
        { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+20100' },
        { type: 'QUICK_REPLY', text: 'Stop' },
      ] },
    ],
    variables: [], lastSyncedAt: NOW.toISOString(), ...overrides,
  };
}

function state(lang: 'ar' | 'en' = 'en'): AppState {
  const value = createState(NOW);
  value.lang = lang;
  return value;
}

const OPTIONS = { prefix: 'p_', pick: 'pick', stored: {}, sample: { name: 'Mona', phone: '+20 100' }, sender: 'Digital School' } as const;

describe('the template list', () => {
  it('marks the chosen template, names each category, and refuses media templates', () => {
    const s = state();
    const templates = [
      template(),
      template({ id: 'wa-2', templateName: 'receipt', category: 'UTILITY', components: [{ type: 'BODY', text: 'Thanks' }] }),
      template({ id: 'wa-3', templateName: 'otp', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: 'Code' }] }),
      template({ id: 'wa-4', templateName: 'odd', category: 'SERVICE', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Look' }] }),
    ];
    const root = templateComposer(s, { ...OPTIONS, templates, selectedId: 'wa-2' });
    const cards = [...root.querySelectorAll('.tpl-card')] as HTMLButtonElement[];
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
    expect(cards[0]?.getAttribute('data-arg')).toBe('pick:wa-1');
    expect(cards.map((card) => card.querySelector('.tpl-card__meta')?.textContent)).toEqual(['enMarketing4 variables', 'enUtility', 'enAuthentication', 'enSERVICE']);
    expect(cards[3]?.disabled).toBe(true);
    expect(cards[3]?.textContent).toContain('Media templates cannot be broadcast yet');
    expect(root.querySelector('.tpl-composer--compact')).toBeNull();
    const arabic = templateComposer(state('ar'), { ...OPTIONS, templates, selectedId: '', compact: true });
    expect(arabic.classList.contains('tpl-composer--compact')).toBe(true);
    expect([...arabic.querySelectorAll('.tpl-card__meta')].map((meta) => meta.textContent)).toEqual(['enتسويقي4 متغير', 'enخدمي', 'enتحقق', 'enSERVICE']);
  });

  it('asks for a choice before showing variables', () => {
    const root = templateComposer(state(), { ...OPTIONS, templates: [template()], selectedId: '' });
    expect(root.textContent).toContain('Choose a template to see it');
    expect(root.querySelector('.wa-bubble--empty')?.textContent).toBe('Your message appears here');
  });
});

describe('binding each variable', () => {
  it('offers a source for each, and the control that source needs', () => {
    const s = state();
    s.live.customFields = { status: 'ready', loadedAt: 1, value: [
      { id: FIELD, target: 'contact', key: 'level', name: 'Level', type: 'text', options: [], state: 'active', version: 1 },
      { id: 'retired', target: 'contact', key: 'old', name: 'Old', type: 'text', options: [], state: 'retired', version: 1 },
    ] };
    s.dialogForm = { p_body_1_source: 'field', p_body_2_source: 'static', p_button_0_1_source: 'phone' };
    const root = templateComposer(s, { ...OPTIONS, templates: [template()], selectedId: 'wa-1', stored: { 'body:2': { source: 'static', value: 'Sunday' } }, showMissing: true });
    const rows = [...root.querySelectorAll('.tpl-var')];
    expect(rows.map((row) => row.querySelector('.tpl-var__label')?.textContent)).toEqual(['{{1}}Header', '{{1}}Body', '{{2}}Body', '{{1}}Button 1 link']);
    expect(rows.map((row) => (row.querySelector('select') as HTMLSelectElement).value)).toEqual(['display_name', 'field', 'static', 'phone']);
    // A field: the contact fields, and a fallback; still missing until one is chosen.
    expect([...rows[1]!.querySelectorAll('select')[1]!.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Choose a field', 'Level']);
    expect(rows[1]?.classList.contains('tpl-var--missing')).toBe(true);
    expect(rows[1]?.querySelector('.field__error')?.textContent).toBe('Choose the field.');
    // Fixed text: typed in place, and the preview follows it without a redraw.
    const text = rows[2]!.querySelector('input') as HTMLInputElement;
    expect(text.value).toBe('Sunday');
    expect(text.getAttribute('data-wa-parameter')).toBe('p_|body:2');
    expect(root.querySelector('[data-template-preview-key="p_|body:2"]')?.textContent).toBe('Sunday');
    expect(rows[2]?.querySelector('[data-form="p_body_2_fallback"]')).toBeNull();
    // Name and number take a fallback.
    expect(rows[0]?.querySelector('[data-form="p_header_1_fallback"]')).not.toBeNull();
    expect(root.querySelector('.wa-bubble__header')?.textContent).toBe('Hi Mona');
    expect(root.querySelector('.wa-bubble__body')?.textContent).toBe('Your {{1}} class starts Sunday.');
  });

  it('says what is missing for fixed text, and when there are no fields at all', () => {
    const s = state('ar');
    s.dialogForm = { p_body_1_source: 'field', p_body_2_source: 'static', p_body_1_field: FIELD };
    // Nothing is marked missing until the operator tried to go on.
    expect(templateComposer(s, { ...OPTIONS, templates: [template()], selectedId: 'wa-1' }).querySelector('.tpl-var--missing')).toBeNull();
    const root = templateComposer(s, { ...OPTIONS, templates: [template()], selectedId: 'wa-1', showMissing: true });
    const rows = [...root.querySelectorAll('.tpl-var')];
    expect([...rows[1]!.querySelectorAll('select')[1]!.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['لا توجد حقول بعد']);
    expect(rows[2]?.querySelector('.field__error')?.textContent).toBe('اكتب النص.');
    expect(rows[3]?.querySelector('input')?.getAttribute('placeholder')).toBe('النص الذي يظهر للجميع');
    expect(rows.map((row) => row.querySelector('.tpl-var__label')?.textContent)).toEqual(['{{1}}العنوان', '{{1}}النص', '{{2}}النص', '{{1}}رابط الزر 1']);
    expect(rows[0]?.querySelector('[data-form="p_header_1_fallback"]')?.getAttribute('placeholder')).toBe('قيمة بديلة');
  });

  it('says a template without variables goes out as it is', () => {
    const root = templateComposer(state(), { ...OPTIONS, templates: [template({ components: [{ type: 'BODY', text: 'Hello' }] })], selectedId: 'wa-1' });
    expect(root.querySelector('.tpl-vars__none')?.textContent).toContain('no variables');
  });
});

describe('the WhatsApp preview', () => {
  it('draws the business, the bubble in the template’s direction, and every kind of button', () => {
    const s = state();
    const root = templateComposer(s, { ...OPTIONS, templates: [template({ language: 'ar' })], selectedId: 'wa-1' });
    expect(root.querySelector('.wa-phone__name')?.textContent).toBe('Digital School');
    expect(root.querySelector('.wa-phone__avatar')?.textContent).toBe('DS');
    expect(root.querySelector('.wa-bubble')?.getAttribute('dir')).toBe('rtl');
    expect(root.querySelector('.wa-bubble__footer')?.textContent).toBe('Digital School');
    expect([...root.querySelectorAll('.wa-button')].map((button) => button.textContent)).toEqual(['Open', 'Call us', 'Stop']);
    const bare = whatsappPreview(s, { components: [{ type: 'body', text: null, format: null, buttons: [] }, { type: 'header', text: null, format: 'TEXT', buttons: [] }, { type: 'footer', text: null, format: null, buttons: [] }], parameters: [], sendSupported: true, unsupportedReason: null }, {}, 'X', 'en');
    expect(bare.querySelector('.wa-bubble')?.getAttribute('dir')).toBe('ltr');
    expect(bare.querySelector('.wa-bubble__body, .wa-bubble__header, .wa-bubble__footer')).toBeNull();
    expect(bare.querySelector('.wa-buttons')).toBeNull();
  });
});
