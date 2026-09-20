import { describe, expect, it } from 'vitest';
import { parseHash } from './router';
import {
  applyRoute,
  clampListWidth,
  createState,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  NO_ANALYTICS_FILTERS,
  nextId,
  pushToast,
  routeParamsFor,
  screenTitle,
} from './state';

/**
 * Workspace state.
 *
 * The view choices an operator makes — screen, language, drawers, filters —
 * and `live`, which holds only what the server said. There is no role here:
 * authority comes from the session the server returns, never from local state
 * or the URL.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

describe('createState', () => {
  it('boots in Arabic, signed out of nothing yet, showing the unassigned queue', () => {
    const state = createState(NOW);
    expect(state.lang).toBe('ar');
    expect(state.inboxQueue).toBe('unassigned');
    expect(state.clock).toEqual(NOW);
    // The session is unknown until the server answers the probe.
    expect(state.live.session).toEqual({ status: 'unknown' });
    expect(state.composerTab).toBe('reply');
    expect(state.analyticsFilters).toEqual(NO_ANALYTICS_FILTERS);
  });

  it('carries no role, dataset or impersonation of any kind', () => {
    const state = createState(NOW) as unknown as Record<string, unknown>;
    expect(state['role']).toBeUndefined();
    expect(state['dataset']).toBeUndefined();
  });

  it('starts with every drawer closed, the navigation collapsed and the panel wanted', () => {
    const state = createState(NOW);
    expect(state.listOpen).toBe(false);
    expect(state.navOpen).toBe(false);
    expect(state.navCollapsed).toBe(true);
    expect(state.panelOpen).toBe(true);
    expect(state.panelDrawer).toBe(false);
    expect(state.listWidth).toBe(LIST_WIDTH_DEFAULT);
  });

  it('clamps the queue-list width into the supported range', () => {
    expect(clampListWidth(120)).toBe(LIST_WIDTH_MIN);
    expect(clampListWidth(999)).toBe(LIST_WIDTH_MAX);
    expect(clampListWidth(340.4)).toBe(340);
    expect(clampListWidth(Number.NaN)).toBe(LIST_WIDTH_DEFAULT);
  });
});

describe('toasts', () => {
  it('numbers each one and keeps only the last three', () => {
    const state = createState(NOW);
    for (const text of ['one', 'two', 'three', 'four']) {
      pushToast(state, text);
    }
    expect(state.toasts.map((toast) => toast.text)).toEqual(['two', 'three', 'four']);
    expect(new Set(state.toasts.map((toast) => toast.id)).size).toBe(3);
  });

  it('carries a tone, defaulting to plain', () => {
    const state = createState(NOW);
    pushToast(state, 'plain');
    pushToast(state, 'bad', 'danger');
    expect(state.toasts[0]?.tone).toBe('default');
    expect(state.toasts[1]?.tone).toBe('danger');
  });

  it('hands out ids that do not repeat', () => {
    const state = createState(NOW);
    expect(nextId(state, 'x')).toBe('x-1');
    expect(nextId(state, 'x')).toBe('x-2');
  });
});

describe('URL round-trip', () => {
  it('encodes only what is worth sharing', () => {
    const state = createState(NOW);
    expect(routeParamsFor(state)).toEqual({});
    state.lang = 'en';
    state.inboxQueue = 'mine';
    expect(routeParamsFor(state)).toEqual({ lang: 'en', queue: 'mine' });
  });

  it('does not encode the queue on another screen', () => {
    const state = createState(NOW);
    state.inboxQueue = 'mine';
    state.route = { ...state.route, screen: 'channels' };
    expect(routeParamsFor(state).queue).toBeUndefined();
  });

  it('encodes the analytics scope on the analytics screen only', () => {
    const state = createState(NOW);
    state.analyticsFilters = { from: '2026-09-01', to: '2026-09-09', channel: 'whatsapp', campaignId: 'c-1' };
    expect(routeParamsFor(state)).toEqual({});
    state.route = { ...state.route, screen: 'analytics' };
    expect(routeParamsFor(state)).toEqual({ from: '2026-09-01', to: '2026-09-09', channel: 'whatsapp', campaign: 'c-1' });
    state.analyticsFilters = NO_ANALYTICS_FILTERS;
    expect(routeParamsFor(state)).toEqual({});
  });

  it('keeps the selected automation view and editor in the shareable route', () => {
    const state = createState(NOW);
    state.route = parseHash('#/automations?view=mine&edit=automation-1');
    expect(routeParamsFor(state)).toEqual({ view: 'mine', edit: 'automation-1' });
    state.route = parseHash('#/automations?view=unknown&edit=');
    expect(routeParamsFor(state)).toEqual({});
  });

  it('reads the language, the queue and the conversation back', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox/cv-4820?lang=en&queue=mine'));
    expect(state.lang).toBe('en');
    expect(state.inboxQueue).toBe('mine');
    expect(state.route.conversationId).toBe('cv-4820');
  });

  it('ignores a role in the URL, as it always must', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?as=owner'));
    expect(routeParamsFor(state)).toEqual({});
    expect((state as unknown as Record<string, unknown>)['role']).toBeUndefined();
  });

  it('reads the analytics scope back, and empties what is absent', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/analytics?from=2026-09-01&channel=instagram&campaign=c-9'));
    expect(state.analyticsFilters).toEqual({ from: '2026-09-01', to: '', channel: 'instagram', campaignId: 'c-9' });
    applyRoute(state, parseHash('#/analytics?to=2026-09-10'));
    expect(state.analyticsFilters).toEqual({ from: '', to: '2026-09-10', channel: '', campaignId: '' });
  });

  it('falls back to the defaults for values it does not recognise', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?queue=nope&lang=de'));
    expect(state.inboxQueue).toBe('unassigned');
    expect(state.lang).toBe('ar');
  });

  it('leaves the queue alone on a non-inbox route', () => {
    const state = createState(NOW);
    state.inboxQueue = 'mine';
    applyRoute(state, parseHash('#/channels'));
    expect(state.inboxQueue).toBe('mine');
  });
});

describe('screenTitle', () => {
  it('names every screen in both languages', () => {
    expect(screenTitle('inbox', 'ar')).toBe('صندوق الوارد');
    expect(screenTitle('broadcasts', 'en')).toBe('Campaigns');
    expect(screenTitle('settings', 'ar')).toBe('الإعدادات');
    expect(screenTitle('channels', 'en')).toBe('Channels');
    expect(screenTitle('people', 'en')).toBe('People & roles');
    expect(screenTitle('contacts', 'en')).toBe('Contacts');
    expect(screenTitle('analytics', 'ar')).toBe('التقارير');
  });
});
