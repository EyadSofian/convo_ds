import { describe, expect, it } from 'vitest';
import type { CustomField } from '../api/metadata.js';
import { channelIdHint, customFieldKey, derivedChannelId, newContactFields, STANDARD_CONTACT_FIELDS, standardFieldKey, typedValue } from './contact-profile.js';

function field(overrides: Partial<CustomField>): CustomField {
  return { id: 'f-1', target: 'contact', key: 'level', name: 'Level', type: 'text', options: [], state: 'active', version: 1, ...overrides };
}

describe('typedValue', () => {
  it('reads what was typed as the field’s own type, and an empty box as nothing', () => {
    expect(typedValue('text', '  ')).toBeNull();
    expect(typedValue('number', ' 42 ')).toBe(42);
    expect(typedValue('boolean', 'true')).toBe(true);
    expect(typedValue('boolean', 'false')).toBe(false);
    expect(typedValue('multi_select', 'a, ,b')).toEqual(['a', 'b']);
    expect(typedValue('date', '2026-09-26')).toBe('2026-09-26');
  });
});

describe('newContactFields', () => {
  const catalogue = [
    field({ id: 'email-field', key: 'email', name: 'Email', type: 'email' }),
    field({ id: 'level-field', key: 'level', name: 'Level', type: 'single_select', options: ['A1', 'B1'] }),
    field({ id: 'seats-field', key: 'seats', name: 'Seats', type: 'number' }),
    field({ id: 'old-field', key: 'old', name: 'Old', state: 'retired' }),
    field({ id: 'conversation-field', key: 'topic', name: 'Topic', target: 'conversation' }),
  ];

  it('maps standard fields by key, creating missing ones only for a catalogue manager', () => {
    const form = {
      [standardFieldKey('email')]: 'hala@example.com',
      [standardFieldKey('company')]: 'Digital School',
      [customFieldKey('level-field')]: 'B1',
      [customFieldKey('seats-field')]: '',
    };
    const manager = newContactFields(form, catalogue, true, 'en');
    expect(manager.errors).toEqual({});
    expect(manager.fields).toEqual([
      { fieldId: 'email-field', key: 'email', name: 'Email', type: 'email', value: 'hala@example.com' },
      { fieldId: null, key: 'company', name: 'Company', type: 'text', value: 'Digital School' },
      { fieldId: 'level-field', key: 'level', name: 'Level', type: 'single_select', value: 'B1' },
    ]);
    // Somebody who cannot add to the catalogue writes only what exists.
    const agent = newContactFields(form, catalogue, false, 'ar');
    expect(agent.fields.map((entry) => entry.key)).toEqual(['email', 'level']);
  });

  it('refuses a malformed email or phone on its own field, in the operator’s language', () => {
    const form = { [standardFieldKey('email')]: 'not-an-email', [standardFieldKey('phone')]: '01001234567' };
    const english = newContactFields(form, catalogue, true, 'en');
    expect(english.fields).toEqual([]);
    expect(english.errors[standardFieldKey('email')]).toContain('name@example.com');
    expect(english.errors[standardFieldKey('phone')]).toContain('+201001234567');
    const arabic = newContactFields(form, catalogue, true, 'ar');
    expect(arabic.errors[standardFieldKey('email')]).toContain('بريدًا');
    expect(arabic.errors[standardFieldKey('phone')]).toContain('الدولية');
    expect(newContactFields({ [standardFieldKey('phone')]: '+20 100 123 4567' }, [], true, 'en').fields[0]?.value).toBe('+20 100 123 4567');
  });

  it('offers every standard field', () => {
    expect(STANDARD_CONTACT_FIELDS.map((entry) => entry.key)).toEqual(['email', 'phone', 'company', 'job_title', 'city', 'country', 'notes']);
  });
});

describe('channelIdHint', () => {
  it('explains the identity in the chosen channel’s terms', () => {
    expect(channelIdHint('whatsapp', 'en')).toContain('WhatsApp number');
    expect(channelIdHint('messenger', 'ar')).toContain('PSID');
    expect(channelIdHint('instagram', 'en')).toContain('IGSID');
    expect(channelIdHint('web_chat', 'en')).toContain('visitor');
    expect(channelIdHint('custom', 'en')).toContain('your own system');
    expect(channelIdHint(undefined, 'en')).toBe('Choose the channel first.');
    expect(channelIdHint('pigeon', 'ar')).toBe('اختر القناة أولًا.');
  });
});

describe('derivedChannelId', () => {
  it('reads a WhatsApp id off the phone, and nothing for other channels', () => {
    expect(derivedChannelId('whatsapp', '+20 (100) 123-4567')).toBe('201001234567');
    expect(derivedChannelId('whatsapp', '')).toBe('');
    expect(derivedChannelId('messenger', '+201001234567')).toBe('');
  });
});
