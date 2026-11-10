import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult } from '../api/client.js';
import type { MetadataApi, QuickReply } from '../api/metadata.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { applyQuickReply, mapsUrl, matchQuickReplies, quickReplyText, slashToken } from './quick-replies.js';
import { closeSlash, deleteQuickReply, loadQuickReplies, moveSlash, quickReplyInputFrom, saveQuickReply, trackSlash } from './quick-reply-actions.js';

const ERROR: ApiError = { code: 'quick_reply_shortcut_taken', message: 'Taken', requestId: 'r', status: 409, details: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T = never>(): ApiResult<T> => ({ ok: false, error: ERROR });

const PRICES: QuickReply = { id: 'q-1', shortcut: 'prices', title: 'Price list', kind: 'text', body: 'Our prices start at 1,000 EGP.', location: null, version: 1, updatedAt: '2026-11-10T00:00:00Z' };
const BRANCH: QuickReply = {
  id: 'q-2', shortcut: 'فرع', title: 'Nasr City branch', kind: 'location', body: 'Open 10–8',
  location: { name: 'Nasr City branch', address: '12 Abbas El Akkad', latitude: 30.0561, longitude: 31.3301 }, version: 3, updatedAt: '2026-11-10T00:00:00Z',
};
const HOURS: QuickReply = { ...PRICES, id: 'q-3', shortcut: 'hours', title: 'Opening prices hours', body: 'We open at 10.' };

describe('slash tokens', () => {
  it('opens at the start of the draft or after whitespace, up to the caret', () => {
    expect(slashToken('/pri', 4)).toEqual({ start: 0, end: 4, query: 'pri' });
    expect(slashToken('Hi /', 4)).toEqual({ start: 3, end: 4, query: '' });
    expect(slashToken('Hi\n/فر', 6)).toEqual({ start: 3, end: 6, query: 'فر' });
    expect(slashToken('/prices later', 4)).toEqual({ start: 0, end: 4, query: 'pri' });
    expect(slashToken('/pri', 99)).toEqual({ start: 0, end: 4, query: 'pri' });
  });

  it('stays shut for links, dates, finished words and a caret before the slash', () => {
    expect(slashToken('https://x.com/a', 15)).toBeNull();
    expect(slashToken('1/2', 3)).toBeNull();
    expect(slashToken('/prices ', 8)).toBeNull();
    expect(slashToken('/pri', -1)).toBeNull();
    expect(slashToken('', 0)).toBeNull();
  });
});

describe('matching', () => {
  it('lists everything for a bare slash, prefix matches first, then contains', () => {
    expect(matchQuickReplies([PRICES, BRANCH, HOURS], '')).toEqual([PRICES, BRANCH, HOURS]);
    expect(matchQuickReplies([HOURS, PRICES], 'pri')).toEqual([PRICES, HOURS]);
    expect(matchQuickReplies([PRICES, HOURS], 'ICE')).toEqual([PRICES, HOURS]);
    expect(matchQuickReplies([PRICES, HOURS], 'open')).toEqual([HOURS]);
    expect(matchQuickReplies([PRICES, BRANCH], 'فر')).toEqual([BRANCH]);
    expect(matchQuickReplies([PRICES, BRANCH], 'zzz')).toEqual([]);
    expect(matchQuickReplies([PRICES, BRANCH, HOURS], '', 2)).toHaveLength(2);
  });
});

describe('quick reply text', () => {
  it('sends a text reply as written and a location as place, address, map link and note', () => {
    expect(quickReplyText(PRICES)).toBe(PRICES.body);
    expect(mapsUrl(BRANCH.location!)).toBe('https://www.google.com/maps/search/?api=1&query=30.0561,31.3301');
    expect(quickReplyText(BRANCH)).toBe('📍 Nasr City branch\n12 Abbas El Akkad\nhttps://www.google.com/maps/search/?api=1&query=30.0561,31.3301\nOpen 10–8');
    expect(quickReplyText({ ...BRANCH, body: '', location: { ...BRANCH.location!, address: null } }))
      .toBe('📍 Nasr City branch\nhttps://www.google.com/maps/search/?api=1&query=30.0561,31.3301');
    expect(quickReplyText({ ...BRANCH, location: null })).toBe('Open 10–8');
  });

  it('replaces the selection and puts the caret after the inserted text', () => {
    expect(applyQuickReply('Hi /pri!', { start: 3, end: 7 }, 'PRICES')).toEqual({ value: 'Hi PRICES!', caret: 9 });
  });
});

function setup() {
  const state = createState(new Date('2026-11-10T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
  const metadata = {
    quickReplies: vi.fn().mockResolvedValue(ok([PRICES, BRANCH])),
    createQuickReply: vi.fn().mockResolvedValue(ok(HOURS)),
    updateQuickReply: vi.fn().mockResolvedValue(ok({ ...PRICES, title: 'Prices', version: 2 })),
    deleteQuickReply: vi.fn().mockResolvedValue(ok({ deleted: true })),
  } as unknown as MetadataApi;
  Object.defineProperty(state.live, 'metadataApi', { value: metadata });
  const refresh = vi.fn();
  const context: LiveContext = { state, live: state.live, refresh, now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, metadata, refresh };
}

describe('loading', () => {
  it('reads once per visit unless forced', async () => {
    const app = setup();
    await loadQuickReplies(app.context);
    expect(app.state.live.quickReplies).toMatchObject({ status: 'ready', value: [PRICES, BRANCH] });
    await loadQuickReplies(app.context);
    app.state.live.quickReplies = { status: 'loading' };
    await loadQuickReplies(app.context);
    expect(app.metadata.quickReplies).toHaveBeenCalledTimes(1);
    await loadQuickReplies(app.context, true);
    expect(app.metadata.quickReplies).toHaveBeenCalledTimes(2);
  });

  it('records a refusal and skips without a workspace', async () => {
    const app = setup();
    vi.mocked(app.metadata.quickReplies).mockResolvedValueOnce(fail());
    await loadQuickReplies(app.context);
    expect(app.state.live.quickReplies).toMatchObject({ status: 'error' });
    const signedOut = setup();
    signedOut.state.live.session = { status: 'signed_out', error: null };
    await loadQuickReplies(signedOut.context);
    expect(signedOut.metadata.quickReplies).not.toHaveBeenCalled();
  });
});

describe('the dialog draft', () => {
  it('takes typed values over stored ones and strips a leading slash', () => {
    expect(quickReplyInputFrom({ quickReplyShortcut: ' /New ', quickReplyTitle: 'T', quickReplyBody: ' Hello ' }, undefined))
      .toEqual({ shortcut: 'New', title: 'T', kind: 'text', body: 'Hello', location: null });
    expect(quickReplyInputFrom({ quickReplyTitle: 'Renamed' }, PRICES)).toEqual({ shortcut: 'prices', title: 'Renamed', kind: 'text', body: PRICES.body, location: null });
  });

  it('builds a location from the place fields, keeping unparseable coordinates for the server to refuse', () => {
    expect(quickReplyInputFrom({}, BRANCH).location).toEqual(BRANCH.location);
    expect(quickReplyInputFrom({ quickReplyKind: 'location', quickReplyPlace: 'HQ', quickReplyLatitude: '30.1', quickReplyLongitude: ' 31.2 ' }, undefined))
      .toEqual({ shortcut: '', title: '', kind: 'location', body: '', location: { name: 'HQ', address: null, latitude: 30.1, longitude: 31.2 } });
    const blank = quickReplyInputFrom({ quickReplyKind: 'location' }, undefined).location;
    expect(blank?.name).toBe('');
    expect(Number.isNaN(blank?.latitude)).toBe(true);
    expect(quickReplyInputFrom({ quickReplyKind: 'text' }, BRANCH).location).toBeNull();
  });
});

describe('saving and deleting', () => {
  it('creates a reply, closes the dialog and keeps the list ordered by shortcut', async () => {
    const app = setup();
    app.state.live.quickReplies = { status: 'ready', value: [PRICES], loadedAt: 1 };
    app.state.dialog = { kind: 'quick-reply', arg: '' };
    app.state.dialogForm = { quickReplyShortcut: 'hours', quickReplyTitle: 'Hours', quickReplyBody: 'We open at 10.' };
    expect(await saveQuickReply(app.context)).toBe(true);
    expect(app.metadata.createQuickReply).toHaveBeenCalledWith('tenant-1', { shortcut: 'hours', title: 'Hours', kind: 'text', body: 'We open at 10.', location: null });
    expect(app.state.live.quickReplies).toMatchObject({ value: [HOURS, PRICES] });
    expect(app.state.dialog).toBeNull();
    expect(app.state.toasts.at(-1)?.text).toBe('Quick reply saved.');
  });

  it('starts "New location" on the location type', async () => {
    const app = setup();
    app.state.dialog = { kind: 'quick-reply-location', arg: '' };
    app.state.dialogForm = { quickReplyShortcut: 'hq', quickReplyTitle: 'HQ', quickReplyPlace: 'HQ', quickReplyLatitude: '1', quickReplyLongitude: '2' };
    expect(await saveQuickReply(app.context)).toBe(true);
    expect(vi.mocked(app.metadata.createQuickReply).mock.calls[0]?.[1]).toMatchObject({ kind: 'location', location: { name: 'HQ', latitude: 1, longitude: 2 } });
  });

  it('updates the reply the dialog is open on with its version', async () => {
    const app = setup();
    app.state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    app.state.dialog = { kind: 'quick-reply', arg: PRICES.id };
    app.state.dialogForm = { quickReplyTitle: 'Prices' };
    expect(await saveQuickReply(app.context)).toBe(true);
    expect(app.metadata.updateQuickReply).toHaveBeenCalledWith('tenant-1', PRICES.id, 1, expect.objectContaining({ title: 'Prices' }));
    expect(app.state.toasts.at(-1)?.text).toBe('Quick reply updated.');
    expect(app.state.live.quickReplies).toMatchObject({ value: [{ id: 'q-1', title: 'Prices', version: 2 }, BRANCH] });
  });

  it('keeps the dialog open with the refusal', async () => {
    const app = setup();
    vi.mocked(app.metadata.createQuickReply).mockResolvedValueOnce(fail());
    app.state.dialog = { kind: 'quick-reply', arg: '' };
    expect(await saveQuickReply(app.context)).toBe(false);
    expect(app.state.live.error).toEqual(ERROR);
    expect(app.state.dialog).not.toBeNull();
    const signedOut = setup();
    signedOut.state.live.session = { status: 'signed_out', error: null };
    expect(await saveQuickReply(signedOut.context)).toBe(false);
  });

  it('deletes by id and version, and refuses what it does not know', async () => {
    const app = setup();
    app.state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    app.state.dialog = { kind: 'quick-reply-delete', arg: BRANCH.id };
    expect(await deleteQuickReply(app.context, 'missing')).toBe(false);
    expect(await deleteQuickReply(app.context, BRANCH.id)).toBe(true);
    expect(app.metadata.deleteQuickReply).toHaveBeenCalledWith('tenant-1', BRANCH.id, 3);
    expect(app.state.live.quickReplies).toMatchObject({ value: [PRICES] });
    expect(app.state.dialog).toBeNull();
    app.state.lang = 'ar';
    app.state.live.quickReplies = { status: 'ready', value: [PRICES, HOURS], loadedAt: 1 };
    expect(await deleteQuickReply(app.context, HOURS.id)).toBe(true);
    expect(app.state.toasts.at(-1)?.text).toBe('حُذف الرد السريع.');
    vi.mocked(app.metadata.deleteQuickReply).mockResolvedValueOnce(fail());
    expect(await deleteQuickReply(app.context, PRICES.id)).toBe(false);
    expect(app.state.live.error).toEqual(ERROR);
  });
});

describe('the "/" list', () => {
  it('opens, follows the query, and redraws only when it changes', () => {
    const app = setup();
    app.state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH, HOURS], loadedAt: 1 };
    app.state.live.composer = 'Hello';
    trackSlash(app.context, 5);
    expect(app.refresh).not.toHaveBeenCalled();
    app.state.live.composer = 'Hello /';
    trackSlash(app.context, 7);
    expect(app.state.live.slash).toEqual({ start: 6, end: 7, query: '' });
    expect(app.refresh).toHaveBeenCalledTimes(1);
    trackSlash(app.context, 7);
    expect(app.refresh).toHaveBeenCalledTimes(1);
    moveSlash(app.context, 1);
    moveSlash(app.context, 1);
    moveSlash(app.context, 1);
    expect(app.state.live.slashActive).toBe(0);
    moveSlash(app.context, -1);
    expect(app.state.live.slashActive).toBe(2);
    app.state.live.composer = 'Hello /p';
    trackSlash(app.context, 8);
    expect(app.state.live.slash?.query).toBe('p');
    expect(app.state.live.slashActive).toBe(0);
    closeSlash(app.context);
    expect(app.state.live.slash).toBeNull();
  });

  it('does nothing to move with no matches, and fetches replies on the first slash', () => {
    const app = setup();
    moveSlash(app.context, 1);
    expect(app.refresh).not.toHaveBeenCalled();
    app.state.live.composer = '/';
    trackSlash(app.context, 1);
    expect(app.metadata.quickReplies).toHaveBeenCalledTimes(1);
    app.state.live.quickReplies = { status: 'ready', value: [], loadedAt: 1 };
    moveSlash(app.context, 1);
    expect(app.state.live.slashActive).toBe(0);
    app.state.live.composer = '/x';
    trackSlash(app.context, 2);
    expect(app.metadata.quickReplies).toHaveBeenCalledTimes(1);
  });
});

describe('the quick reply actions on the dispatch table', () => {
  it('routes save, delete, reload and the "/" list keys to their actions', async () => {
    const { LIVE_ACTIONS } = await import('./dispatch.js');
    const app = setup();
    app.state.live.quickReplies = { status: 'ready', value: [PRICES, BRANCH], loadedAt: 1 };
    await LIVE_ACTIONS['live-quick-replies-reload']?.(app.context, '');
    expect(app.metadata.quickReplies).toHaveBeenCalledTimes(1);
    app.state.dialog = { kind: 'quick-reply', arg: '' };
    app.state.dialogForm = { quickReplyShortcut: 'hours', quickReplyTitle: 'Hours', quickReplyBody: 'x' };
    expect(await LIVE_ACTIONS['live-quick-reply-save']?.(app.context, '')).toBe(true);
    expect(await LIVE_ACTIONS['live-quick-reply-delete-confirm']?.(app.context, PRICES.id)).toBe(true);
    app.state.live.composer = '/';
    await LIVE_ACTIONS['live-slash']?.(app.context, '1');
    expect(app.state.live.slash).toEqual({ start: 0, end: 1, query: '' });
    await LIVE_ACTIONS['live-slash-move']?.(app.context, '1');
    expect(app.state.live.slashActive).toBe(1);
    await LIVE_ACTIONS['live-slash-close']?.(app.context, '');
    expect(app.state.live.slash).toBeNull();
  });
});
