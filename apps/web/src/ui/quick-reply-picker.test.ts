/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { QuickReply } from '../api/metadata.js';
import { createState } from '../state.js';
import type { AppState } from '../state.js';
import { renderDialog } from './dialogs.js';
import { quickRepliesPanel, quickReplyDeleteDialog, quickReplyDialog } from './quick-replies-panel.js';
import { QUICK_REPLY_MENU, quickReplyPicker, slashSuggestions } from './quick-reply-picker.js';

const PRICES: QuickReply = { id: 'q-1', shortcut: 'prices', title: 'Price list', kind: 'text', body: 'Our prices start at 1,000 EGP for the full course.', location: null, version: 1, updatedAt: '2026-11-10T00:00:00Z' };
const BRANCH: QuickReply = {
  id: 'q-2', shortcut: 'branch', title: 'Branch', kind: 'location', body: '',
  location: { name: 'Nasr City', address: null, latitude: 30, longitude: 31 }, version: 1, updatedAt: '2026-11-10T00:00:00Z',
};
const LONG: QuickReply = { ...PRICES, id: 'q-3', shortcut: 'long', body: 'x '.repeat(80) };

function screen(lang: 'ar' | 'en' = 'en', permissions: readonly string[] = ['catalog.manage']): AppState {
  const state = createState(new Date('2026-11-10T00:00:00Z'));
  state.lang = lang;
  state.live.session = {
    status: 'signed_in', email: 'a@b.c', tenantId: 't',
    memberships: [{ id: 'm', tenant: { id: 't', name: 'DS', slug: 'ds' }, role: { id: 'r', key: 'admin', name: 'Admin' }, permissions }],
  };
  return state;
}

const text = (element: Element | null): string => element?.textContent ?? '';

describe('the composer quick reply button', () => {
  it('is a closed button until opened', () => {
    const state = screen();
    const root = quickReplyPicker(state);
    expect(root.querySelector('[data-act="menu"]')?.getAttribute('data-arg')).toBe(QUICK_REPLY_MENU);
    expect(root.querySelector('.quick-replies')).toBeNull();
  });

  it('lists locations first, then the rest, each inserting by id', () => {
    const state = screen();
    state.openMenu = QUICK_REPLY_MENU;
    state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH, LONG], loadedAt: 1 };
    const root = quickReplyPicker(state);
    expect(root.querySelector('[data-act="menu"]')?.className).toContain('btn--active');
    const items = Array.from(root.querySelectorAll('[data-act="live-quick-reply-pick"]'));
    expect(items.map((item) => item.getAttribute('data-arg'))).toEqual(['q-2', 'q-1', 'q-3']);
    expect(items[0]?.querySelector('svg')).not.toBeNull();
    expect(items[0]?.getAttribute('role')).toBeNull();
    expect(text(items[0]?.querySelector('.quick-reply__preview') ?? null)).toContain('maps');
    expect(text(items[2]?.querySelector('.quick-reply__preview') ?? null).endsWith('…')).toBe(true);
  });

  it('says when it is loading, failed, or empty, and who can add replies', () => {
    const state = screen();
    state.openMenu = QUICK_REPLY_MENU;
    expect(text(quickReplyPicker(state))).toContain('Loading replies');
    state.live.quickReplies = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r', status: 500, details: [] } };
    expect(quickReplyPicker(state).querySelector('[data-act="live-quick-replies-reload"]')).not.toBeNull();
    state.live.quickReplies = { status: 'ready', value: [], loadedAt: 1 };
    expect(text(quickReplyPicker(state))).toContain('Add them in Settings');
    const agent = screen('ar', []);
    agent.openMenu = QUICK_REPLY_MENU;
    agent.live.quickReplies = { status: 'ready', value: [], loadedAt: 1 };
    expect(text(quickReplyPicker(agent))).toContain('اطلب من المسؤول');
  });
});

describe('the "/" suggestions', () => {
  it('is absent without a slash and waits for replies to load', () => {
    const state = screen();
    expect(slashSuggestions(state)).toBeNull();
    state.live.slash = { start: 0, end: 1, query: '' };
    expect(text(slashSuggestions(state))).toContain('Loading replies');
  });

  it('highlights the active match as a listbox option', () => {
    const state = screen();
    state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    state.live.slash = { start: 0, end: 1, query: '' };
    state.live.slashActive = 5;
    const list = slashSuggestions(state) as HTMLElement;
    const options = Array.from(list.querySelectorAll('[role="option"]'));
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(list.querySelector('#slash-active')?.getAttribute('data-arg')).toBe('q-2');
    expect(list.querySelector('[role="listbox"]')?.id).toBe('slash-list');
  });

  it('says plainly when nothing matches, or nothing exists', () => {
    const state = screen();
    state.live.quickReplies = { status: 'ready', value: [PRICES], loadedAt: 1 };
    state.live.slash = { start: 0, end: 4, query: 'zzz' };
    expect(text(slashSuggestions(state))).toContain('No reply matches “/zzz”');
    state.live.quickReplies = { status: 'ready', value: [], loadedAt: 1 };
    state.live.slash = { start: 0, end: 1, query: '' };
    expect(text(slashSuggestions(state))).toContain('No quick replies yet.');
  });
});

describe('the quick reply manager', () => {
  it('lists replies with edit and delete, or says there are none', () => {
    const state = screen();
    expect(quickRepliesPanel(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.quickReplies = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r-9', status: 500, details: [] } };
    expect(text(quickRepliesPanel(state))).toContain('r-9');
    state.live.quickReplies = { status: 'ready', value: [], loadedAt: 1 };
    expect(text(quickRepliesPanel(state))).toContain('No quick replies');
    state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    const panel = quickRepliesPanel(state);
    expect(Array.from(panel.querySelectorAll('tbody code')).map((cell) => cell.textContent)).toEqual(['/prices', '/branch']);
    expect(panel.querySelector('[data-arg="quick-reply:q-1"]')).not.toBeNull();
    expect(panel.querySelector('[data-arg="quick-reply-delete:q-2"]')).not.toBeNull();
    expect(panel.querySelector('[data-arg="quick-reply-location"]')).not.toBeNull();
  });

  it('opens a text reply form, and switches to a location with a map check', () => {
    const state = screen();
    state.dialog = { kind: 'quick-reply', arg: '' };
    const blank = renderDialog(state) as HTMLElement;
    expect(blank.querySelector('[data-form="quickReplyPlace"]')).toBeNull();
    expect(blank.querySelector('[data-arg="quickReplyKind:text"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(text(blank)).toContain('New quick reply');
    state.dialogForm = { quickReplyKind: 'location', quickReplyLatitude: '30', quickReplyLongitude: '31' };
    const place = renderDialog(state) as HTMLElement;
    expect(place.querySelector('[data-form="quickReplyPlace"]')).not.toBeNull();
    expect(place.querySelector('a.link')?.getAttribute('href')).toBe('https://www.google.com/maps/search/?api=1&query=30,31');
    state.dialogForm = { quickReplyKind: 'location' };
    expect((renderDialog(state) as HTMLElement).querySelector('a.link')).toBeNull();
  });

  it('starts "New location" on the location type and edits keep stored values', () => {
    const state = screen('ar');
    state.dialog = { kind: 'quick-reply-location', arg: '' };
    expect(text(renderDialog(state))).toContain('موقع جديد');
    expect((renderDialog(state) as HTMLElement).querySelector('[data-form="quickReplyLatitude"]')).not.toBeNull();
    state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    const edit = quickReplyDialog(state, 'q-2', 'text');
    expect((edit.querySelector('[data-form="quickReplyLatitude"]') as HTMLInputElement).value).toBe('30');
    expect((edit.querySelector('[data-form="quickReplyShortcut"]') as HTMLInputElement).value).toBe('branch');
    expect(text(edit)).toContain('تعديل الرد السريع');
    const editText = quickReplyDialog(state, 'q-1', 'text');
    expect(editText.querySelector('textarea')?.value).toBe(PRICES.body);
    const switched = { ...state, dialogForm: { quickReplyKind: 'location' } } as AppState;
    expect((quickReplyDialog(switched, 'q-1', 'text').querySelector('[data-form="quickReplyLatitude"]') as HTMLInputElement).value).toBe('');
    state.live.busy = 'quick-reply:update:q-1';
    expect(quickReplyDialog(state, 'q-1', 'text').querySelector('[data-act="live-quick-reply-save"]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('confirms a delete, or says the reply is gone', () => {
    const state = screen();
    state.live.quickReplies = { status: 'ready', value: [PRICES], loadedAt: 1 };
    state.dialog = { kind: 'quick-reply-delete', arg: 'q-1' };
    expect((renderDialog(state) as HTMLElement).querySelector('[data-act="live-quick-reply-delete-confirm"]')?.getAttribute('data-arg')).toBe('q-1');
    expect(text(quickReplyDeleteDialog(state, 'missing'))).toContain('no longer exists');
  });
});
