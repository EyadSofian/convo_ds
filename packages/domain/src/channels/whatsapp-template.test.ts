import { describe, expect, it } from 'vitest';
import { buildWhatsAppTemplateComponents, defineWhatsAppTemplate, isPublicHttpsTemplateMediaUrl, renderWhatsAppTemplatePreview } from './whatsapp-template.js';

describe('WhatsApp template definition', () => {
  it('supports a parameter-free text template', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: 'Your order is ready.' }]);
    expect(definition.sendSupported).toBe(true);
    expect(definition.parameters).toEqual([]);
    expect(buildWhatsAppTemplateComponents(definition, {})).toEqual([]);
  });

  it('does not misclassify a text-only course update as media', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: 'مرحبًا {{1}}، طلبك للاستفسار عن كورس {{2}} حالته {{3}}.' }]);
    expect(definition.sendSupported).toBe(true);
    expect(definition.parameters.map((parameter) => parameter.key)).toEqual(['body:1', 'body:2', 'body:3']);
    expect(definition.parameters.some((parameter) => parameter.mediaFormat !== undefined)).toBe(false);
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'Eyad', 'body:2': 'English', 'body:3': 'open' })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Eyad' }, { type: 'text', text: 'English' }, { type: 'text', text: 'open' }] },
    ]);
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
    expect(defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: 'not-an-array' }]).sendSupported).toBe(true);
    expect(defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: [{ type: 'OTP' }] }]).unsupportedReason).toBe('This button type requires a specialized send flow.');
    expect(defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Continue' }] }]).sendSupported).toBe(false);
    expect(defineWhatsAppTemplate([{ type: 'BODY', text: 'Broken {{1' }]).sendSupported).toBe(false);
  });

  it('reads text and header examples only when the provider example shape is valid', () => {
    const definition = defineWhatsAppTemplate([
      { type: 'HEADER', format: 'TEXT', text: '{{1}}', example: { header_text: ['Dr. Lee'] } },
      { type: 'BODY', text: '{{1}} {{2}}', example: { body_text: [['Amina', 'Tuesday']] } },
    ]);
    expect(definition.parameters.map((parameter) => parameter.example)).toEqual(['Dr. Lee', 'Amina', 'Tuesday']);
    expect(renderWhatsAppTemplatePreview(defineWhatsAppTemplate([]), {})).toBe('');
    expect(renderWhatsAppTemplatePreview(defineWhatsAppTemplate([{ type: 'BODY', text: 'Hello {{1}}' }]), {})).toBe('Hello {{1}}');
  });

  it('rejects missing, empty, extra and oversized parameters', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: '{{1}} / {{2}}' }]);
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': ' ' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': 'B', extra: 'C' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(definition, { 'body:1': 'A', 'body:2': 'B'.repeat(1025) })).toBeNull();
  });

  it('supports media headers with direct HTTPS URLs, but not specialized buttons', () => {
    const media = defineWhatsAppTemplate([{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['meta-media-id'] } }, { type: 'BODY', text: 'Hello' }]);
    const flow = defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Continue' }] }]);
    expect(media.sendSupported).toBe(true);
    expect(media.parameters).toMatchObject([{ key: 'header:0', mediaFormat: 'IMAGE' }]);
    expect(flow.sendSupported).toBe(false);
    expect(buildWhatsAppTemplateComponents(media, {})).toBeNull();
    expect(buildWhatsAppTemplateComponents(media, { 'header:0': 'http://example.com/image.jpg' })).toBeNull();
    expect(buildWhatsAppTemplateComponents(media, { 'header:0': 'https://example.com/image.jpg' })).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://example.com/image.jpg' } }] },
    ]);
  });

  it('supports named text parameters using Meta parameter_name, not a media fallback', () => {
    const definition = defineWhatsAppTemplate([{ type: 'BODY', text: 'Hello {{first_name}}, your course is {{course_name}}.', example: { body_text_named_params: [{ param_name: 'first_name', example: 'Sara' }] } }]);
    expect(definition.sendSupported).toBe(true);
    expect(definition.parameters).toMatchObject([{ key: 'body:first_name', name: 'first_name', example: 'Sara' }, { key: 'body:course_name', name: 'course_name' }]);
    expect(buildWhatsAppTemplateComponents(definition, { 'body:first_name': 'Eyad', 'body:course_name': 'English' })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Eyad', parameter_name: 'first_name' }, { type: 'text', text: 'English', parameter_name: 'course_name' }] },
    ]);
    expect(renderWhatsAppTemplatePreview(definition, { 'body:first_name': 'Eyad' })).toBe('Hello Eyad, your course is {{course_name}}.');
    expect(defineWhatsAppTemplate([{ type: 'BODY', text: '{{1}} {{name}}' }]).sendSupported).toBe(false);
  });

  it.each(['VIDEO', 'DOCUMENT'] as const)('builds a %s media header with the matching Meta parameter', (format) => {
    const definition = defineWhatsAppTemplate([{ type: 'HEADER', format }, { type: 'BODY', text: 'Details' }]);
    const link = 'https://example.com/file';
    expect(buildWhatsAppTemplateComponents(definition, { 'header:0': link })).toEqual([
      { type: 'header', parameters: [{ type: format.toLowerCase(), [format.toLowerCase()]: { link } }] },
    ]);
  });

  it('identifies unsupported header formats and malformed button URLs precisely', () => {
    expect(defineWhatsAppTemplate([{ type: 'HEADER', format: 'LOCATION' }]).unsupportedReason).toBe('Header format LOCATION is not supported yet.');
    expect(defineWhatsAppTemplate([{ type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com/{{1' }] }]).sendSupported).toBe(false);
  });

  it('rejects private and invalid media destinations while allowing public HTTPS links', () => {
    expect(isPublicHttpsTemplateMediaUrl('https://127.0.0.1/image.jpg')).toBe(false);
    expect(isPublicHttpsTemplateMediaUrl('https://172.16.0.1/image.jpg')).toBe(false);
    expect(isPublicHttpsTemplateMediaUrl('https://8.8.8.8/image.jpg')).toBe(true);
    expect(isPublicHttpsTemplateMediaUrl('https://media.example.com/image.jpg')).toBe(true);
    expect(isPublicHttpsTemplateMediaUrl('not a URL')).toBe(false);
  });

  it('reads named header examples and ignores malformed named examples', () => {
    const header = defineWhatsAppTemplate([{ type: 'HEADER', format: 'TEXT', text: 'Hello {{first_name}}', example: { header_text_named_params: [{ param_name: 'first_name', example: 'Sara' }] } }]);
    expect(header.parameters[0]?.example).toBe('Sara');
    const malformed = defineWhatsAppTemplate([{ type: 'BODY', text: 'Hi {{first_name}}', example: { body_text_named_params: [null] } }]);
    expect(malformed.parameters[0]?.example).toBeNull();
    expect(defineWhatsAppTemplate([{ type: 'BODY', text: 'Hi {{first_name}}' }]).parameters[0]?.example).toBeNull();
  });
});
