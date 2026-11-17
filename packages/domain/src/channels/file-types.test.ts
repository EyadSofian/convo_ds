import { describe, expect, it } from 'vitest';
import { chatFileMessageType, chatFileSizeLimit, chatFileTypes } from './file-types.js';

describe('chat attachment types', () => {
  it('keeps WhatsApp documents distinct from Messenger files and allows Instagram images', () => {
    expect(chatFileMessageType('whatsapp', 'application/pdf')).toBe('document');
    expect(chatFileMessageType('messenger', 'application/pdf')).toBe('file');
    expect(chatFileMessageType('messenger', 'image/gif')).toBe('image');
    expect(chatFileMessageType('whatsapp', 'audio/mpeg')).toBe('audio');
    expect(chatFileMessageType('whatsapp', 'video/mp4')).toBe('video');
    expect(chatFileMessageType('instagram', 'image/png')).toBe('image');
    expect(chatFileMessageType('instagram', 'application/pdf')).toBeNull();
    expect(chatFileTypes('custom')).toEqual([]);
  });
});

it('applies the higher size limit only to supported WhatsApp video formats', () => {
  const mib = 1024 * 1024;
  expect(chatFileSizeLimit('whatsapp', 'video/mp4')).toBe(16 * mib);
  expect(chatFileSizeLimit('whatsapp', 'video/3gpp')).toBe(16 * mib);
  expect(chatFileSizeLimit('whatsapp', 'image/png')).toBe(5 * mib);
  expect(chatFileSizeLimit('messenger', 'video/mp4')).toBe(5 * mib);
});
