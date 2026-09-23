import { describe, expect, it } from 'vitest';
import { buildWhatsAppTemplateComponents, defineWhatsAppTemplate, renderWhatsAppTemplatePreview } from './whatsapp-template.js';

describe('WhatsApp template definition', () => {
  it('supports a parameter-free text template', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: 'Your order is ready.' }]);
    expect(definition.sendSupported).toBe(true);
    expect(definition.parameters).toEqual([]);
    expect(buildWhatsAppTemplateComponents(definition, {})).toEqual([]);
  });

  it('derives positional body and header text parameters and renders a local preview', () => {
    const definition = defineWhatsAppTemplate([
      { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
      { type: 'BODY', text: 'Your code is {{1}}. Reply by {{2}}.' },
    ]);
    expect(definition.parameters.map(({ key }) => key)).toEqual(['header:1', 'body:1', 'body:2']);
    const values = { 'header:1': 'Ahmed', 'body:1': 'X91', 'body:2': 'Friday' };
    expect(buildWhatsAppTemplateComponents(definition, values)).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Ahmed' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'X91' }, { type: 'text', text: 'Friday' }] },
    ]);
    expect(renderWhatsAppTemplatePreview(definition, values)).toBe('Your code is X91. Reply by Friday.');
  });

  it('supports positional dynamic URL parameters with the provider button index', () => {
    const definition = defineWhatsAppTemplate([
      { type: 'BODY', text: 'Open the details.' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View details', url: 'https://example.test/orders/{{1}}' }] },
    ]);
    expect(definition.sendSupported).toBe(true);
    expect(buildWhatsAppTemplateComponents(definition, { 'button:0:1': 'order-7' })).toEqual([
      { type: 'button', subType: 'url', index: '0', parameters: [{ type: 'text', text: 'order-7' }] },
    ]);
  });

  it('preserves footer and representative button metadata without executing buttons', () => {
    const definition = defineWhatsAppTemplate([
      { type: 'BODY', text: 'Hello' },
      { type: 'FOOTER', text: 'Reply STOP to opt out.' },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+15551234567' },
      ] },
    ]);
    expect(definition.components).toEqual([
      { type: 'body', text: 'Hello', format: null, buttons: [] },
      { type: 'footer', text: 'Reply STOP to opt out.', format: null, buttons: [] },
      { type: 'buttons', text: null, format: null, buttons: [{ type: 'quick_reply', text: 'Yes' }, { type: 'phone_number', text: 'Call us' }] },
    ]);
    expect(definition.sendSupported).toBe(true);
  });

  it('marks malformed provider components and unsupported button metadata as non-sendable', () => {
    expect(defineWhatsAppTemplate(null).unsupportedReason).toBe('Template components are unavailable.');
    const malformed = defineWhatsAppTemplate([
      { type: 'BUTTONS', buttons: [null, {}, { type: 'URL', text: 'Open', url: '{{customer_id}}' }] },
    ]);
    expect(malformed.sendSupported).toBe(false);
    expect(malformed.unsupportedReason).toBe('Named button parameters are not supported yet.');
    expect(buildWhatsAppTemplateComponents(malformed, {})).toBeNull();
    expect(defineWhatsAppTemplate([{ type: 'UNKNOWN' }]).sendSupported).toBe(false);
    expect(defineWhatsAppTemplate([null]).sendSupported).toBe(false);
  });

  it('reads text and header examples only when the provider example shape is valid', () => {
    const definition = defineWhatsAppTemplate([
      { type: 'HEADER', format: 'TEXT', text: '{{1}}', example: { header_text: ['Dr. Lee'] } },
      { type: 'BODY', text: '{{1}} {{2}}', example: { body_text: [['Amina', 'Tuesday']] } },
    ]);
    expect(definition.parameters.map((parameter) => parameter.example)).toEqual(['Dr. Lee', 'Amina', 'Tuesday']);
  });

  it('rejects missing, empty, extra and oversized parameters', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: '{{1}} / {{2}}' }]);
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': ' ' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': 'B', extra: 'C' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': 'B'.repeat(1025) })).toBeNull();
  });

  it('does not send media, named placeholders or specialized button types', () => {
    const media = defineWhatsAppTemplate([{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['meta-media-id'] } }, { type: 'BODY', text: 'Hello' }]);
    const named = defineWhatsAppTemplate([{ type: 'BODY', text: 'Hello {{first_name}}' }]);
    const flow = defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Continue' }] }]);
    expect(media.sendSupported).toBe(false);
    expect(named.sendSupported).toBe(false);
    expect(flow.sendSupported).toBe(false);
    expect(buildWhatsAppTemplateComponents(media, {})).toBeNull();
    expect(buildWhatsAppTemplateComponents(named, {})).toBeNull();
  });
});
