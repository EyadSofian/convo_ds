import type { Theme } from './state';

/**
 * Visual preferences that outlive a page load.
 *
 * Only two, and both are about how the screen looks: the theme and whether the
 * navigation is collapsed. Nothing that identifies anybody or grants anything is
 * ever written here — the session is a cookie the browser cannot read, and a
 * role in local storage would be a role anybody could edit.
 */

export interface Preferences {
  readonly theme: Theme | null;
  readonly navCollapsed: boolean | null;
}

/** The part of `Storage` this module uses, so a test can hand it a plain object. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const THEME_KEY = 'convo.theme';
export const NAV_KEY = 'convo.nav';

/** Reads what was stored. Anything unrecognised reads as "no preference". */
export function readPreferences(store: PreferenceStore | null): Preferences {
  if (store === null) return { theme: null, navCollapsed: null };
  const theme = attempt(() => store.getItem(THEME_KEY));
  const nav = attempt(() => store.getItem(NAV_KEY));
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : null,
    navCollapsed: nav === 'collapsed' ? true : nav === 'expanded' ? false : null,
  };
}

/** Writes both values. A store that refuses (private mode, quota) is ignored. */
export function writePreferences(
  store: PreferenceStore | null,
  preferences: { readonly theme: Theme; readonly navCollapsed: boolean },
): void {
  if (store === null) return;
  attempt(() => {
    store.setItem(THEME_KEY, preferences.theme);
    store.setItem(NAV_KEY, preferences.navCollapsed ? 'collapsed' : 'expanded');
    return null;
  });
}

/**
 * The browser's storage, or `null` when touching it throws.
 *
 * Some privacy modes throw on the *property access*, not on the call, so the
 * lookup itself is guarded.
 */
export function browserStore(host: { readonly localStorage?: PreferenceStore }): PreferenceStore | null {
  return attempt(() => host.localStorage ?? null);
}

function attempt<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}
