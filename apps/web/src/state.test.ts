import { describe, expect, it } from 'vitest';
import { CURRENT_MEMBER_ID } from './data';
import { createFilter } from './filters';
import { parseHash } from './router';
import {
  appendTimeline,
  applyRoute,
  clampListWidth,
  createState,
  currentActor,
  draftKey,
  findConversation,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  nextId,
  patchConversation,
  PREVIEW_STATES,
  pushToast,
  readDraft,
  routeParamsFor,
  screenTitle,
  VIEWABLE_ROLES,
  writeDraft,
} from './state';

const NOW = new Date('2026-09-08T12:00:00.000Z');

describe('createState', () => {
  it('boots in Arabic, as a supervisor, with the standard views', () => {
    const state = createState(NOW);
    expect(state.lang).toBe('ar');
    expect(state.role).toBe('supervisor');
    expect(state.preview).toBe('ready');
    expect(state.views).toHaveLength(state.dataset.views.length);
  });

  /**
   * Both optional side zones start closed and the timeline starts at full
   * width (task §3). A default-open panel is what pushed the message area
   * under 640px on a 1366px screen.
   */
  it('starts with both optional side zones closed and focus mode off', () => {
    const state = createState(NOW);
    expect(state.viewsOpen).toBe(false);
    expect(state.panelOpen).toBe(false);
    expect(state.listOpen).toBe(false);
    expect(state.focusMode).toBe(false);
    expect(state.listWidth).toBe(LIST_WIDTH_DEFAULT);
  });

  it('clamps the queue-list width into the supported range', () => {
    expect(clampListWidth(120)).toBe(LIST_WIDTH_MIN);
    expect(clampListWidth(999)).toBe(LIST_WIDTH_MAX);
    expect(clampListWidth(340.4)).toBe(340);
    expect(clampListWidth(Number.NaN)).toBe(LIST_WIDTH_DEFAULT);
  });

  it('copies the timelines so demo edits never mutate the seed', () => {
    const state = createState(NOW);
    appendTimeline(state, 'cv-4821', { kind: 'event', id: 'e-x', text: 'x', at: NOW.toISOString() });
    expect(state.timelines['cv-4821']?.length).toBe(
      (state.dataset.timelines['cv-4821']?.length ?? 0) + 1,
    );
  });
});

describe('currentActor', () => {
  it('keeps the identity and swaps only the effective role', () => {
    const state = createState(NOW);
    state.role = 'agent';
    const actor = currentActor(state);
    expect(actor.memberId).toBe(CURRENT_MEMBER_ID);
    expect(actor.role).toBe('agent');
    expect(actor.inboxIds.length).toBeGreaterThan(0);
  });

  it('degrades safely when the member record is missing', () => {
    const state = createState(NOW);
    state.dataset = { ...state.dataset, members: [] };
    expect(currentActor(state).name).toBe('CONVO');
    expect(currentActor(state).inboxIds).toEqual([]);
  });
});

describe('mutators', () => {
  it('patches one conversation without touching the others', () => {
    const state = createState(NOW);
    patchConversation(state, 'cv-4821', { unreadCount: 0 });
    expect(findConversation(state, 'cv-4821')?.unreadCount).toBe(0);
    expect(findConversation(state, 'cv-4817')?.unreadCount).toBeGreaterThan(0);
    expect(findConversation(state, 'cv-missing')).toBeUndefined();
  });

  it('appends to an unseen timeline key', () => {
    const state = createState(NOW);
    appendTimeline(state, 'cv-new', { kind: 'event', id: 'e', text: 'x', at: NOW.toISOString() });
    expect(state.timelines['cv-new']).toHaveLength(1);
  });

  it('issues monotonic ids', () => {
    const state = createState(NOW);
    expect(nextId(state, 'msg')).toBe('msg-1');
    expect(nextId(state, 'msg')).toBe('msg-2');
  });

  it('keeps at most three toasts', () => {
    const state = createState(NOW);
    for (let index = 0; index < 5; index += 1) pushToast(state, `t${index}`);
    expect(state.toasts).toHaveLength(3);
    expect(state.toasts[2]?.text).toBe('t4');
    pushToast(state, 'warn', 'warning');
    expect(state.toasts[2]?.tone).toBe('warning');
  });

  it('stores drafts per conversation and per tab', () => {
    const state = createState(NOW);
    expect(draftKey('cv-1', 'note')).toBe('cv-1|note');
    writeDraft(state, 'cv-1', 'reply', 'hello');
    expect(readDraft(state, 'cv-1', 'reply')).toBe('hello');
    expect(readDraft(state, 'cv-1', 'note')).toBe('');
    expect(readDraft(state, 'cv-2', 'reply')).toBe('');
  });
});

describe('URL <-> state', () => {
  it('encodes only what differs from the defaults', () => {
    const state = createState(NOW);
    expect(routeParamsFor(state)).toEqual({});
    state.lang = 'en';
    state.preview = 'offline';
    state.role = 'agent';
    state.activeViewId = 'v-sla';
    state.filter = { ...createFilter(), queue: 'mine', sort: 'sla', query: 'شحن' };
    expect(routeParamsFor(state)).toEqual({
      lang: 'en',
      state: 'offline',
      as: 'agent',
      view: 'v-sla',
      queue: 'mine',
      sort: 'sla',
      q: 'شحن',
    });
  });

  it('omits inbox-only parameters on other screens', () => {
    const state = createState(NOW);
    state.route = { screen: 'analytics', conversationId: null, params: {} };
    state.filter = { ...state.filter, queue: 'mine' };
    expect(routeParamsFor(state)).toEqual({});
  });

  it('restores language, preview state, role, queue, sort and query', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox/cv-4820?lang=en&state=loading&as=agent&queue=unread&sort=sla&q=abc'));
    expect(state.lang).toBe('en');
    expect(state.preview).toBe('loading');
    expect(state.role).toBe('agent');
    expect(state.filter.queue).toBe('unread');
    expect(state.filter.sort).toBe('sla');
    expect(state.filter.query).toBe('abc');
    expect(state.route.conversationId).toBe('cv-4820');
  });

  it('rebuilds a saved view named in the URL', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?view=v-vip'));
    expect(state.activeViewId).toBe('v-vip');
    expect(state.filter.labels).toEqual(['lb-vip']);
  });

  it('ignores unknown values and falls back to the defaults', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?state=nope&as=nope&queue=nope&sort=nope&view=nope&lang=de'));
    expect(state.preview).toBe('ready');
    expect(state.role).toBe('supervisor');
    expect(state.filter.queue).toBe('all');
    expect(state.filter.sort).toBe('recent');
    expect(state.activeViewId).toBeNull();
    expect(state.lang).toBe('ar');
  });

  it('leaves the inbox filter alone on a non-inbox route', () => {
    const state = createState(NOW);
    state.filter = { ...state.filter, queue: 'mine' };
    applyRoute(state, parseHash('#/channels'));
    expect(state.filter.queue).toBe('mine');
  });

  it('round-trips every preview state and viewable role', () => {
    const state = createState(NOW);
    for (const preview of PREVIEW_STATES) {
      applyRoute(state, parseHash(`#/inbox?state=${preview}`));
      expect(state.preview).toBe(preview);
    }
    for (const role of VIEWABLE_ROLES) {
      applyRoute(state, parseHash(`#/inbox?as=${role}`));
      expect(state.role).toBe(role);
    }
  });
});

describe('screenTitle', () => {
  it('names every screen in both languages', () => {
    expect(screenTitle('inbox', 'ar')).toBe('صندوق الوارد');
    expect(screenTitle('broadcasts', 'en')).toBe('Broadcasts');
    expect(screenTitle('settings', 'ar')).toBe('الإعدادات');
    expect(screenTitle('channels', 'en')).toBe('Channels');
    expect(screenTitle('people', 'en')).toBe('People & roles');
    expect(screenTitle('analytics', 'ar')).toBe('التقارير');
  });
});
