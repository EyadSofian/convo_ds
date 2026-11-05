import { describe, expect, it } from 'vitest';
import { chatFileMessageType, chatFileTypes } from './file-types.js';

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
