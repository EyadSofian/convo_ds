import type { Theme } from './state';
import type { Lang } from './format';

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
  /** Presentation preference only; never an authorization signal. */
  readonly lang: Lang | null;
}

/**
 * Two small conveniences kept beside the visual preferences: the emoji picked
 * recently and which customer-panel sections are open. Neither names anybody
 * or grants anything, and a browser that refuses storage simply starts fresh.
 */
export interface WorkspaceHabits {
  readonly emojiRecent: readonly string[] | null;
  readonly panelSections: readonly string[] | null;
}

/** The part of `Storage` this module uses, so a test can hand it a plain object. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const THEME_KEY = 'convo.theme';
export const NAV_KEY = 'convo.nav';
export const LANG_KEY = 'convo.lang';
export const EMOJI_KEY = 'convo.emoji';
export const PANEL_KEY = 'convo.panel';

/** Reads the habits, ignoring anything that is not the shape written here. */
export function readHabits(store: PreferenceStore | null, known: { readonly emoji: (value: string) => boolean; readonly section: (value: string) => boolean }): WorkspaceHabits {
  if (store === null) return { emojiRecent: null, panelSections: null };
  const list = (key: string, keep: (value: string) => boolean): readonly string[] | null => {
    const raw = attempt(() => store.getItem(key));
    if (raw === null) return null;
    const parsed = attempt(() => JSON.parse(raw) as unknown);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && keep(value)).slice(0, 32) : null;
  };
  return { emojiRecent: list(EMOJI_KEY, known.emoji), panelSections: list(PANEL_KEY, known.section) };
}

export function writeHabits(store: PreferenceStore | null, habits: { readonly emojiRecent: readonly string[]; readonly panelSections: readonly string[] }): void {
  if (store === null) return;
  attempt(() => {
    store.setItem(EMOJI_KEY, JSON.stringify(habits.emojiRecent));
    store.setItem(PANEL_KEY, JSON.stringify(habits.panelSections));
    return null;
  });
}

/** Reads what was stored. Anything unrecognised reads as "no preference". */
export function readPreferences(store: PreferenceStore | null): Preferences {
  if (store === null) return { theme: null, navCollapsed: null, lang: null };
  const theme = attempt(() => store.getItem(THEME_KEY));
  const nav = attempt(() => store.getItem(NAV_KEY));
  const lang = attempt(() => store.getItem(LANG_KEY));
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : null,
    navCollapsed: nav === 'collapsed' ? true : nav === 'expanded' ? false : null,
    lang: lang === 'en' || lang === 'ar' ? lang : null,
  };
}

/** Writes both values. A store that refuses (private mode, quota) is ignored. */
export function writePreferences(
  store: PreferenceStore | null,
  preferences: { readonly theme: Theme; readonly navCollapsed: boolean; readonly lang: Lang },
): void {
  if (store === null) return;
  attempt(() => {
    store.setItem(THEME_KEY, preferences.theme);
    store.setItem(NAV_KEY, preferences.navCollapsed ? 'collapsed' : 'expanded');
    store.setItem(LANG_KEY, preferences.lang);
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
