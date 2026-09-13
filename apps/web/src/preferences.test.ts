import { describe, expect, it } from 'vitest';
import type { PreferenceStore } from './preferences';
import { browserStore, NAV_KEY, readPreferences, THEME_KEY, writePreferences } from './preferences';

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
    expect(readPreferences(null)).toEqual({ theme: null, navCollapsed: null });
  });

  it('reads a stored theme and navigation width', () => {
    expect(readPreferences(memory({ [THEME_KEY]: 'dark', [NAV_KEY]: 'expanded' }))).toEqual({ theme: 'dark', navCollapsed: false });
    expect(readPreferences(memory({ [THEME_KEY]: 'light', [NAV_KEY]: 'collapsed' }))).toEqual({ theme: 'light', navCollapsed: true });
  });

  it('treats anything unrecognised as no preference', () => {
    expect(readPreferences(memory({ [THEME_KEY]: 'sepia', [NAV_KEY]: 'wide' }))).toEqual({ theme: null, navCollapsed: null });
  });

  it('writes both values, and nothing else', () => {
    const store = memory();
    writePreferences(store, { theme: 'dark', navCollapsed: false });
    expect(store.values).toEqual({ [THEME_KEY]: 'dark', [NAV_KEY]: 'expanded' });
    writePreferences(store, { theme: 'light', navCollapsed: true });
    expect(store.values).toEqual({ [THEME_KEY]: 'light', [NAV_KEY]: 'collapsed' });
    // Writing with no store is a no-op, not a crash.
    writePreferences(null, { theme: 'dark', navCollapsed: true });
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
    expect(readPreferences(hostile)).toEqual({ theme: null, navCollapsed: null });
    expect(() => writePreferences(hostile, { theme: 'dark', navCollapsed: true })).not.toThrow();
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
