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
  routeParamsWithLanguage,
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
  it('adds language to manually authored deep links without exposing authority', () => {
    const state = createState(NOW);
    state.lang = 'en';
    expect(routeParamsWithLanguage(state, { view: 'mine', edit: 'automation-1' }))
      .toEqual({ view: 'mine', edit: 'automation-1', lang: 'en' });
  });

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
    state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, from: '2026-09-01', to: '2026-09-09', channel: 'whatsapp', campaignId: 'c-1' };
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

  it('round-trips a structured inbox query without exposing search text in the URL', () => {
    const state = createState(NOW);
    state.live.inboxQuery = {
      queue: 'all', sort: 'priority_desc', cursor: null, limit: 50, search: 'private customer words',
      filters: [{ key: 'label_id', operator: 'eq', value: '11111111-1111-4111-8111-111111111111' }],
    };
    const params = routeParamsFor(state);
    expect(params).toMatchObject({ scope: 'all', sort: 'priority_desc' });
    expect(params.search).toBeUndefined();
    const next = createState(NOW);
    applyRoute(next, parseHash(`#/inbox?scope=${params.scope}&sort=${params.sort}&filters=${encodeURIComponent(params.filters as string)}`));
    expect(next.live.inboxQuery).toMatchObject({ queue: 'all', sort: 'priority_desc', filters: state.live.inboxQuery.filters, search: null });
  });

  it('ignores a role in the URL, as it always must', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?as=owner'));
    expect(routeParamsFor(state)).toEqual({});
    expect((state as unknown as Record<string, unknown>)['role']).toBeUndefined();
  });

  it('drops malformed or unsupported Inbox deep-link filters before they reach state', () => {
    const state = createState(NOW);
    const malformed = encodeURIComponent(JSON.stringify([{ key: 'campaign_name', operator: 'eq', value: 'mutable' }]));
    applyRoute(state, parseHash(`#/inbox?sort=not-a-sort&filters=${malformed}`));
    expect(state.live.inboxQuery).toMatchObject({ sort: 'activity_desc', filters: [] });
    const valid = encodeURIComponent(JSON.stringify([{ key: 'campaign_id', operator: 'eq', value: '11111111-1111-4111-8111-111111111111' }]));
    applyRoute(state, parseHash(`#/inbox?filters=${valid}`));
    expect(state.live.inboxQuery.filters).toEqual([{ key: 'campaign_id', operator: 'eq', value: '11111111-1111-4111-8111-111111111111' }]);
  });

  it('reads the analytics scope back, and empties what is absent', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/analytics?from=2026-09-01&channel=instagram&campaign=c-9'));
    expect(state.analyticsFilters).toEqual({ ...NO_ANALYTICS_FILTERS, from: '2026-09-01', channel: 'instagram', campaignId: 'c-9' });
    applyRoute(state, parseHash('#/analytics?to=2026-09-10'));
    expect(state.analyticsFilters).toEqual({ ...NO_ANALYTICS_FILTERS, to: '2026-09-10' });
  });

  it('round-trips assignment reports and their safe filter dimensions in the URL', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/analytics?view=assignments&lang=en&from=2026-09-01&agentFilter=00000000-0000-4000-8000-000000000001&channel=whatsapp'));
    expect(state.analyticsView).toBe('assignments');
    expect(state.analyticsFilters).toMatchObject({ from: '2026-09-01', agentId: '00000000-0000-4000-8000-000000000001', channel: 'whatsapp' });
    expect(routeParamsFor(state)).toMatchObject({ view: 'assignments', lang: 'en', from: '2026-09-01', agentFilter: '00000000-0000-4000-8000-000000000001', channel: 'whatsapp' });
  });

  it('maps legacy operations links to overview and round-trips the final report vocabulary', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/analytics?view=operations&lang=en&from=2026-09-01&to=2026-09-09&agentFilter=00000000-0000-4000-8000-000000000001&team=00000000-0000-4000-8000-000000000002&channel=whatsapp&connection=00000000-0000-4000-8000-000000000003&label=00000000-0000-4000-8000-000000000004&campaign=00000000-0000-4000-8000-000000000005&priority=high&status=open'));
    expect(state.analyticsView).toBe('overview');
    expect(routeParamsFor(state)).toMatchObject({
      view: 'overview', lang: 'en', from: '2026-09-01', to: '2026-09-09',
      agentFilter: '00000000-0000-4000-8000-000000000001', team: '00000000-0000-4000-8000-000000000002',
      channel: 'whatsapp', connection: '00000000-0000-4000-8000-000000000003',
      label: '00000000-0000-4000-8000-000000000004', campaign: '00000000-0000-4000-8000-000000000005',
      priority: 'high', status: 'open',
    });
  });

  it('does not let an omitted or invalid route language erase the current preference', () => {
    const state = createState(NOW);
    state.lang = 'en';
    applyRoute(state, parseHash('#/inbox?queue=nope&lang=de'));
    expect(state.inboxQueue).toBe('unassigned');
    expect(state.lang).toBe('en');
  });

  it('leaves the queue alone on a non-inbox route', () => {
    const state = createState(NOW);
    state.inboxQueue = 'mine';
    applyRoute(state, parseHash('#/channels'));
    expect(state.inboxQueue).toBe('mine');
  });

  it('rejects every malformed inbox filter shape before it reaches client state', () => {
    const state = createState(NOW);
    const apply = (filters: unknown): readonly unknown[] => {
      const encoded = encodeURIComponent(JSON.stringify(filters));
      applyRoute(state, parseHash(`#/inbox?filters=${encoded}`));
      return state.live.inboxQuery.filters as readonly unknown[];
    };
    expect(apply({ key: 'status', operator: 'eq', value: 'open' })).toEqual([]);
    expect(apply([{ key: 'status', operator: 'not-supported', value: 'open' }])).toEqual([]);
    expect(apply([{ key: 'status', operator: 'eq' }])).toEqual([]);
    expect(apply([{ key: 'custom_field', operator: 'eq', value: 'x' }])).toEqual([]);
    expect(apply([{ key: 'status', operator: 'eq', fieldId: '11111111-1111-4111-8111-111111111111', value: 'open' }])).toEqual([]);
    expect(apply([{ key: 'waiting_since', operator: 'is_set', value: true }])).toEqual([]);
    expect(apply([{ key: 'waiting_since', operator: 'is_set' }])).toEqual([{ key: 'waiting_since', operator: 'is_set' }]);
    expect(apply([{ key: 'priority', operator: 'eq', value: true }])).toEqual([]);
    expect(apply([{ key: 'priority', operator: 'eq', value: ['high', 'urgent'] }])).toEqual([{ key: 'priority', operator: 'eq', value: ['high', 'urgent'] }]);
    expect(apply([{ key: 'priority', operator: 'eq', value: [] }])).toEqual([]);
    expect(apply([{ key: 'priority', operator: 'eq', value: ['high', 1] }])).toEqual([]);
    expect(apply([{ key: 'custom_field', operator: 'eq', fieldId: '11111111-1111-4111-8111-111111111111', value: 'yes' }])).toEqual([{ key: 'custom_field', operator: 'eq', fieldId: '11111111-1111-4111-8111-111111111111', value: 'yes' }]);
  });

  it('rejects oversized, non-array and invalid JSON filter payloads', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash(`#/inbox?filters=${'x'.repeat(6001)}`));
    expect(state.live.inboxQuery.filters).toEqual([]);
    applyRoute(state, parseHash(`#/inbox?filters=${encodeURIComponent(JSON.stringify({ key: 'status' }))}`));
    expect(state.live.inboxQuery.filters).toEqual([]);
    applyRoute(state, parseHash('#/inbox?filters=%7B'));
    expect(state.live.inboxQuery.filters).toEqual([]);
    const tooMany = Array.from({ length: 21 }, () => ({ key: 'status', operator: 'is_set' }));
    applyRoute(state, parseHash(`#/inbox?filters=${encodeURIComponent(JSON.stringify(tooMany))}`));
    expect(state.live.inboxQuery.filters).toEqual([]);
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
