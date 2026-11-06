/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { createState } from '../state.js';
import { ALL_EMOJI, EMOJI_CATEGORIES, EMOJI_MENU, foldArabic, RECENT_EMOJI_LIMIT, rememberEmoji, searchEmoji } from './emoji-data.js';
import { emojiPicker } from './emoji-picker.js';

function picker(setup: (state: ReturnType<typeof createState>) => void = () => undefined): HTMLElement {
  const state = createState(new Date('2026-09-09T09:30:00.000Z'));
  state.openMenu = EMOJI_MENU;
  setup(state);
  return emojiPicker(state);
}

function items(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.emoji-picker__item')).map((item) => item.getAttribute('data-arg') ?? '');
}

describe('the emoji set', () => {
  it('has no emoji twice and gives every one a word to find it by', () => {
    const chars = ALL_EMOJI.map((entry) => entry.char);
    expect(new Set(chars).size).toBe(chars.length);
    expect(ALL_EMOJI.every((entry) => entry.words.length > 0)).toBe(true);
  });

  it('finds emoji by Arabic or English words, however the Arabic is spelled', () => {
    expect(searchEmoji('thanks').map((entry) => entry.char)).toContain('🙏');
    expect(searchEmoji('شكرا').map((entry) => entry.char)).toContain('🙏');
    // Hamza and taa marbuta are typed both ways; both find the same emoji.
    expect(foldArabic('أهلاً')).toBe('اهلا');
    expect(searchEmoji('اهلا').map((entry) => entry.char)).toContain('👋');
    expect(searchEmoji('heart red').map((entry) => entry.char)).toEqual(['❤️']);
    expect(searchEmoji('❤️').map((entry) => entry.char)).toContain('❤️');
    expect(searchEmoji('   ')).toEqual([]);
  });

  it('remembers a short list of recent picks, newest first', () => {
    let recent: readonly string[] = [];
    for (const entry of ALL_EMOJI.slice(0, RECENT_EMOJI_LIMIT + 4)) recent = rememberEmoji(recent, entry.char);
    expect(recent).toHaveLength(RECENT_EMOJI_LIMIT);
    expect(recent[0]).toBe(ALL_EMOJI[RECENT_EMOJI_LIMIT + 3]!.char);
  });
});

describe('the emoji picker', () => {
  it('is only a button until it is opened', () => {
    const closed = picker((state) => {
      state.openMenu = null;
    });
    expect(closed.querySelector('.emoji-picker')).toBeNull();
    expect(closed.querySelector('[data-act="menu"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the first category when nothing has been used yet', () => {
    const root = picker();
    expect(root.querySelector('.emoji-picker__tab[data-arg="recent"]')).toBeNull();
    expect(root.querySelector('.emoji-picker__tab[aria-selected="true"]')?.getAttribute('data-arg')).toBe(EMOJI_CATEGORIES[0]!.id);
    expect(items(root)).toHaveLength(EMOJI_CATEGORIES[0]!.emojis.length);
  });

  it('leads with recent picks once there are some', () => {
    const root = picker((state) => {
      state.emojiRecent = ['🙏', '👍'];
    });
    expect(root.querySelector('.emoji-picker__tab[aria-selected="true"]')?.getAttribute('data-arg')).toBe('recent');
    expect(items(root)).toEqual(['🙏', '👍']);
  });

  it('shows the chosen category', () => {
    const root = picker((state) => {
      state.emojiCategory = 'hearts';
    });
    expect(items(root)).toContain('💙');
    expect(root.querySelector('.emoji-picker__heading')?.textContent).toBe('قلوب');
  });

  it('shows search results across categories, and says when there are none', () => {
    const found = picker((state) => {
      state.lang = 'en';
      state.emojiQuery = 'thanks';
    });
    expect(items(found)).toContain('🙏');
    expect(found.querySelector('.emoji-picker__tab[aria-selected="true"]')).toBeNull();
    expect(found.querySelector('.emoji-picker__heading')?.textContent).toBe('Results for “thanks”');

    const none = picker((state) => {
      state.emojiQuery = 'zzzz';
    });
    expect(items(none)).toEqual([]);
    expect(none.querySelector('.emoji-picker__empty')).not.toBeNull();
  });
});
