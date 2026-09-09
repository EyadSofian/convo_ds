import { describe, expect, it } from 'vitest';
import { parseHash } from './router';
import {
  applyRoute,
  clampListWidth,
  createState,
  currentActor,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  nextId,
  pushToast,
  routeParamsFor,
  screenTitle,
  VIEWABLE_ROLES,
} from './state';

/**
 * Workspace state, after the Inbox became server-backed.
 *
 * What used to live in this state — a local copy of every conversation, the
 * filters over them, the drafts and the saved views — is gone. The Inbox reads
 * from `state.live`, which is exercised against a real server elsewhere. What
 * remains here is the shell: the route, the language, the list column, dialogs
 * and the seeded dataset the three remaining demo screens still draw from.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

describe('createState', () => {
  it('boots in Arabic, as a supervisor, showing the unassigned queue', () => {
    const state = createState(NOW);
    expect(state.lang).toBe('ar');
    expect(state.role).toBe('supervisor');
    expect(state.inboxQueue).toBe('unassigned');
    expect(state.clock).toEqual(NOW);
  });

  it('holds no conversation of its own', () => {
    const state = createState(NOW);
    // The inbox is not seeded locally any more. Everything it shows arrives
    // from the API, so an empty live state is the honest starting point.
    expect(state.live.conversations.status).toBe('idle');
    expect(state.live.unassigned.status).toBe('idle');
    expect(state.live.openConversationId).toBeNull();
    expect(state.live.realtime).toEqual({ status: 'idle' });
  });

  it('starts with the list drawer closed and the timeline at full width', () => {
    const state = createState(NOW);
    expect(state.listOpen).toBe(false);
    expect(state.listWidth).toBe(LIST_WIDTH_DEFAULT);
  });

  it('clamps the queue-list width into the supported range', () => {
    expect(clampListWidth(120)).toBe(LIST_WIDTH_MIN);
    expect(clampListWidth(999)).toBe(LIST_WIDTH_MAX);
    expect(clampListWidth(340.4)).toBe(340);
    expect(clampListWidth(Number.NaN)).toBe(LIST_WIDTH_DEFAULT);
  });
});

describe('currentActor', () => {
  it('keeps the identity and changes only the effective role', () => {
    const state = createState(NOW);
    const before = currentActor(state);
    state.role = 'agent';
    const after = currentActor(state);
    expect(after.memberId).toBe(before.memberId);
    expect(after.role).toBe('agent');
  });

  it('refuses to invent an actor when the seed has no such member', () => {
    const state = createState(NOW);
    state.dataset = { ...state.dataset, members: [] };
    // A placeholder here would render a workspace belonging to nobody, and
    // every permission decision on screen would be about that nobody.
    expect(() => currentActor(state)).toThrow(/has no member/);
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
    state.role = 'agent';
    state.inboxQueue = 'mine';
    expect(routeParamsFor(state)).toEqual({ lang: 'en', as: 'agent', queue: 'mine' });
  });

  it('does not encode the queue on another screen', () => {
    const state = createState(NOW);
    state.inboxQueue = 'mine';
    state.route = { ...state.route, screen: 'channels' };
    expect(routeParamsFor(state).queue).toBeUndefined();
  });

  it('reads the language, the role, the queue and the conversation back', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox/cv-4820?lang=en&as=agent&queue=mine'));
    expect(state.lang).toBe('en');
    expect(state.role).toBe('agent');
    expect(state.inboxQueue).toBe('mine');
    expect(state.route.conversationId).toBe('cv-4820');
  });

  it('falls back to the defaults for values it does not recognise', () => {
    const state = createState(NOW);
    applyRoute(state, parseHash('#/inbox?as=nope&queue=nope&lang=de'));
    expect(state.role).toBe('supervisor');
    expect(state.inboxQueue).toBe('unassigned');
    expect(state.lang).toBe('ar');
  });

  it('leaves the queue alone on a non-inbox route', () => {
    const state = createState(NOW);
    state.inboxQueue = 'mine';
    applyRoute(state, parseHash('#/channels'));
    expect(state.inboxQueue).toBe('mine');
  });

  it('round-trips every viewable role', () => {
    const state = createState(NOW);
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
