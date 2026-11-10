import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import { parseQuickReply, parseVersion, parseVersioned } from './quick-reply-request.js';

function issues(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiHttpError);
    return ((error as ApiHttpError).details ?? []).map((detail) => detail.field);
  }
  throw new Error('expected a validation failure');
}

describe('parseQuickReply', () => {
  it('normalises a text reply: trimmed, lower-case shortcut without its slash', () => {
    expect(parseQuickReply({ shortcut: ' /Hello ', title: ' Greeting ', body: ' Hi there ' })).toEqual({
      shortcut: 'hello', title: 'Greeting', kind: 'text', body: 'Hi there', location: null,
    });
  });

  it('accepts Arabic shortcuts', () => {
    expect(parseQuickReply({ shortcut: 'اسعار', title: 'الأسعار', kind: 'text', body: 'قائمة الأسعار' }).shortcut).toBe('اسعار');
  });

  it('reads a location with numeric strings and no address', () => {
    expect(parseQuickReply({
      shortcut: 'branch', title: 'Main branch', kind: 'location', body: null,
      location: { name: 'Nasr City branch', address: '', latitude: '30.05', longitude: 31.33 },
    })).toEqual({
      shortcut: 'branch', title: 'Main branch', kind: 'location', body: '',
      location: { name: 'Nasr City branch', address: null, latitude: 30.05, longitude: 31.33 },
    });
    expect(parseQuickReply({
      shortcut: 'b2', title: 'B', kind: 'location', location: { name: 'B', address: ' 5 Tahrir St ', latitude: -1, longitude: 2 },
    }).location?.address).toBe('5 Tahrir St');
  });

  it('names every invalid field at once', () => {
    expect(issues(() => parseQuickReply('nope'))).toEqual(['shortcut', 'title', 'body']);
    expect(issues(() => parseQuickReply({ shortcut: 'two words', title: 'x'.repeat(81), kind: 'video', body: 5 }))).toEqual(['shortcut', 'title', 'kind', 'body']);
    expect(issues(() => parseQuickReply({ shortcut: 'a/b', title: 'T', body: 'x'.repeat(4001) }))).toEqual(['shortcut', 'body']);
    expect(issues(() => parseQuickReply({ shortcut: 'x'.repeat(33), title: 'T', body: 'ok' }))).toEqual(['shortcut']);
  });

  it('requires a named place with real coordinates for a location', () => {
    expect(issues(() => parseQuickReply({ shortcut: 'loc', title: 'L', kind: 'location' }))).toEqual([
      'location.name', 'location.latitude', 'location.longitude',
    ]);
    expect(issues(() => parseQuickReply({
      shortcut: 'loc', title: 'L', kind: 'location',
      location: { name: 'Place', address: 'x'.repeat(301), latitude: 91, longitude: 'east' },
    }))).toEqual(['location.address', 'location.latitude', 'location.longitude']);
    expect(issues(() => parseQuickReply({
      shortcut: 'loc', title: 'L', kind: 'location', location: { name: 'Place', latitude: 10, longitude: 181 },
    }))).toEqual(['location.longitude']);
  });

  it('explains each failure in words', () => {
    try {
      parseQuickReply({ kind: 'location' });
    } catch (error) {
      const messages = ((error as ApiHttpError).details ?? []).map((detail) => detail.message);
      expect(messages[0]).toContain('32 characters');
      expect(messages[1]).toContain('non-empty');
      expect(messages.at(-1)).toContain('latitude');
    }
  });
});

describe('versions', () => {
  it('reads a positive integer version', () => {
    expect(parseVersion({ version: 3 })).toBe(3);
    expect(parseVersioned({ version: 2, shortcut: 'hi', title: 'Hi', body: 'Hello' }).version).toBe(2);
  });

  it('refuses anything else', () => {
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: '2' }, null]) {
      expect(issues(() => parseVersion(body))).toEqual(['version']);
    }
  });
});
