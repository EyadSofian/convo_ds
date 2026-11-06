import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { EMOJI_CATEGORIES, EMOJI_MENU, searchEmoji } from './emoji-data.js';
import { button } from './parts.js';

/**
 * The composer's emoji picker.
 *
 * Categories along the top, a search that understands Arabic and English
 * words, and the emoji used recently first. A pick goes in at the caret, not
 * at the end of the message, and the picker stays open so a person can add
 * two or three; Escape or a click outside closes it.
 */
export function emojiPicker(state: AppState): HTMLElement {
  const opened = state.openMenu === EMOJI_MENU;
  return h('div', { class: 'composer__emoji' }, [
    button({
      icon: 'smile',
      act: 'menu',
      arg: EMOJI_MENU,
      variant: 'ghost',
      small: true,
      expanded: opened,
      haspopup: 'dialog',
      title: t(state, 'إيموجي', 'Emoji'),
      ariaLabel: t(state, 'إيموجي', 'Emoji'),
      extraClass: opened ? 'composer__tool btn--active' : 'composer__tool',
    }),
    opened ? emojiPanel(state) : null,
  ]);
}

interface Tab {
  readonly id: string;
  readonly mark: string;
  readonly label: string;
  readonly emojis: readonly string[];
}

function emojiPanel(state: AppState): HTMLElement {
  const query = state.emojiQuery.trim();
  const recent = state.emojiRecent;
  const tabs: readonly Tab[] = [
    ...(recent.length === 0 ? [] : [{ id: 'recent', mark: '🕘', label: t(state, 'المستخدمة مؤخرًا', 'Recently used'), emojis: recent }]),
    ...EMOJI_CATEGORIES.map((category) => ({
      id: category.id,
      mark: category.mark,
      label: t(state, category.ar, category.en),
      emojis: category.emojis.map((entry) => entry.char),
    })),
  ];
  // A remembered tab that has nothing to show (no recents yet) falls back to
  // the first real category rather than an empty grid.
  const active = tabs.find((tab) => tab.id === state.emojiCategory) ?? tabs.find((tab) => tab.id !== 'recent') as Tab;
  const searching = query !== '';
  const list = searching ? searchEmoji(query).map((entry) => entry.char) : active.emojis;
  const heading = searching ? t(state, `نتائج «${query}»`, `Results for “${query}”`) : active.label;
  return h('div', { class: 'popover emoji-picker', role: 'dialog', 'data-overlay': 'popover', 'aria-label': t(state, 'اختر إيموجي', 'Choose an emoji') }, [
    h('div', { class: 'emoji-picker__tabs', role: 'tablist', 'aria-label': t(state, 'فئات الإيموجي', 'Emoji categories') }, tabs.map((tab) => {
      const selected = !searching && tab.id === active.id;
      return h('button', {
        type: 'button',
        class: 'emoji-picker__tab',
        role: 'tab',
        'aria-selected': String(selected),
        'aria-label': tab.label,
        title: tab.label,
        'data-act': 'emoji-category',
        'data-arg': tab.id,
      }, [tab.mark]);
    })),
    h('label', { class: 'emoji-picker__search' }, [
      icon('search', 14),
      h('input', {
        class: 'emoji-picker__search-input',
        type: 'search',
        dir: 'auto',
        value: state.emojiQuery,
        placeholder: t(state, 'ابحث: شكرا، تمام، قلب…', 'Search: thanks, ok, heart…'),
        'aria-label': t(state, 'ابحث عن إيموجي', 'Search emoji'),
        'data-act': 'emoji-search',
      }),
    ]),
    h('p', { class: 'emoji-picker__heading', id: 'emoji-picker-heading' }, [heading]),
    emojiGrid(state, list),
  ]);
}

function emojiGrid(state: AppState, list: readonly string[]): Child {
  if (list.length === 0) {
    return h('p', { class: 'emoji-picker__empty' }, [t(state, 'لا يوجد إيموجي بهذا الاسم.', 'No emoji by that name.')]);
  }
  return h('div', { class: 'emoji-picker__grid', role: 'group', 'aria-labelledby': 'emoji-picker-heading' }, list.map((char) =>
    h('button', { type: 'button', class: 'emoji-picker__item', 'data-act': 'live-emoji', 'data-arg': char, 'aria-label': char, title: char }, [char]),
  ));
}
