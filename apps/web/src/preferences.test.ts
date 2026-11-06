import { describe, expect, it } from 'vitest';
import type { PreferenceStore } from './preferences';
import { browserStore, EMOJI_KEY, LANG_KEY, NAV_KEY, PANEL_KEY, readHabits, readPreferences, THEME_KEY, writeHabits, writePreferences } from './preferences';

function memory(initial: Record<string, string> = {}): PreferenceStore & { readonly values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe('visual preferences', () => {
  it('reads nothing when there is nowhere to read from', () => {
    expect(readPreferences(null)).toEqual({ theme: null, navCollapsed: null, lang: null });
  });

  it('reads a stored theme and navigation width', () => {
    expect(readPreferences(memory({ [THEME_KEY]: 'dark', [NAV_KEY]: 'expanded', [LANG_KEY]: 'en' }))).toEqual({ theme: 'dark', navCollapsed: false, lang: 'en' });
    expect(readPreferences(memory({ [THEME_KEY]: 'light', [NAV_KEY]: 'collapsed', [LANG_KEY]: 'ar' }))).toEqual({ theme: 'light', navCollapsed: true, lang: 'ar' });
  });

  it('treats anything unrecognised as no preference', () => {
    expect(readPreferences(memory({ [THEME_KEY]: 'sepia', [NAV_KEY]: 'wide', [LANG_KEY]: 'fr' }))).toEqual({ theme: null, navCollapsed: null, lang: null });
  });

  it('writes the three visual preferences, and nothing else', () => {
    const store = memory();
    writePreferences(store, { theme: 'dark', navCollapsed: false, lang: 'en' });
    expect(store.values).toEqual({ [THEME_KEY]: 'dark', [NAV_KEY]: 'expanded', [LANG_KEY]: 'en' });
    writePreferences(store, { theme: 'light', navCollapsed: true, lang: 'ar' });
    expect(store.values).toEqual({ [THEME_KEY]: 'light', [NAV_KEY]: 'collapsed', [LANG_KEY]: 'ar' });
    // Writing with no store is a no-op, not a crash.
    writePreferences(null, { theme: 'dark', navCollapsed: true, lang: 'ar' });
  });

  it('survives a store that throws, as private browsing modes do', () => {
    const hostile: PreferenceStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readPreferences(hostile)).toEqual({ theme: null, navCollapsed: null, lang: null });
    expect(() => writePreferences(hostile, { theme: 'dark', navCollapsed: true, lang: 'ar' })).not.toThrow();
  });

  it('finds the browser store, or none when even looking at it throws', () => {
    const store = memory();
    expect(browserStore({ localStorage: store })).toBe(store);
    expect(browserStore({})).toBeNull();
    const guarded = Object.defineProperty({}, 'localStorage', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(browserStore(guarded)).toBeNull();
  });
});

describe('workspace habits', () => {
  const known = { emoji: (value: string) => value === '👍' || value === '🙏', section: (value: string) => value === 'profile' };

  it('reads nothing when there is nowhere to read from, or nothing stored', () => {
    expect(readHabits(null, known)).toEqual({ emojiRecent: null, panelSections: null });
    expect(readHabits(memory(), known)).toEqual({ emojiRecent: null, panelSections: null });
  });

  it('keeps only entries this build knows, and ignores anything not a list', () => {
    const store = memory({ [EMOJI_KEY]: JSON.stringify(['👍', 7, '💥', '🙏']), [PANEL_KEY]: '{"profile":true}' });
    expect(readHabits(store, known)).toEqual({ emojiRecent: ['👍', '🙏'], panelSections: null });
    expect(readHabits(memory({ [EMOJI_KEY]: 'not json' }), known).emojiRecent).toBeNull();
  });

  it('writes both lists, and survives a store that refuses', () => {
    const store = memory();
    writeHabits(store, { emojiRecent: ['🙏'], panelSections: ['profile'] });
    expect(readHabits(store, known)).toEqual({ emojiRecent: ['🙏'], panelSections: ['profile'] });
    writeHabits(null, { emojiRecent: [], panelSections: [] });
    const refusing: PreferenceStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => writeHabits(refusing, { emojiRecent: ['🙏'], panelSections: [] })).not.toThrow();
  });
});
