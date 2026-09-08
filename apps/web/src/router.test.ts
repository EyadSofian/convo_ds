import { describe, expect, it, vi } from 'vitest';
import type { Route, RouterHost } from './router';
import {
  DEFAULT_ROUTE,
  formatHash,
  onRouteChange,
  parseHash,
  readRoute,
  SCREENS,
  writeRoute,
} from './router';

function createHost(hash = ''): RouterHost & { fire(): void; listeners: number } {
  const listeners: (() => void)[] = [];
  return {
    location: { hash },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    fire: () => listeners.forEach((listener) => listener()),
    get listeners() {
      return listeners.length;
    },
  };
}

describe('parseHash', () => {
  it('defaults to the inbox for an empty or unknown screen', () => {
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/nowhere').screen).toBe('inbox');
    expect(parseHash('#').screen).toBe('inbox');
  });

  it('parses every known screen', () => {
    for (const screen of SCREENS) expect(parseHash(`#/${screen}`).screen).toBe(screen);
  });

  it('reads a conversation id only on the inbox route', () => {
    expect(parseHash('#/inbox/cv-4821').conversationId).toBe('cv-4821');
    expect(parseHash('#/settings/cv-4821').conversationId).toBeNull();
  });

  it('decodes query parameters, bare keys and plus-encoded spaces', () => {
    const route = parseHash('#/inbox?queue=unread&q=%D8%B4%D8%AD%D9%86+%D9%85%D8%AA%D8%A3%D8%AE%D8%B1&flag');
    expect(route.params.queue).toBe('unread');
    expect(route.params.q).toBe('شحن متأخر');
    expect(route.params.flag).toBe('');
  });

  it('tolerates a missing leading hash and stray separators', () => {
    expect(parseHash('/people').screen).toBe('people');
    expect(parseHash('#/inbox?&&').params).toEqual({});
  });
});

describe('formatHash', () => {
  it('round-trips a route', () => {
    const route: Route = {
      screen: 'inbox',
      conversationId: 'cv-4821',
      params: { queue: 'mine', q: 'شحن' },
    };
    const parsed = parseHash(formatHash(route));
    expect(parsed).toEqual(route);
  });

  it('omits an empty parameter value and the conversation on other screens', () => {
    expect(formatHash({ screen: 'inbox', conversationId: null, params: { q: '' } })).toBe('#/inbox');
    expect(formatHash({ screen: 'people', conversationId: 'cv-1', params: {} })).toBe('#/people');
  });
});

describe('host integration', () => {
  it('reads the current route from the host', () => {
    expect(readRoute(createHost('#/analytics')).screen).toBe('analytics');
  });

  it('writes only when the hash actually changes', () => {
    const host = createHost('#/inbox');
    expect(writeRoute(host, { screen: 'inbox', conversationId: null, params: {} })).toBe(false);
    expect(writeRoute(host, { screen: 'people', conversationId: null, params: {} })).toBe(true);
    expect(host.location.hash).toBe('#/people');
  });

  it('subscribes and unsubscribes from hash changes', () => {
    const host = createHost('#/inbox');
    const handler = vi.fn();
    const stop = onRouteChange(host, handler);
    expect(host.listeners).toBe(1);
    host.location.hash = '#/channels';
    host.fire();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ screen: 'channels' }));
    stop();
    expect(host.listeners).toBe(0);
  });
});
