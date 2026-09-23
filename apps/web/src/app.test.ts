/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './api/client';
import type { AppHandle, Cancel, MountOptions } from './app';
import { boot, browserEventSource, browserScheduler, EXPORT_POLL_MS, mount, renderApp, workspaceOpen } from './app';
import type { PreferenceStore } from './preferences';
import { LANG_KEY, NAV_KEY, THEME_KEY } from './preferences';
import type { RouterHost } from './router';
import { createState } from './state';

/**
 * The composition root: the authentication boundary, the shell's layers and
 * focus, preferences, and the export follow-up. Only the network is replaced.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const ADMIN = [
  'conversation.read', 'conversation.unassigned.preview', 'conversation.reply', 'conversation.note', 'conversation.assign',
  'contact.read', 'channel.manage', 'member.manage', 'role.manage', 'campaign.read', 'campaign.draft', 'report.read',
];

const EMPTY_REPORT = {
  generated_at: NOW.toISOString(), fresh_through: NOW.toISOString(), timezone: 'UTC',
  filters: { from: null, to: null, channel: null, campaign_id: null },
  definitions: { campaigns: 0, executions: 0 }, audience: { denominator: 0, eligible: 0, excluded: 0 },
  current: { denominator: 0, planned: 0, queued: 0, in_flight: 0, accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, outcome_unknown: 0 },
  milestones: { denominator: 0, accepted: 0, delivered: 0, read: 0 },
  costs: [], channels: [], errors: [], trend: [], campaigns: [],
};

const SILENT_STREAM = (): { addEventListener: () => void; close: () => void } => ({ addEventListener: () => undefined, close: () => undefined });

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

type Route = Reply | (() => Reply | Promise<Reply>);

class FakeApi {
  readonly calls: { method: string; path: string }[] = [];
  private readonly routes = new Map<string, Route>();

  on(key: string, reply: Route): this {
    this.routes.set(key, reply);
    return this;
  }

  hold(key: string): (reply: Reply) => void {
    let release: (reply: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    this.routes.set(key, () => pending);
    return (reply) => {
      release(reply);
    };
  }

  called(prefix: string): boolean {
    return this.calls.some((call) => `${call.method} ${call.path}`.startsWith(prefix));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '');
    this.calls.push({ method, path });
    const route = this.routes.get(`${method} ${path}`) ?? this.routes.get(`${method} ${path.split('?')[0] as string}`);
    if (route === undefined) {
      // Anything unscripted answers as an empty list — or, for the report, an
      // empty report — so a screen can load without every test naming every
      // request.
      const body = path.split('?')[0]?.endsWith('/reports/campaigns') ? { data: EMPTY_REPORT } : { data: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const reply = await (typeof route === 'function' ? route() : route);
    return reply.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
}

const NO_SESSION: Reply = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in.' } } };

function membership(tenantId: string, name: string, permissions: readonly string[] = ADMIN): Record<string, unknown> {
  return { id: `m-${tenantId.slice(0, 4)}`, tenant: { id: tenantId, name, slug: name.toLowerCase() }, role: { id: 'r', key: 'admin', name: 'Admin' }, permissions };
}

function signedIn(api = new FakeApi(), memberships: readonly Record<string, unknown>[] = [membership(TENANT, 'Digital School')]): FakeApi {
  return api
    .on('GET /auth/session', { status: 200, body: { data: { user: { id: 'u', email: 'hana@school.example' } } } })
    .on('GET /me/memberships', { status: 200, body: { data: memberships } });
}

interface Host extends RouterHost {
  go(hash: string): void;
}

function createHost(hash = ''): Host {
  const listeners: (() => void)[] = [];
  let current = hash;
  const location = {
    get hash(): string {
      return current;
    },
    set hash(next: string) {
      if (next === current) return;
      current = next;
      listeners.forEach((listener) => listener());
    },
  };
  return {
    location,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    go: (next) => {
      location.hash = next;
    },
  };
}

function memoryStore(initial: Record<string, string> = {}): PreferenceStore & { readonly values: Record<string, string> } {
  const values = { ...initial };
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => { values[key] = value; } };
}

let handle: AppHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.useRealTimers();
});

function start(hash: string, api: FakeApi, options: Partial<MountOptions> = {}): { app: AppHandle; root: HTMLElement; host: Host } {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  const host = createHost(hash);
  const app = mount({ root, host, now: NOW, fetch: api.fetch, readCsrfToken: () => 'csrf', openEventSource: SILENT_STREAM, ...options });
  handle = app;
  return { app, root, host };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function click(target: Element | null, init: MouseEventInit = {}): void {
  if (target === null) throw new Error('nothing to click');
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function type(element: Element | null, value: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) throw new Error('not a field');
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function protectedContent(root: HTMLElement): readonly Element[] {
  return Array.from(root.querySelectorAll('nav, .nav, .header, .inbox, .page, [data-act="nav"]'));
}

/* ------------------------------------------------------------- the gate -- */

describe('the authentication boundary', () => {
  it('dispatches the notification bell through the durable notification action', async () => {
    const api = signedIn()
      .on(`GET /tenants/${TENANT}/notifications?limit=25`, {
        status: 200, body: { data: [], page: { next_cursor: null, has_more: false } },
      })
      .on(`GET /tenants/${TENANT}/notifications/unread-count`, { status: 200, body: { data: { count: 0 } } })
      .on(`GET /tenants/${TENANT}/notifications/push-config`, { status: 200, body: { data: { publicKey: null } } });
    const { app, root } = start('#/channels', api);
    await settle();
    app.dispatch('notification-toggle');
    await settle();
    expect(root.querySelector('#notification-menu')?.textContent).toContain('لا توجد إشعارات بعد');
    expect(api.called(`GET /tenants/${TENANT}/notifications?limit=25`)).toBe(true);
  });

  it('shows only the sign-in page at /#/inbox when there is no session', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { root, host } = start('#/inbox', api);
    await settle();
    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(protectedContent(root)).toEqual([]);
    expect(root.textContent).not.toContain('Digital School');
    expect(host.location.hash).toBe('#/inbox');
    // Nothing protected is even asked for.
    expect(api.calls.map((call) => call.path)).toEqual(['/auth/session']);
  });

  it('draws nothing protected while the session probe is still out', async () => {
    const api = signedIn();
    const release = api.hold('GET /auth/session');
    const { root } = start('#/channels', api);
    await settle();
    expect(root.querySelector('.app--pending')).not.toBeNull();
    expect(protectedContent(root)).toEqual([]);
    expect(root.textContent).not.toContain('Digital School');
    release({ status: 200, body: { data: { user: { id: 'u', email: 'hana@school.example' } } } });
    await settle();
    expect(root.querySelector('.nav')).not.toBeNull();
    expect(root.querySelector('.header__tenant')?.textContent).toBe('Digital School');
  });

  it('opens the screen that was asked for once the credentials are accepted', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION).on('POST /auth/login', { status: 200, body: { data: { user: { id: 'u', email: 'hana@school.example' } } } });
    const { root, app } = start('#/channels', api);
    await settle();
    signedIn(api);
    type(root.querySelector('#signin-email'), 'hana@school.example');
    type(root.querySelector('#signin-password'), 'correct horse');
    root.querySelector('form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(app.state.route.screen).toBe('channels');
    expect(root.querySelector('.nav__item[aria-current="page"]')?.getAttribute('data-arg')).toBe('channels');
    expect(api.called(`GET /tenants/${TENANT}/channels`)).toBe(true);
    expect(app.state.dialogForm['signinPassword']).toBeUndefined();
  });

  it('stays on the sign-in page when the credentials are refused', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION).on('POST /auth/login', { status: 401, body: { error: { code: 'invalid_credentials', message: 'No.' } } });
    const { root, app } = start('#/inbox', api);
    await settle();
    type(root.querySelector('#signin-email'), 'hana@school.example');
    type(root.querySelector('#signin-password'), 'wrong');
    click(root.querySelector('button[type="submit"]'));
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('البريد الإلكتروني أو كلمة المرور غير صحيحة');
    expect(protectedContent(root)).toEqual([]);
    expect(app.state.live.session.status).toBe('signed_out');
    // A refused sign-in is not an expired session.
    expect(root.textContent).not.toContain('انتهت جلستك');
  });

  it('checks the form in the operator’s language', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { root } = start('#/inbox', api);
    await settle();
    click(root.querySelector('button[type="submit"]'));
    await settle();
    expect(root.querySelector('#signin-email-error')?.textContent).toBe('أدخل بريدك الإلكتروني.');
    expect(root.querySelector('#signin-password-error')?.textContent).toBe('أدخل كلمة المرور.');
    expect(root.querySelector('#signin-email')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('checks the form before sending anything', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { root, app } = start('#/inbox', api);
    app.dispatch('lang', 'en');
    await settle();
    click(root.querySelector('button[type="submit"]'));
    await settle();
    expect(root.querySelector('#signin-email-error')?.textContent).toBe('Enter your email address.');
    expect(root.querySelector('#signin-password-error')?.textContent).toBe('Enter your password.');
    type(root.querySelector('#signin-email'), 'not-an-email');
    click(root.querySelector('button[type="submit"]'));
    await settle();
    expect(root.querySelector('#signin-email-error')?.textContent).toBe('Enter a valid email address.');
    expect(api.called('POST /auth/login')).toBe(false);
  });

  it('refuses a second submit while the first is in flight', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const release = api.hold('POST /auth/login');
    const { root, app } = start('#/inbox', api);
    await settle();
    type(root.querySelector('#signin-email'), 'hana@school.example');
    type(root.querySelector('#signin-password'), 'pw');
    app.dispatch('live-signin');
    app.dispatch('live-signin');
    release(NO_SESSION);
    await settle();
    expect(api.calls.filter((call) => call.path === '/auth/login')).toHaveLength(1);
  });

  it('signs out through the API and returns to the sign-in page, forgetting the thread', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const api = signedIn()
      .on('POST /auth/logout', { status: 204, body: null })
      .on(`GET /tenants/${TENANT}/conversations/${id}`, { status: 404, body: { error: { code: 'resource_not_found', message: 'No.' } } });
    const { root, app, host } = start(`#/inbox/${id}`, api);
    await settle();
    const before = app.state.live;
    click(root.querySelector('.user-button'));
    click(root.querySelector('#user-menu [data-act="live-signout"]'));
    api.on('GET /auth/session', NO_SESSION);
    await settle();
    expect(api.called('POST /auth/logout')).toBe(true);
    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(protectedContent(root)).toEqual([]);
    expect(app.state.live).not.toBe(before);
    expect(app.state.live.session).toEqual({ status: 'signed_out', error: null });
    expect(host.location.hash).toBe('#/inbox');
  });

  it('closes the workspace when a later request says the session has gone', async () => {
    const api = signedIn().on(`GET /tenants/${TENANT}/people`, NO_SESSION);
    const { root, app, host } = start('#/people', api);
    await settle();
    expect(protectedContent(root)).toEqual([]);
    expect(app.state.live.session).toMatchObject({ status: 'signed_out', expired: true });
    expect(root.textContent).toContain('انتهت جلستك');
    expect(app.state.live.people.status).toBe('idle');
    // The route is kept, so signing back in lands on the same screen.
    expect(host.location.hash).toBe('#/people');
  });

  it('treats a 401 on the gate itself as the ordinary signed-out answer', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { app } = start('#/inbox', api);
    await settle();
    expect(app.state.live.session).toEqual({ status: 'signed_out', error: null });
  });

  it('offers a retry when the probe could not be answered, and signs in from there', async () => {
    const api = new FakeApi().on('GET /auth/session', () => {
      throw new Error('offline');
    });
    const { root } = start('#/inbox', api);
    await settle();
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('[data-act="live-session-retry"]')).not.toBeNull();
    api.on('GET /auth/session', NO_SESSION);
    click(root.querySelector('[data-act="live-session-retry"]'));
    await settle();
    expect(root.querySelector('#signin-email')).not.toBeNull();
  });

  it('shows no workspace for a member of no company', async () => {
    const api = signedIn(new FakeApi(), []);
    const { root } = start('#/inbox', api);
    await settle();
    expect(root.textContent).toContain('لا توجد مساحة عمل نشطة');
    expect(protectedContent(root)).toEqual([]);
  });

  it('never offers a role switch, and ignores a role in the address', async () => {
    const api = signedIn(new FakeApi(), [membership(TENANT, 'Digital School', ['report.read'])]);
    const { root, app } = start('#/analytics?as=owner', api);
    await settle();
    expect(root.querySelector('[data-act="role"]')).toBeNull();
    expect(root.textContent).not.toContain('اعرض كـ');
    expect(Array.from(root.querySelectorAll('.nav__item')).map((item) => item.getAttribute('data-arg'))).toEqual(['analytics', 'settings']);
    expect(app.state.route.params['as']).toBeUndefined();
  });

  it('sends a membership to the first screen it can open, or Settings', async () => {
    const reports = signedIn(new FakeApi(), [membership(TENANT, 'Digital School', ['report.read'])]);
    const first = start('#/people', reports);
    await settle();
    expect(first.app.state.route.screen).toBe('analytics');
    expect(first.host.location.hash).toBe('#/analytics');
    first.app.destroy();

    const nothing = signedIn(new FakeApi(), [membership(TENANT, 'Digital School', [])]);
    const second = start('#/inbox', nothing);
    await settle();
    expect(second.app.state.route.screen).toBe('settings');
  });

  it('switches company from the header, carrying nothing across', async () => {
    const api = signedIn(new FakeApi(), [membership(TENANT, 'Digital School'), membership(OTHER_TENANT, 'Noor Retail')]);
    const { root, app } = start('#/people', api);
    await settle();
    expect(api.called(`GET /tenants/${TENANT}/people`)).toBe(true);
    const before = app.state.live;
    click(root.querySelector('.header__tenant--switch'));
    click(root.querySelector(`[data-act="live-tenant-switch"][data-arg="${OTHER_TENANT}"]`));
    await settle();
    expect(app.state.live).not.toBe(before);
    expect(api.called(`GET /tenants/${OTHER_TENANT}/people`)).toBe(true);
    expect(root.querySelector('.header__tenant')?.textContent).toContain('Noor Retail');
    // Choosing the company already open, or one not on the list, does nothing.
    const current = app.state.live;
    app.dispatch('live-tenant-switch', OTHER_TENANT);
    app.dispatch('live-tenant-switch', 'not-a-member');
    expect(app.state.live).toBe(current);
  });

  it('refuses a company switch before there is a session', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { app } = start('#/inbox', api);
    await settle();
    const live = app.state.live;
    app.dispatch('live-tenant-switch', OTHER_TENANT);
    expect(app.state.live).toBe(live);
  });
});

describe('workspaceOpen and renderApp', () => {
  it('open only for a confirmed session with a company', () => {
    const state = createState(NOW);
    expect(workspaceOpen(state)).toBe(false);
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    expect(workspaceOpen(state)).toBe(false);
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
    expect(workspaceOpen(state)).toBe(true);
  });

  it('adds the dialog and toast layers only inside an open workspace', () => {
    const state = createState(NOW);
    state.dialog = { kind: 'invite', arg: '' };
    state.toasts = [{ id: 't1', text: 'x', tone: 'danger' }];
    expect(renderApp(state).childNodes).toHaveLength(1);
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
    expect(renderApp(state).childNodes).toHaveLength(3);
    state.dialog = null;
    state.toasts = [];
    expect(renderApp(state).childNodes).toHaveLength(1);
  });

  it('renders public token routes before probing or opening a workspace', () => {
    const state = createState(NOW);
    state.lang = 'en';
    state.route = { screen: 'accept-invitation', conversationId: null, params: { token: 'a'.repeat(43) } };
    expect((renderApp(state).firstChild as HTMLElement).textContent).toContain('Accept invitation');
    state.route = { screen: 'reset-password', conversationId: null, params: {} };
    expect((renderApp(state).firstChild as HTMLElement).textContent).toContain('Recover access');
  });

  it('mounts both public routes without loading protected screen data', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    let publicApp = start(`#/accept-invitation?token=${'a'.repeat(43)}`, api);
    await settle();
    expect(publicApp.root.textContent).toContain('قبول الدعوة');
    publicApp.app.destroy(); handle = null;
    publicApp = start('#/reset-password', api);
    await settle();
    expect(publicApp.root.textContent).toContain('استعادة الوصول');
    expect(api.calls.some((call) => call.path.includes('/tenants/'))).toBe(false);
  });
});

/* -------------------------------------------------------------- the shell -- */

describe('screens and preferences', () => {
  it('draws each screen from its route', async () => {
    const api = signedIn();
    const { root, host } = start('#/settings', api);
    await settle();
    for (const [hash, selector] of [
      ['#/contacts', '.page--contacts'],
      ['#/channels', '.page--channels'],
      ['#/people', '.page--people'],
      ['#/broadcasts', '.page--campaigns'],
      ['#/analytics', '.page--analytics'],
      ['#/settings', '.page--settings'],
      ['#/inbox', '.inbox'],
    ] as const) {
      host.go(hash);
      await settle();
      expect(root.querySelector(selector), hash).not.toBeNull();
    }
  });

  it('applies stored visual preferences and retains language through an Automation deep link', async () => {
    const store = memoryStore({ [THEME_KEY]: 'dark', [NAV_KEY]: 'expanded', [LANG_KEY]: 'en' });
    const { root, app, host } = start('#/settings', signedIn(), { preferences: store });
    await settle();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(root.querySelector('.app')?.getAttribute('data-nav')).toBe('expanded');
    click(root.querySelector('.nav__toggle'));
    click(root.querySelector('.theme-toggle'));
    expect(store.values).toEqual({ [THEME_KEY]: 'light', [NAV_KEY]: 'collapsed', [LANG_KEY]: 'en' });
    expect(app.state.theme).toBe('light');

    // The draft route intentionally omits `lang`. It must retain the current
    // presentation preference rather than resetting to the app default.
    host.go('#/automations?view=mine&edit=0df0f076-256c-49a6-ad0c-3e797b29ea49');
    await settle();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('follows the system colour scheme on a first visit', async () => {
    const { app } = start('#/settings', signedIn(), { preferences: memoryStore(), prefersDark: () => true });
    await settle();
    expect(app.state.theme).toBe('dark');
    handle?.destroy();
    const light = start('#/settings', signedIn());
    await settle();
    expect(light.app.state.theme).toBe('light');
  });

  it('re-reads the report when back or forward changes its filters', async () => {
    const api = signedIn();
    const { host } = start('#/analytics', api);
    await settle();
    const before = api.calls.filter((call) => call.path.startsWith(`/tenants/${TENANT}/reports/campaigns`)).length;
    host.go('#/analytics?channel=whatsapp');
    await settle();
    const after = api.calls.filter((call) => call.path.startsWith(`/tenants/${TENANT}/reports/campaigns`));
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.path).toContain('channel=whatsapp');
  });

  it('loads automation data when the same-screen tab or draft route changes', async () => {
    const api = signedIn(new FakeApi(), [membership(TENANT, 'Digital School', [...ADMIN, 'automation.read'])]);
    const { host } = start('#/settings', api);
    await settle();
    host.go('#/automations?view=templates');
    await settle();
    expect(api.called(`GET /tenants/${TENANT}/automation-templates`)).toBe(true);

    host.go('#/automations?view=mine');
    await settle();
    expect(api.called(`GET /tenants/${TENANT}/automations`)).toBe(true);

    const beforeEdit = api.calls.filter((call) => call.path.startsWith(`/tenants/${TENANT}/automations?`)).length;
    host.go('#/automations?view=mine&edit=33333333-3333-4333-8333-333333333333');
    await settle();
    const afterEdit = api.calls.filter((call) => call.path.startsWith(`/tenants/${TENANT}/automations?`)).length;
    expect(afterEdit).toBe(beforeEdit + 1);
  });
});

describe('layers, focus and the keyboard', () => {
  it('traps Tab in the mobile Inbox filter popover', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { root, app } = start('#/inbox', signedIn());
    await settle();
    app.state.openMenu = 'inbox-filters';
    app.render();
    const popover = root.querySelector('[data-trap="mobile-inbox-filters"]') as HTMLElement;
    expect(popover).not.toBeNull();
    const stops = Array.from(popover.querySelectorAll<HTMLElement>('input, select, button:not([disabled])'));
    expect(stops.length).toBeGreaterThan(1);
    (stops.at(-1) as HTMLElement).focus();
    expect(press(root, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
  });

  it('opens the navigation drawer, keeps Tab inside it, and returns focus when Escape closes it', async () => {
    const { root, app } = start('#/settings', signedIn());
    await settle();
    const opener = root.querySelector('.header__menu') as HTMLElement;
    opener.focus();
    click(opener);
    expect(app.state.navOpen).toBe(true);
    const drawer = root.querySelector('[data-trap="nav"]') as HTMLElement;
    expect(drawer.contains(document.activeElement)).toBe(true);
    const stops = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    (stops.at(-1) as HTMLElement).focus();
    expect(press(root, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
    press(root, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(stops.at(-1));
    // A Tab that stays inside needs no help.
    (stops[1] as HTMLElement).focus();
    expect(press(root, 'Tab').defaultPrevented).toBe(false);

    // A control the stylesheet does not draw is not a stop: Tab wraps from the
    // last one that is drawn.
    const hiddenLast = stops.at(-1) as HTMLElement;
    const invisible = stops.at(-2) as HTMLElement;
    hiddenLast.style.display = 'none';
    invisible.style.visibility = 'hidden';
    (stops.at(-3) as HTMLElement).focus();
    expect(press(root, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);

    press(root, 'Escape');
    expect(app.state.navOpen).toBe(false);
    expect(document.activeElement?.classList.contains('header__menu')).toBe(true);
  });

  it('moves focus into a dialog, traps it, and gives it back to the control that opened it', async () => {
    const { root, app } = start('#/people', signedIn());
    await settle();
    const opener = root.querySelector('[data-act="dialog"][data-arg="invite"]') as HTMLElement;
    opener.focus();
    click(opener);
    const dialog = root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Focus outside the layer is pulled back in.
    (root.querySelector('.nav__item') as HTMLElement).focus();
    press(root, 'Tab');
    expect(dialog.contains(document.activeElement)).toBe(true);
    press(root, 'Escape');
    expect(app.state.dialog).toBeNull();
    expect(document.activeElement?.getAttribute('data-arg')).toBe('invite');
  });

  it('unwinds one layer at a time: dialog, menu, drawer, then the inbox drawers', async () => {
    const { root, app } = start('#/settings', signedIn());
    await settle();
    app.state.listOpen = true;
    app.state.panelDrawer = true;
    app.dispatch('nav-drawer');
    app.dispatch('dialog', 'invite');
    app.state.openMenu = 'user';
    press(root, 'Escape');
    expect(app.state.dialog).toBeNull();
    expect(app.state.openMenu).toBe('user');
    press(root, 'Escape');
    expect(app.state.openMenu).toBeNull();
    press(root, 'Escape');
    expect(app.state.navOpen).toBe(false);
    press(root, 'Escape');
    expect(app.state.listOpen).toBe(false);
    expect(app.state.panelDrawer).toBe(false);
    expect(press(root, 'Escape').defaultPrevented).toBe(false);
    expect(press(root, 'a').defaultPrevented).toBe(false);
  });

  it('walks a menu with the arrow keys and closes it on an outside click, not an inside one', async () => {
    const { root, app } = start('#/settings', signedIn());
    await settle();
    click(root.querySelector('.user-button'));
    const items = Array.from(root.querySelectorAll<HTMLElement>('#user-menu [role="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);
    press(root, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(root, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    press(root, 'ArrowUp');
    expect(document.activeElement).toBe(items[1]);
    press(root, 'Home');
    expect(document.activeElement).toBe(items[0]);
    press(root, 'End');
    expect(document.activeElement).toBe(items[1]);

    click(root.querySelector('#user-menu .menu__header'));
    expect(app.state.openMenu).toBe('user');
    click(root.querySelector('.page'));
    expect(app.state.openMenu).toBeNull();
    // With nothing open, an outside click is nothing at all.
    click(root.querySelector('.page'));
    expect(app.state.openMenu).toBeNull();
  });

  it('leaves a click on a form control to the control’s own input events', async () => {
    const { root, app } = start('#/inbox', new FakeApi().on('GET /auth/session', NO_SESSION));
    await settle();
    click(root.querySelector('#signin-email'));
    expect(app.state.dialogForm).toEqual({});
    app.destroy();
    const settings = start('#/settings', signedIn());
    await settle();
    click(settings.root.querySelector('select[data-act="lang"]'));
    // A select's action runs on change, never on the click that opens it.
    expect(settings.app.state.lang).toBe('ar');
  });

  it('pulls Shift+Tab back into a dialog from outside it, and leaves it alone in the middle', async () => {
    const { root, app } = start('#/people', signedIn());
    await settle();
    app.dispatch('dialog', 'invite');
    const dialog = root.querySelector('[data-trap]') as HTMLElement;
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>('input, select, button:not([disabled])'));
    (stops[1] as HTMLElement).focus();
    expect(press(root, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    (root.querySelector('.nav__item') as HTMLElement).focus();
    expect(press(root, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops.at(-1));
  });

  it('skips to the content', async () => {
    const { root } = start('#/settings', signedIn());
    await settle();
    click(root.querySelector('.skip-link'));
    expect(document.activeElement?.id).toBe('main');
  });

  it('leaves a navigation link opened in a new tab to the browser', async () => {
    const { root, app } = start('#/settings', signedIn());
    await settle();
    const link = root.querySelector('.nav__item[data-arg="people"]') as HTMLElement;
    click(link, { metaKey: true });
    expect(app.state.route.screen).toBe('settings');
    click(link);
    expect(app.state.route.screen).toBe('people');
  });

  it('closes a dialog from its scrim, but not from a click inside it', async () => {
    const { root, app } = start('#/people', signedIn());
    await settle();
    app.dispatch('dialog', 'invite');
    click(root.querySelector('.dialog__body'));
    expect(app.state.dialog).not.toBeNull();
    click(root.querySelector('.scrim'));
    expect(app.state.dialog).toBeNull();
  });

  it('moves focus where an action sent the operator, once', async () => {
    const api = signedIn().on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', disconnected_at: null, status: 'healthy', display_name: 'Line', external_asset_id: '1', provider_app_id: null, evidence: [], capabilities: { windowHours: null, outboundTypes: [], attachmentTypes: [], inboundEvents: [], templates: false, deliveryReceipts: false, readReceipts: false }, created_at: NOW.toISOString(), credential_held: true, last_error_code: null } ] } });
    const { root, app } = start('#/channels', api);
    await settle();
    app.dispatch('channel-manage', 'whatsapp:cn-1');
    expect(document.activeElement?.getAttribute('data-act')).toBe('connection-toggle');
    expect(app.state.focusTarget).toBeNull();
    app.state.focusTarget = '[data-connection="missing"] button';
    app.render();
    expect(app.state.focusTarget).toBeNull();
    expect(root.querySelector('.page')).not.toBeNull();
  });

  it('enables Send as a draft is typed, without redrawing the composer', async () => {
    const conversation = '55555555-5555-4555-8555-555555555555';
    const api = signedIn()
      .on(`GET /tenants/${TENANT}/conversations/${conversation}`, { status: 200, body: { data: { id: conversation, peerIdentity: '2010', channel: 'whatsapp', serviceWindow: { status: 'open', lastCustomerInboundAt: NOW.toISOString(), serviceWindowExpiresAt: new Date(NOW.getTime() + 86400000).toISOString() }, inboxLabel: 'Line', status: 'open', priority: 'normal', assigneeMembershipId: 'm-1111', version: 2, contactId: null, labels: [], customFields: [] } } })
      .on(`GET /tenants/${TENANT}/conversations/${conversation}/messages`, { status: 200, body: { data: { messages: [], next_cursor: null } } });
    const { root } = start(`#/inbox/${conversation}`, api, { openEventSource: () => ({ addEventListener: () => undefined, close: () => undefined }) });
    await settle();
    const input = root.querySelector('.composer__input') as HTMLTextAreaElement;
    const send = root.querySelector('[data-act="live-inbox-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(input, 'Hello');
    expect(root.querySelector('.composer__input')).toBe(input);
    expect(send.disabled).toBe(false);
    type(input, '   ');
    expect(send.disabled).toBe(true);
  });

  it('updates the template preview in place and resets the send idempotency key when a variable changes', async () => {
    const conversation = '55555555-5555-4555-8555-555555555555';
    const api = signedIn()
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', disconnected_at: null, status: 'healthy', display_name: 'Line', external_asset_id: '1', provider_app_id: null, evidence: [], capabilities: { windowHours: null, outboundTypes: [], attachmentTypes: [], inboundEvents: [], templates: true, deliveryReceipts: true, readReceipts: true }, created_at: NOW.toISOString(), credential_held: true, last_error_code: null }] } })
      .on(`GET /tenants/${TENANT}/conversations/${conversation}`, { status: 200, body: { data: { id: conversation, peerIdentity: '2010', connectionId: 'cn-1', channel: 'whatsapp', serviceWindow: { status: 'closed', lastCustomerInboundAt: NOW.toISOString(), serviceWindowExpiresAt: NOW.toISOString() }, inboxLabel: 'Line', status: 'open', priority: 'normal', assigneeMembershipId: 'm-1111', version: 2, contactId: null, labels: [], customFields: [] } } })
      .on(`GET /tenants/${TENANT}/conversations/${conversation}/messages`, { status: 200, body: { data: { messages: [], next_cursor: null } } })
      .on(`GET /tenants/${TENANT}/conversations/${conversation}/whatsapp-templates`, { status: 200, body: { data: [{ id: 'template-1', provider_template_id: 'meta-1', name: 'hello', language: 'en', category: 'utility', status: 'approved', components: [{ type: 'header', text: 'For {{1}}', format: 'TEXT', buttons: [] }, { type: 'body', text: 'Hello {{1}}', format: null, buttons: [] }], parameters: [{ key: 'header:1', component: 'header', index: null, position: 1, example: null }, { key: 'body:1', component: 'body', index: null, position: 1, example: null }], sendSupported: true, unsupportedReason: null, lastSyncedAt: NOW.toISOString() }], page: { next_cursor: null, has_more: false } } });
    const { root, app } = start(`#/inbox/${conversation}`, api, { openEventSource: SILENT_STREAM });
    await settle();
    click(root.querySelector('[data-act="live-whatsapp-template-open"]'));
    await settle();
    app.state.dialogForm.whatsappTemplateId = 'template-1';
    app.state.dialogForm.whatsappTemplateClientMessageId = 'old-key';
    app.render();
    const input = root.querySelector('[data-wa-parameter="body:1"]') as HTMLInputElement;
    type(input, 'Mona');
    expect(root.querySelector('[data-wa-parameter="body:1"]')).toBe(input);
    expect(root.querySelector('[data-template-preview-key="body:1"]')?.textContent).toBe('Mona');
    expect(app.state.dialogForm['whatsappTemplateClientMessageId']).toBeUndefined();
    type(input, '');
    expect(root.querySelector('[data-template-preview-key="body:1"]')?.textContent).toBe('{{1}}');
  });

  it('submits a form’s own action with its argument when Enter is pressed', async () => {
    const api = signedIn();
    const { root, app } = start('#/contacts', api);
    await settle();
    app.state.dialogForm = { contactQuery: 'Sara' };
    root.querySelector('form.searchbar')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(api.calls.some((call) => call.path === `/tenants/${TENANT}/contacts?q=Sara`)).toBe(true);
    // A form with no action of its own is left alone.
    const bare = document.createElement('form');
    root.appendChild(bare);
    bare.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
});

describe('focus restoration across a redraw', () => {
  it('keeps focus and caret on the control that had them', async () => {
    const { root, app } = start('#/contacts', signedIn());
    await settle();
    const search = root.querySelector('[data-form="contactQuery"]') as HTMLInputElement;
    type(search, 'Sara');
    search.focus();
    search.setSelectionRange(2, 3);
    app.render();
    const after = root.querySelector('[data-form="contactQuery"]') as HTMLInputElement;
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(2);
  });

  it('restores focus to a control found by id, and survives controls that cannot take a caret', async () => {
    const { root, app } = start('#/contacts', signedIn());
    await settle();
    (root.querySelector('#main') as HTMLElement).focus();
    app.render();
    expect(document.activeElement?.id).toBe('main');

    const search = root.querySelector('[data-form="contactQuery"]') as HTMLInputElement;
    search.focus();
    const original = HTMLInputElement.prototype.setSelectionRange;
    HTMLInputElement.prototype.setSelectionRange = () => {
      throw new Error('InvalidStateError');
    };
    try {
      expect(() => app.render()).not.toThrow();
    } finally {
      HTMLInputElement.prototype.setSelectionRange = original;
    }
  });

  it('ignores focus with no key, on an icon, or on a control that has gone', async () => {
    const { root, app } = start('#/contacts', signedIn());
    await settle();
    const zone = root.querySelector('.page__inner') as HTMLElement;
    zone.setAttribute('tabindex', '-1');
    zone.focus();
    app.render();
    const glyph = root.querySelector('svg');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => glyph });
    app.render();
    Reflect.deleteProperty(document, 'activeElement');
    const search = root.querySelector('[data-form="contactQuery"]') as HTMLInputElement;
    Object.defineProperty(search, 'selectionStart', { configurable: true, get: () => null });
    Object.defineProperty(search, 'selectionEnd', { configurable: true, get: () => null });
    search.focus();
    app.state.route = { screen: 'settings', conversationId: null, params: {} };
    app.render();
    expect(root.querySelector('.page--settings')).not.toBeNull();

    // Automations is the one screen the router reaches through its own branch;
    // without this the branch is never taken and the screen never rendered by
    // the app at all.
    app.state.route = { screen: 'automations', conversationId: null, params: {} };
    app.render();
    expect(root.textContent).not.toBe('');
  });
});

describe('the queue list column', () => {
  const conversation = '55555555-5555-4555-8555-555555555555';

  async function inbox(): Promise<{ app: AppHandle; root: HTMLElement }> {
    const started = start('#/inbox', signedIn(), { openEventSource: () => ({ addEventListener: () => undefined, close: () => undefined }) });
    await settle();
    return started;
  }

  function resizer(root: HTMLElement): HTMLElement {
    return root.querySelector('.list-resizer') as HTMLElement;
  }

  it('publishes its width to CSS and steps with the arrow keys, mirrored for RTL', async () => {
    const { app, root } = await inbox();
    app.dispatch('resize-list', '355');
    expect(root.querySelector('.inbox')?.getAttribute('style')).toContain('--list-width:355px');
    const width = app.state.listWidth;
    press(resizer(root), 'ArrowLeft');
    expect(app.state.listWidth).toBe(width + 8);
    press(resizer(root), 'ArrowRight');
    expect(app.state.listWidth).toBe(width);
    app.dispatch('lang', 'en');
    press(resizer(root), 'ArrowRight');
    expect(app.state.listWidth).toBe(width + 8);
    expect(conversation).toHaveLength(36);
  });

  it('drags from the column edge in both directions, and stops when the drag ends', async () => {
    const { app, root } = await inbox();
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function pinned(this: HTMLElement): DOMRect {
      if (!this.classList.contains('zone--list')) return original.call(this);
      return { left: 100, right: 436, top: 0, bottom: 0, width: 336, height: 0, x: 100, y: 0 } as DOMRect;
    };
    try {
      document.documentElement.setAttribute('dir', 'rtl');
      resizer(root).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 86 }));
      expect(app.state.listWidth).toBe(350);
      document.dispatchEvent(new PointerEvent('pointerup', {}));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 40 }));
      expect(app.state.listWidth).toBe(350);

      document.documentElement.setAttribute('dir', 'ltr');
      resizer(root).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 410 }));
      expect(app.state.listWidth).toBe(310);
      document.dispatchEvent(new PointerEvent('pointercancel', {}));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }));
      expect(app.state.listWidth).toBe(310);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('ignores a pointerdown off the separator, or on one outside a list column', async () => {
    const { app, root } = await inbox();
    const width = app.state.listWidth;
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const stray = document.createElement('button');
    stray.className = 'list-resizer';
    root.appendChild(stray);
    stray.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10 }));
    expect(app.state.listWidth).toBe(width);
  });

  it('dismisses the list drawer by its scrim and ignores input with no action', async () => {
    const { app, root } = await inbox();
    app.dispatch('list');
    click(root.querySelector('.zone-scrim--list'));
    expect(app.state.listOpen).toBe(false);
    root.dispatchEvent(new window.Event('input', { bubbles: true }));
    const field = document.createElement('input');
    root.appendChild(field);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    // A click on a select or a textarea is not a choice.
    const select = root.querySelector('select');
    if (select !== null) click(select);
    const note = document.createElement('textarea');
    note.setAttribute('data-act', 'live-note-draft');
    root.appendChild(note);
    click(note);
    expect(app.state.dialog).toBeNull();
  });
});

describe('following an export', () => {
  const EXPORT = { id: 'x-1', campaign_id: null, format: 'csv', row_count: null, error_code: null, requested_at: NOW.toISOString(), completed_at: null, expires_at: null, download_url: null };

  it('asks the server again while the export is still being prepared, and stops once it settles', async () => {
    const scheduled: { work: () => void; delay: number; cancelled: boolean }[] = [];
    const schedule = (work: () => void, delay: number): Cancel => {
      const entry = { work, delay, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const api = signedIn()
      .on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } })
      .on(`GET /tenants/${TENANT}/reports/campaigns/exports/x-1`, { status: 200, body: { data: { ...EXPORT, state: 'running' } } });
    const { app, root } = start('#/analytics', api, { schedule, newKey: () => 'k' });
    await settle();
    app.dispatch('live-report-export');
    await settle();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBe(EXPORT_POLL_MS);
    // A redraw while one follow-up is pending does not schedule another.
    app.dispatch('theme');
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.work();
    await settle();
    expect(root.querySelector('[data-export]')?.getAttribute('data-export')).toBe('running');
    expect(scheduled).toHaveLength(2);

    api.on(`GET /tenants/${TENANT}/reports/campaigns/exports/x-1`, { status: 200, body: { data: { ...EXPORT, state: 'completed', row_count: 3, download_url: '/d', expires_at: '2026-09-10T09:30:00.000Z' } } });
    scheduled[1]?.work();
    await settle();
    expect(root.querySelector('[data-export]')?.getAttribute('data-export')).toBe('completed');
    expect(scheduled).toHaveLength(2);
  });

  it('cancels a pending follow-up when the workspace closes or the app goes away', async () => {
    const cancelled: string[] = [];
    let count = 0;
    const schedule = (): Cancel => {
      count += 1;
      const id = String(count);
      return () => {
        cancelled.push(id);
      };
    };
    const api = signedIn()
      .on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } })
      .on('POST /auth/logout', { status: 204, body: null });
    const { app } = start('#/analytics', api, { schedule, newKey: () => 'k' });
    await settle();
    app.dispatch('live-report-export');
    await settle();
    app.dispatch('live-signout');
    await settle();
    expect(cancelled).toEqual(['1']);

    const again = start('#/analytics', signedIn().on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } }), { schedule, newKey: () => 'k' });
    await settle();
    again.app.dispatch('live-report-export');
    await settle();
    again.app.destroy();
    handle = null;
    expect(cancelled).toEqual(['1', '2']);
  });

  it('cancels the follow-up when a manual refresh finds the export already settled', async () => {
    const scheduled: { cancelled: boolean }[] = [];
    const schedule = (): Cancel => {
      const entry = { cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const api = signedIn()
      .on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } })
      .on(`GET /tenants/${TENANT}/reports/campaigns/exports/x-1`, { status: 200, body: { data: { ...EXPORT, state: 'failed', error_code: 'export_failed' } } });
    const { app } = start('#/analytics', api, { schedule, newKey: () => 'k' });
    await settle();
    app.dispatch('live-report-export');
    await settle();
    expect(scheduled).toEqual([{ cancelled: false }]);
    app.dispatch('live-report-export-refresh');
    await settle();
    expect(scheduled).toEqual([{ cancelled: true }]);
  });

  it('switching company cancels a follow-up too', async () => {
    const cancelled: number[] = [];
    const schedule = (): Cancel => () => {
      cancelled.push(1);
    };
    const api = signedIn(new FakeApi(), [membership(TENANT, 'A'), membership(OTHER_TENANT, 'B')])
      .on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } });
    const { app } = start('#/analytics', api, { schedule, newKey: () => 'k' });
    await settle();
    app.dispatch('live-report-export');
    await settle();
    app.dispatch('live-tenant-switch', OTHER_TENANT);
    await settle();
    expect(cancelled).toEqual([1]);
  });

  it('uses a cancellable timeout by default', () => {
    vi.useFakeTimers();
    const work = vi.fn();
    const cancel = browserScheduler(work, 10);
    cancel();
    vi.advanceTimersByTime(20);
    expect(work).not.toHaveBeenCalled();
    browserScheduler(work, 10);
    vi.advanceTimersByTime(20);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('polls with the default scheduler when none is injected', async () => {
    const api = signedIn()
      .on(`POST /tenants/${TENANT}/reports/campaigns/exports`, { status: 202, body: { data: { ...EXPORT, state: 'queued' } } });
    const { app } = start('#/analytics', api, { newKey: () => 'k' });
    await settle();
    app.dispatch('live-report-export');
    await settle();
    // The default is a real timer; destroying the app cancels it.
    app.destroy();
    handle = null;
    expect(app.state.live.campaignReportExport.status).toBe('ready');
  });
});

describe('boot', () => {
  it('finds the page’s mount node, or creates one, with the browser’s own services', async () => {
    const store = memoryStore({ [THEME_KEY]: 'dark' });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'x', message: 'x' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    try {
      document.body.replaceChildren();
      const existing = document.createElement('div');
      existing.id = 'app';
      document.body.appendChild(existing);
      document.cookie = 'convo_csrf=boot-token';
      const host = Object.assign(createHost(), {
        localStorage: store,
        matchMedia: () => ({ matches: false }),
      });
      handle = boot(document, host);
      await settle();
      expect(existing.querySelector('#signin-email')).not.toBeNull();
      expect(handle.state.theme).toBe('dark');
      expect(fetch).toHaveBeenCalledWith('/api/v1/auth/session', expect.objectContaining({ credentials: 'same-origin' }));

      // CSRF is read from the page's cookie on a state-changing request.
      handle.state.dialogForm = { signinEmail: 'a@b.co', signinPassword: 'pw' };
      handle.dispatch('live-signin');
      await settle();
      expect(fetch).toHaveBeenLastCalledWith('/api/v1/auth/login', expect.objectContaining({ headers: expect.objectContaining({ 'x-csrf-token': 'boot-token' }) }));
      handle.destroy();

      document.body.replaceChildren();
      handle = boot(document, Object.assign(createHost(), { matchMedia: () => ({ matches: true }) }));
      await settle();
      expect(document.getElementById('app')?.querySelector('#signin-email')).not.toBeNull();
      expect(handle.state.theme).toBe('dark');
      handle.destroy();
      handle = boot(document, createHost());
      expect(handle.state.theme).toBe('light');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('listens to the real page lifecycle, and lets go of it when destroyed', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'x', message: 'x' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    try {
      document.body.replaceChildren();
      handle = boot(document, createHost());
      await settle();
      expect(handle.state.offline).toBe(!window.navigator.onLine);
      window.dispatchEvent(new window.Event('offline'));
      expect(handle.state.offline).toBe(true);
      document.dispatchEvent(new window.Event('visibilitychange'));
      window.dispatchEvent(new window.Event('online'));
      expect(handle.state.offline).toBe(false);
      handle.destroy();
      window.dispatchEvent(new window.Event('offline'));
      expect(handle.state.offline).toBe(false);
      handle = null;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the browser chrome colour in step with the theme', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
    try {
      const { app } = start('#/inbox', new FakeApi().on('GET /auth/session', NO_SESSION));
      await settle();
      expect(meta.getAttribute('content')).toBe('#ffffff');
      app.state.theme = 'dark';
      app.render();
      expect(meta.getAttribute('content')).toBe('#0c182b');
    } finally {
      meta.remove();
    }
  });

  it('opens the inbox stream through the browser’s EventSource when none is injected', async () => {
    const opened: string[] = [];
    class FakeEventSource {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener(): void {
        return undefined;
      }
      close(): void {
        return undefined;
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    try {
      start('#/inbox', signedIn(), { openEventSource: undefined });
      await settle();
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`/tenants/${TENANT}/realtime`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the stream with credentials, because the session is a cookie', () => {
    const calls: { url: string; init: unknown }[] = [];
    class FakeEventSource {
      constructor(url: string, init: unknown) {
        calls.push({ url, init });
      }
    }
    const globals = globalThis as unknown as { EventSource?: unknown };
    const original = globals.EventSource;
    globals.EventSource = FakeEventSource;
    try {
      browserEventSource('/api/v1/tenants/t1/realtime/stream');
    } finally {
      globals.EventSource = original;
    }
    expect(calls).toEqual([{ url: '/api/v1/tenants/t1/realtime/stream', init: { withCredentials: true } }]);
  });

  it('stops listening after destroy, and a refresh after destroy draws nothing', async () => {
    const api = signedIn();
    const release = api.hold(`GET /tenants/${TENANT}/people`);
    const { app, root } = start('#/people', api);
    await settle();
    app.destroy();
    handle = null;
    const drawn = root.innerHTML;
    release({ status: 200, body: { data: [] } });
    await settle();
    expect(root.innerHTML).toBe(drawn);
    click(root.querySelector('.nav__item[data-arg="settings"]'));
    expect(app.state.route.screen).toBe('people');
  });

  it('answers every request as a network failure when no transport is given', async () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.appendChild(root);
    handle = mount({ root, host: createHost('#/inbox') });
    await settle();
    expect(root.querySelector('[data-act="live-session-retry"]')).not.toBeNull();
  });
});
