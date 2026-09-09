/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../api/client.js';
import { disconnectedApi } from '../api/people.js';
import type { AppHandle } from '../app.js';
import { boot, mount } from '../app.js';
import type { RouterHost } from '../router.js';

/**
 * The People screen driven through the real client, the real actions and the
 * real renderer — only the network is replaced.
 *
 * These assert the things a demo screen gets wrong: that a click shows pending
 * before the answer arrives, that a success is drawn only after the server
 * commits, that a refusal is reported in the operator's terms, and that the
 * screen re-reads the server rather than patching what it hoped for.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const AGENT_ROLE = '22222222-2222-4222-8222-222222222222';
const SUPERVISOR_ROLE = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

type Route = Reply | (() => Reply | Promise<Reply>);

/** A scripted API. Routes are keyed `"<METHOD> <path>"`, without the prefix. */
class FakeApi {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Route>();

  on(key: string, reply: Route): this {
    this.routes.set(key, reply);
    return this;
  }

  /** Holds every call to `key` open until the returned function is invoked. */
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

  readonly fetch: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '');
    this.calls.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: { ...(init.headers as Record<string, string>) },
    });
    const route = this.routes.get(`${method} ${path}`);
    if (route === undefined) {
      throw new Error(`the test did not script ${method} ${path}`);
    }
    const reply = await (typeof route === 'function' ? route() : route);
    return reply.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        });
  };
}

const SESSION: Reply = {
  status: 200,
  body: { data: { user: { id: 'u1', email: 'owner@digital-school.example' } } },
};

const NO_SESSION: Reply = {
  status: 401,
  body: { error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
};

function person(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    membership_id: MEMBERSHIP,
    email: 'hana@digital-school.example',
    status: 'active',
    role: { id: AGENT_ROLE, key: 'agent', name: 'Agent' },
    scopes: [],
    ...overrides,
  };
}

/** A signed-in workspace with one colleague, two roles and nothing else. */
function signedInApi(): FakeApi {
  return new FakeApi()
    .on('GET /auth/session', SESSION)
    .on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: 'own-membership',
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'owner-role', key: 'owner', name: 'Owner' },
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person()] } })
    .on(`GET /tenants/${TENANT}/roles`, {
      status: 200,
      body: {
        data: [
          { id: AGENT_ROLE, key: 'agent', name: 'Agent', is_builtin: true, grants: [] },
          {
            id: SUPERVISOR_ROLE,
            key: 'supervisor',
            name: 'Supervisor',
            is_builtin: true,
            grants: [{ permission_key: 'conversation.read', scope_level: 'scoped' }],
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/invitations`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/permissions`, {
      status: 200,
      body: {
        data: [
          { key: 'conversation.read', description: 'Read conversations.', delegable: true },
          { key: 'report.read', description: 'Read reports.', delegable: true },
          // Not delegable: it must never be offered as a grant to hand out.
          { key: 'tenant.delete', description: 'Delete the company.', delegable: false },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/ownership-transfers`, { status: 200, body: { data: [] } });
}

function createHost(hash = '#/people'): RouterHost {
  const listeners: (() => void)[] = [];
  let current = hash;
  return {
    location: {
      get hash(): string {
        return current;
      },
      set hash(next: string) {
        if (next === current) return;
        current = next;
        listeners.forEach((listener) => listener());
      },
    },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

let handle: AppHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.unstubAllGlobals();
});

function mountRoot(): HTMLElement {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return root;
}

/**
 * Mounts the workspace on the People route with a scripted server.
 *
 * The UI is switched to English so the assertions below read as the operator's
 * own words; the Arabic strings are the default and are asserted elsewhere.
 */
function start(api: FakeApi): { app: AppHandle; root: HTMLElement } {
  const root = mountRoot();
  let keys = 0;
  const app = mount({
    root,
    host: createHost(),
    now: NOW,
    fetch: api.fetch,
    readCsrfToken: () => 'csrf-token',
    newKey: () => `key-${String((keys += 1))}`,
  });
  handle = app;
  app.dispatch('lang', 'en');
  return { app, root };
}

/**
 * Lets in-flight requests settle. Timers, not microtasks: a response body is
 * parsed asynchronously, so a fixed number of `await Promise.resolve()` would
 * be a guess that changes with the runtime.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function find(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`no element for ${selector}`);
  return element;
}

function click(root: ParentNode, selector: string): void {
  find(root, selector).dispatchEvent(new window.Event('click', { bubbles: true }));
}

function type(root: ParentNode, selector: string, value: string): void {
  const element = find(root, selector);
  if (!(element instanceof window.HTMLInputElement)) throw new Error(`not an input: ${selector}`);
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function choose(root: ParentNode, selector: string, value: string, index = 0): void {
  const element = root.querySelectorAll(selector)[index];
  if (!(element instanceof window.HTMLSelectElement)) throw new Error(`not a select: ${selector}`);
  element.value = value;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function text(root: ParentNode): string {
  return root.textContent ?? '';
}

function isDisabled(root: ParentNode, selector: string): boolean {
  return (find(root, selector) as HTMLButtonElement).disabled;
}

/* ---------------------------------------------------------------- session -- */

describe('session', () => {
  it('offers a sign-in when the server says there is no session', async () => {
    const { root } = start(new FakeApi().on('GET /auth/session', NO_SESSION));
    await settle();

    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(text(root)).toContain('Sign in');
    // A 401 on the first probe is the normal starting state, not a failure to
    // report: nothing had been attempted yet.
    expect(root.querySelector('.banner--danger')).toBeNull();
  });

  it('repeats the server’s single refusal instead of guessing which field was wrong', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION).on('POST /auth/login', {
      status: 401,
      body: { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } },
    });
    const { app, root } = start(api);
    await settle();

    type(root, '#signin-email', 'owner@digital-school.example');
    type(root, '#signin-password', 'the wrong password');
    click(root, '[data-act="live-signin"]');
    await settle();

    expect(text(root)).toContain('Email or password is incorrect.');
    // The password is dropped from state whatever the answer was.
    expect(app.state.dialogForm['signinPassword']).toBeUndefined();
    expect((find(root, '#signin-password') as HTMLInputElement).value).toBe('');
  });

  it('loads the workspace once the credentials are accepted', async () => {
    const api = signedInApi().on('GET /auth/session', NO_SESSION).on('POST /auth/login', SESSION);
    const { root } = start(api);
    await settle();

    api.on('GET /auth/session', SESSION);
    type(root, '#signin-email', 'owner@digital-school.example');
    type(root, '#signin-password', 'the correct password');
    click(root, '[data-act="live-signin"]');
    await settle();

    expect(text(root)).toContain('hana@digital-school.example');
    expect(text(root)).toContain('owner@digital-school.example');
  });

  it('says so when the account belongs to no active company', async () => {
    const api = signedInApi().on('GET /me/memberships', { status: 200, body: { data: [] } });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('No active membership');
    // Nothing is fetched for a tenant that does not exist.
    expect(api.calls.some((call) => call.path.startsWith('/tenants/'))).toBe(false);
  });

  it('falls back to no tenant when the membership list itself is refused', async () => {
    const api = signedInApi().on('GET /me/memberships', {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'Denied.' } },
    });
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('No active membership');
  });

  it('reports a failed session probe rather than quietly calling it signed out', async () => {
    const api = new FakeApi().on('GET /auth/session', {
      status: 500,
      body: { error: { code: 'internal_error', message: 'The session store is down.' } },
    });
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('The session store is down.');
  });

  it('signs out, forgets every list, and shows the sign-in again', async () => {
    const api = signedInApi().on('POST /auth/logout', { status: 204, body: null });
    const { app, root } = start(api);
    await settle();
    expect(text(root)).toContain('hana@digital-school.example');

    click(root, '.workspace__intro [data-act="live-signout"]');
    await settle();

    expect(root.querySelector('#signin-email')).not.toBeNull();
    // Not merely hidden: the cached rows are dropped, so the next person at
    // this machine cannot read them.
    expect(app.state.live.people.status).toBe('error');
    expect(app.state.live.roles.status).toBe('error');
  });
});

/* -------------------------------------------------- loading and refusal -- */

describe('what the screen shows before and instead of an answer', () => {
  it('marks the lists busy until the slowest one lands', async () => {
    const api = signedInApi();
    const release = api.hold(`GET /tenants/${TENANT}/people`);
    const { root } = start(api);
    await settle();

    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();

    release({ status: 200, body: { data: [] } });
    await settle();
    expect(root.querySelector('[aria-busy="true"]')).toBeNull();
    expect(text(root)).toContain('Nobody here yet');
  });

  it('reports a refusal as a permission state, not as a missing section', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/people`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'Denied.' } },
    });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('You do not have permission for this');
    expect(text(root)).toContain('Hiding the control is not an authorization control');
  });

  it('treats a concealed non-membership the same way', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/roles`, {
      status: 404,
      body: { error: { code: 'resource_not_found', message: 'Not found.' } },
    });
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('You do not have permission for this');
  });

  it('offers a sign-in again when a list says the session has ended', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/teams`, NO_SESSION);
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('Your session ended');
  });

  it('separates an unreachable server from a rejection, and offers a retry', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/invitations`, () => {
      throw new Error('connection refused');
    });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('Could not reach the server');
    expect(text(root)).toContain('connection refused');
    expect(root.querySelector('[data-act="live-reload"]')).not.toBeNull();
  });

  it('quotes the request id so a rejection can be traced in the API log', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/ownership-transfers`, {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Something broke.', request_id: 'r-77' } },
    });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('The server rejected the request');
    expect(text(root)).toContain('Something broke. · r-77');
  });

  it('re-reads the session and every list on demand', async () => {
    const api = signedInApi();
    const { root } = start(api);
    await settle();
    const before = api.calls.length;

    click(root, '[data-act="live-reload"]');
    await settle();

    // The session, then the six lists the screen shows.
    expect(api.calls.length - before).toBe(8);
  });
});

/* -------------------------------------------------------------- mutations -- */

describe('mutations', () => {
  it('shows pending on the control, and toasts only once the server commits', async () => {
    const api = signedInApi();
    const release = api.hold(`POST /tenants/${TENANT}/invitations`);
    const { app, root } = start(api);
    await settle();

    type(root, '[data-form="inviteEmail"]', 'tarek@digital-school.example');
    choose(root, 'select[data-form="inviteRole"]', AGENT_ROLE);
    click(root, '[data-act="live-invite"]');
    await settle();

    expect(text(root)).toContain('Sending…');
    expect(isDisabled(root, '[data-act="live-invite"]')).toBe(true);
    // Nothing has been claimed while the request is still in the air.
    expect(app.state.toasts).toHaveLength(0);

    release({
      status: 201,
      body: {
        data: {
          id: 'inv-1',
          email: 'tarek@digital-school.example',
          status: 'pending',
          role: { id: AGENT_ROLE, key: 'agent', name: 'Agent' },
          created_at: NOW.toISOString(),
          expires_at: NOW.toISOString(),
          accepted_at: null,
          revoked_at: null,
          scopes: [],
        },
      },
    });
    await settle();

    expect(app.state.toasts.map((toast) => toast.text)).toEqual([
      'Invitation sent to tarek@digital-school.example',
    ]);
    // The field is cleared only after the server accepted it.
    expect((find(root, '[data-form="inviteEmail"]') as HTMLInputElement).value).toBe('');
  });

  it('carries CSRF, and one idempotency key per attempt', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 400,
      body: { error: { code: 'invalid_input', message: 'That is not an address.' } },
    });
    const { root } = start(api);
    await settle();

    type(root, '[data-form="inviteEmail"]', 'tarek@digital-school.example');
    click(root, '[data-act="live-invite"]');
    await settle();
    click(root, '[data-act="live-invite"]');
    await settle();

    const posts = api.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/invitations'),
    );
    expect(posts.map((call) => call.headers['x-csrf-token'])).toEqual(['csrf-token', 'csrf-token']);
    // A second attempt is a new attempt, so it gets a new key rather than
    // replaying the first one's stored response.
    expect(posts.map((call) => call.headers['idempotency-key'])).toEqual(['key-1', 'key-2']);
  });

  it('shows the server’s rejection beside the form, and claims nothing', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 403,
      body: {
        error: {
          code: 'delegation_ceiling',
          message: 'You cannot grant access wider than your own.',
          details: [{ field: 'tenant.delete', code: 'not_held', message: 'Exceeds your access.' }],
        },
      },
    });
    const { app, root } = start(api);
    await settle();

    type(root, '[data-form="inviteEmail"]', 'escalate@digital-school.example');
    click(root, '[data-act="live-invite"]');
    await settle();

    expect(text(root)).toContain('You cannot grant access wider than your own.');
    expect(text(root)).toContain('tenant.delete: Exceeds your access.');
    expect(app.state.toasts).toHaveLength(0);
    // What was typed survives, so the attempt can be corrected rather than
    // retyped.
    expect((find(root, '[data-form="inviteEmail"]') as HTMLInputElement).value).toBe(
      'escalate@digital-school.example',
    );
  });

  it('revokes a pending invitation, and offers nothing on a settled one', async () => {
    const invitation = {
      id: 'inv-9',
      email: 'tarek@digital-school.example',
      status: 'pending',
      role: { id: AGENT_ROLE, key: 'agent', name: 'Agent' },
      created_at: NOW.toISOString(),
      expires_at: NOW.toISOString(),
      accepted_at: null,
      revoked_at: null,
      scopes: [],
    };
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/invitations`, {
        status: 200,
        body: {
          data: [
            invitation,
            { ...invitation, id: 'inv-8', status: 'accepted', accepted_at: NOW.toISOString() },
          ],
        },
      })
      .on(`DELETE /tenants/${TENANT}/invitations/inv-9`, { status: 204, body: null });
    const { app, root } = start(api);
    await settle();

    expect(root.querySelectorAll('[data-act="live-revoke-invite"]')).toHaveLength(1);

    click(root, '[data-act="live-revoke-invite"]');
    await settle();
    expect(app.state.toasts.map((toast) => toast.text)).toEqual(['Invitation revoked']);
  });

  it('re-reads the server after a change rather than patching local state', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: {
        data: person({ role: { id: SUPERVISOR_ROLE, key: 'supervisor', name: 'Supervisor' } }),
      },
    });
    const { root } = start(api);
    await settle();

    // The reload after the change reports a scope the browser never asked for.
    api.on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: {
        data: [
          person({
            role: { id: SUPERVISOR_ROLE, key: 'supervisor', name: 'Supervisor' },
            scopes: [{ type: 'tenant', id: null }],
          }),
        ],
      },
    });

    choose(root, `select[data-form="${MEMBERSHIP}"]`, SUPERVISOR_ROLE);
    await settle();

    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      roleId: SUPERVISOR_ROLE,
    });
    expect(text(root)).toContain('Whole company');
  });

  it('changes a status and grants the whole-company scope', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ status: 'suspended' }) },
    });
    const { app, root } = start(api);
    await settle();

    choose(root, `select[data-form="${MEMBERSHIP}"]`, 'suspended', 1);
    await settle();
    const patches = api.calls.filter((call) => call.method === 'PATCH');
    expect(patches.at(-1)?.body).toEqual({ status: 'suspended' });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Status is now suspended');

    click(root, '[data-act="live-scope-tenant"]');
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({
      scopes: [{ type: 'tenant', id: null }],
    });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Scopes updated');
  });

  it('offers only the delegable keys the server lists, and refuses to guess', async () => {
    const { root } = start(signedInApi());
    await settle();

    const grant = find(root, 'select[data-form="roleGrant"]') as HTMLSelectElement;
    expect([...grant.options].map((option) => option.value)).toEqual([
      '',
      'conversation.read',
      'report.read',
    ]);
    // Nothing is preselected and the control is refused until both halves of
    // the grant have actually been chosen.
    expect(grant.value).toBe('');
    expect(isDisabled(root, '[data-act="live-create-role"]')).toBe(true);

    choose(root, 'select[data-form="roleGrant"]', 'report.read');
    expect(isDisabled(root, '[data-act="live-create-role"]')).toBe(true);
    choose(root, 'select[data-form="roleScope"]', 'tenant');
    expect(isDisabled(root, '[data-act="live-create-role"]')).toBe(false);
  });

  it('reports a refused permission catalogue instead of an empty select', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/permissions`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'Denied.' } },
    });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('You do not have permission for this');
    expect((find(root, 'select[data-form="roleGrant"]') as HTMLSelectElement).disabled).toBe(true);
    expect(isDisabled(root, '[data-act="live-create-role"]')).toBe(true);
  });

  it('creates a custom role from the chosen key and scope, renames it, and deletes it', async () => {
    const custom = { id: 'r-new', key: 'custom_lead', name: 'Lead', is_builtin: false, grants: [] };
    const api = signedInApi()
      .on(`POST /tenants/${TENANT}/roles`, { status: 201, body: { data: custom } })
      .on(`PATCH /tenants/${TENANT}/roles/r-new`, {
        status: 200,
        body: { data: { ...custom, name: 'Enrollment lead' } },
      })
      .on(`DELETE /tenants/${TENANT}/roles/r-new`, { status: 204, body: null });
    const { app, root } = start(api);
    await settle();

    type(root, '[data-form="roleName"]', 'Lead');
    choose(root, 'select[data-form="roleGrant"]', 'report.read');
    choose(root, 'select[data-form="roleScope"]', 'tenant');

    api.on(`GET /tenants/${TENANT}/roles`, {
      status: 200,
      body: {
        data: [
          {
            id: AGENT_ROLE,
            key: 'agent',
            name: 'Agent',
            is_builtin: true,
            grants: [{ permission_key: 'conversation.read', scope_level: 'scoped' }],
          },
          { ...custom, grants: [{ permission_key: 'report.read', scope_level: 'tenant' }] },
        ],
      },
    });
    click(root, '[data-act="live-create-role"]');
    await settle();

    expect(
      api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/roles'))?.body,
    ).toEqual({
      name: 'Lead',
      description: '',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Created the role Lead');

    // Only the custom role offers a rename and a delete; a built-in one shows
    // its badge, because the database refuses to change it at all.
    expect(root.querySelectorAll('[data-act="live-delete-role"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-act="live-rename-role"]')).toHaveLength(1);
    expect(isDisabled(root, '[data-act="live-rename-role"]')).toBe(true);

    type(root, '[data-form="roleName_r-new"]', 'Enrollment lead');
    click(root, '[data-act="live-rename-role"]');
    await settle();
    // The rename resends the grants the *server* reported, so a rename cannot
    // quietly widen what the role can do.
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Enrollment lead',
      description: '',
      grants: [{ permission: 'report.read', scope: 'tenant' }],
    });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Renamed to Enrollment lead');

    click(root, '[data-act="live-delete-role"]');
    await settle();
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Role deleted');
  });

  it('ignores a rename aimed at a role the server never sent', async () => {
    const { app } = start(signedInApi());
    await settle();
    app.dispatch('live-rename-role', 'r-unknown');
    await settle();
    expect(app.state.toasts).toHaveLength(0);
  });

  it('creates a team, adds and removes a member, then archives and restores it', async () => {
    const empty = {
      id: 'team-1',
      name: 'Enrollment',
      member_count: 0,
      archived: false,
      members: [],
    };
    const filled = {
      ...empty,
      member_count: 1,
      members: [{ membership_id: MEMBERSHIP, email: 'hana@digital-school.example' }],
    };
    const api = signedInApi()
      .on(`POST /tenants/${TENANT}/teams`, { status: 201, body: { data: empty } })
      .on(`POST /tenants/${TENANT}/teams/team-1/members`, { status: 200, body: { data: filled } })
      .on(`DELETE /tenants/${TENANT}/teams/team-1/members/${MEMBERSHIP}`, {
        status: 200,
        body: { data: empty },
      })
      .on(`PATCH /tenants/${TENANT}/teams/team-1`, {
        status: 200,
        body: { data: { ...empty, archived: true } },
      });
    const { app, root } = start(api);
    await settle();

    type(root, '[data-form="teamName"]', 'Enrollment');
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty] } });
    click(root, '[data-act="live-create-team"]');
    await settle();
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Created the team Enrollment');
    expect(text(root)).toContain('No members yet');

    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [filled] } });
    choose(root, 'select[data-form="teamMember_team-1"]', MEMBERSHIP);
    click(root, '[data-act="live-team-add"]');
    await settle();
    expect(api.calls.find((call) => call.path.endsWith('/members'))?.body).toEqual({
      membershipId: MEMBERSHIP,
    });
    // The card names who is in the team, and does not offer to add them twice.
    expect(find(root, '.memberlist').textContent).toContain('hana@digital-school.example');
    expect(
      (find(root, 'select[data-form="teamMember_team-1"]') as HTMLSelectElement).disabled,
    ).toBe(true);

    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty] } });
    click(root, '[data-act="live-remove-member"]');
    await settle();
    expect(api.calls.some((call) => call.method === 'DELETE' && call.path.endsWith(MEMBERSHIP))).toBe(
      true,
    );
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Removed from the team');

    api.on(`GET /tenants/${TENANT}/teams`, {
      status: 200,
      body: { data: [{ ...empty, archived: true }] },
    });
    click(root, '[data-act="live-archive-team"]');
    await settle();
    // Archiving sends only what it changes — no echoed name to rename the team
    // by accident.
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ archived: true });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Team archived');
    expect(text(root)).toContain('Archived');
    // An archived team takes no new members, and the server refuses it too.
    expect(isDisabled(root, '[data-act="live-team-add"]')).toBe(true);

    api.on(`PATCH /tenants/${TENANT}/teams/team-1`, { status: 200, body: { data: empty } });
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty] } });
    click(root, '[data-act="live-archive-team"]');
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({
      archived: false,
    });
    expect(app.state.toasts.map((toast) => toast.text)).toContain('Team restored');
  });

  it('offers ownership and settles the offer three ways', async () => {
    const transfer = {
      id: 'tr-1',
      status: 'pending',
      from_membership: 'own-membership',
      to_membership: MEMBERSHIP,
      created_at: NOW.toISOString(),
      expires_at: NOW.toISOString(),
      settled_at: null,
    };
    const settled = { ...transfer, settled_at: NOW.toISOString() };
    const api = signedInApi()
      .on(`POST /tenants/${TENANT}/ownership-transfers`, { status: 201, body: { data: transfer } })
      .on(`POST /tenants/${TENANT}/ownership-transfers/tr-1/accept`, {
        status: 200,
        body: { data: { ...settled, status: 'accepted' } },
      })
      .on(`POST /tenants/${TENANT}/ownership-transfers/tr-1/decline`, {
        status: 200,
        body: { data: { ...settled, status: 'declined' } },
      })
      .on(`DELETE /tenants/${TENANT}/ownership-transfers/tr-1`, { status: 204, body: null });
    const { app, root } = start(api);
    await settle();

    api.on(`GET /tenants/${TENANT}/ownership-transfers`, {
      status: 200,
      body: { data: [transfer] },
    });
    click(root, '[data-act="live-offer-ownership"]');
    await settle();

    click(root, '[data-arg="tr-1:decline"]');
    await settle();
    click(root, '[data-arg="tr-1:cancel"]');
    await settle();
    click(root, '[data-arg="tr-1:accept"]');
    await settle();

    // The toast stack keeps the last three; the offer itself has scrolled off.
    expect(app.state.toasts.map((toast) => toast.text)).toEqual([
      'Ownership offer declined',
      'Ownership offer cancelled',
      'Ownership transferred',
    ]);
  });

  it('ignores an ownership decision it does not recognise', async () => {
    const { app } = start(signedInApi());
    await settle();
    app.dispatch('live-ownership', 'tr-1:destroy');
    await settle();
    expect(app.state.toasts).toHaveLength(0);
  });

  it('shows a settled offer’s outcome and no decision buttons', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/ownership-transfers`, {
      status: 200,
      body: {
        data: [
          {
            id: 'tr-old',
            status: 'accepted',
            from_membership: 'own-membership',
            to_membership: MEMBERSHIP,
            created_at: NOW.toISOString(),
            expires_at: NOW.toISOString(),
            settled_at: NOW.toISOString(),
          },
        ],
      },
    });
    const { root } = start(api);
    await settle();

    expect(text(root)).toContain('Ownership offer · accepted');
    expect(root.querySelector('[data-act="live-ownership"]')).toBeNull();
  });
});

/* ------------------------------------------------------- what is rendered -- */

describe('rendering the rows the server sent', () => {
  it('names a scope that is not the whole company by its own type', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: {
        data: [
          person({
            scopes: [
              { type: 'tenant', id: null },
              { type: 'team', id: 'team-1' },
            ],
          }),
        ],
      },
    });
    const { root } = start(api);
    await settle();

    const scopes = find(root, `tr[data-membership="${MEMBERSHIP}"] .labelset`).textContent ?? '';
    expect(scopes).toContain('Whole company');
    expect(scopes).toContain('team');
  });

  it('distinguishes a revoked invitation from an accepted one', async () => {
    const base = {
      email: 'gone@digital-school.example',
      role: { id: AGENT_ROLE, key: 'agent', name: 'Agent' },
      created_at: NOW.toISOString(),
      expires_at: NOW.toISOString(),
      accepted_at: null,
      revoked_at: null,
      scopes: [],
    };
    const api = signedInApi().on(`GET /tenants/${TENANT}/invitations`, {
      status: 200,
      body: {
        data: [
          { ...base, id: 'inv-r', status: 'revoked', revoked_at: NOW.toISOString() },
          { ...base, id: 'inv-a', status: 'accepted', accepted_at: NOW.toISOString() },
        ],
      },
    });
    const { root } = start(api);
    await settle();

    expect(find(root, '.pill--neutral').textContent).toContain('revoked');
    expect(find(root, '.pill--success').textContent).toContain('accepted');
    // Neither offers a revoke: there is nothing left to withdraw.
    expect(root.querySelector('[data-act="live-revoke-invite"]')).toBeNull();
  });

  it('speaks Arabic by default, which is the workspace’s own language', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/teams`, {
      status: 201,
      body: {
        data: { id: 'team-1', name: 'القبول', member_count: 0, archived: false, members: [] },
      },
    });
    const root = mountRoot();
    // Deliberately not switched to English, unlike every test above.
    const app = mount({
      root,
      host: createHost(),
      now: NOW,
      fetch: api.fetch,
      readCsrfToken: () => 'csrf-token',
      newKey: () => 'key-1',
    });
    handle = app;
    await settle();

    expect(text(root)).toContain('الأفراد والأدوار');
    type(root, '[data-form="teamName"]', 'القبول');
    click(root, '[data-act="live-create-team"]');
    await settle();
    expect(app.state.toasts.map((toast) => toast.text)).toEqual(['أُنشئ الفريق القبول']);
  });
});

/* ------------------------------------------------------------- transports -- */

describe('the transport the browser actually gets', () => {
  it('makes no request at all while a demo screen is showing', async () => {
    const api = signedInApi();
    handle = mount({
      root: mountRoot(),
      host: createHost('#/inbox'),
      now: NOW,
      fetch: api.fetch,
      readCsrfToken: () => 'csrf-token',
    });
    await settle();
    // The inbox is still demo-backed. A workspace that never opens People must
    // never call the API.
    expect(api.calls).toEqual([]);
  });

  it('sends no CSRF header and still mints a key when neither is injected', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 400,
      body: { error: { code: 'invalid_input', message: 'no' } },
    });
    const root = mountRoot();
    handle = mount({ root, host: createHost(), now: NOW, fetch: api.fetch });
    handle.dispatch('lang', 'en');
    await settle();

    type(root, '[data-form="inviteEmail"]', 'tarek@digital-school.example');
    click(root, '[data-act="live-invite"]');
    await settle();

    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.headers['x-csrf-token']).toBeUndefined();
    // A key is still sent — the API refuses a keyless mutation — it is just
    // not the deterministic one the other tests inject.
    expect(post?.headers['idempotency-key']).toMatch(/^\d+-\d+$/);
  });

  it('reports a network failure when no transport is configured at all', async () => {
    const root = mountRoot();
    handle = mount({ root, host: createHost(), now: NOW });
    handle.dispatch('lang', 'en');
    await settle();
    expect(text(root)).toContain('No HTTP transport is configured.');
  });

  it('answers every call on the disconnected api the same way', async () => {
    const api = disconnectedApi();
    // A read and a mutation: the mutation also proves it has no CSRF token to
    // send, rather than inventing one for a server that is not there.
    for (const result of [await api.session(), await api.logout()]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('network');
      expect(result.error.message).toBe('No HTTP transport is configured.');
    }
  });

  it('sends nothing at all when there is no tenant to send it to', async () => {
    const api = new FakeApi().on('GET /auth/session', NO_SESSION);
    const { app } = start(api);
    await settle();
    const before = api.calls.length;

    // A control that reaches the server is never rendered while signed out, so
    // this is the stale-click case: it must resolve to nothing, not to a
    // request against an undefined tenant.
    app.dispatch('live-create-team');
    await settle();
    expect(api.calls.length).toBe(before);
    expect(app.state.toasts).toHaveLength(0);
  });

  it('boot reaches the page’s own fetch and CSRF cookie', async () => {
    document.body.replaceChildren();
    document.cookie = 'convo_csrf=cookie-token';
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 400,
      body: { error: { code: 'invalid_input', message: 'no' } },
    });
    vi.stubGlobal('fetch', (input: string, init: RequestInit) => api.fetch(input, init));

    handle = boot(document, createHost());
    handle.dispatch('lang', 'en');
    await settle();

    const root = find(document, '#app');
    type(root, '[data-form="inviteEmail"]', 'tarek@digital-school.example');
    click(root, '[data-act="live-invite"]');
    await settle();

    expect(api.calls.find((call) => call.method === 'POST')?.headers['x-csrf-token']).toBe(
      'cookie-token',
    );
  });
});
