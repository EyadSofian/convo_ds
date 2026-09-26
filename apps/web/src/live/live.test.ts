/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../api/client.js';
import { disconnectedApi } from '../api/people.js';
import type { AppHandle } from '../app.js';
import { boot, browserPageLifecycle, mount } from '../app.js';
import type { RouterHost } from '../router.js';

/**
 * The People and Channels screens driven through the real client, the real
 * actions and the real renderer — only the network is replaced.
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

/** What the server grants an Owner that these screens care about. */
const OWNER_PERMISSIONS = [
  'conversation.read',
  'contact.read',
  'channel.manage',
  'member.manage',
  'role.manage',
  'campaign.read',
  'report.read',
];

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

function invitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv-1',
    email: 'tarek@digital-school.example',
    status: 'pending',
    role: { id: AGENT_ROLE, key: 'agent', name: 'Agent' },
    created_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
    accepted_at: null,
    revoked_at: null,
    scopes: [],
    ...overrides,
  };
}

/** A signed-in Owner with one colleague, two roles and nothing else. */
function signedInApi(): FakeApi {
  return new FakeApi()
    .on('GET /auth/session', SESSION)
    .on(`GET /tenants/${TENANT}/notifications?limit=25`, { status: 200, body: { data: [], page: { next_cursor: null, has_more: false } } })
    .on(`GET /tenants/${TENANT}/notifications/unread-count`, { status: 200, body: { data: { count: 0 } } })
    .on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: 'own-membership',
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'owner-role', key: 'owner', name: 'Owner' },
            permissions: OWNER_PERMISSIONS,
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person()] } })
    .on(`GET /tenants/${TENANT}/roles`, {
      status: 200,
      body: {
        data: [
          { id: AGENT_ROLE, key: 'agent', name: 'Agent', is_builtin: true, description: '', updated_at: NOW.toISOString(), grants: [] },
          {
            id: SUPERVISOR_ROLE,
            key: 'supervisor',
            name: 'Supervisor',
            is_builtin: true,
            description: '',
            updated_at: NOW.toISOString(),
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
          // Delegable, but this Owner fixture does not hold it.
          { key: 'contact.export', description: 'Export contacts.', delegable: true },
          // Not delegable: it must never be offered as a grant to hand out.
          { key: 'tenant.delete', description: 'Delete the company.', delegable: false },
          // A key this build has no label or module for.
          { key: 'future.thing', description: 'Something newer.', delegable: true },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/ownership-transfers`, { status: 200, body: { data: [] } });
}

const WHATSAPP_MATRIX = {
  kind: 'whatsapp',
  version: 'v21.0',
  host: 'graph.facebook.com',
  inboundEvents: ['messages', 'statuses'],
  outboundTypes: ['text', 'template'],
  attachmentTypes: ['image'],
  textLimit: { characters: 4096, bytes: 4096 },
  windowHours: 24,
  businessInitiated: true,
  templates: true,
  deliveryReceipts: true,
  readReceipts: true,
};

const WEB_CHAT_MATRIX = {
  ...WHATSAPP_MATRIX,
  kind: 'web_chat',
  host: 'self',
  attachmentTypes: [],
  windowHours: null,
  templates: false,
};

function channelDelivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cn-1',
    kind: 'whatsapp',
    provider: 'meta',
    display_name: 'Enrollment line',
    external_asset_id: 'phone-1',
    provider_app_id: '100000000000001',
    status: 'authorization_needed',
    capabilities: WHATSAPP_MATRIX,
    evidence: [
      { kind: 'asset_verified', satisfied: true, observed_at: NOW.toISOString() },
      { kind: 'credential_verified', satisfied: false, observed_at: null },
      { kind: 'webhook_subscribed', satisfied: false, observed_at: null },
      { kind: 'first_inbound', satisfied: false, observed_at: null },
      { kind: 'first_outbound', satisfied: false, observed_at: null },
    ],
    missing_evidence: ['credential_verified', 'webhook_subscribed', 'first_inbound', 'first_outbound'],
    last_error_code: null,
    last_error_at: null,
    created_at: NOW.toISOString(),
    disconnected_at: null,
    credential_held: true,
    credential_fingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

/** The Owner's workspace, plus the channel reads. */
function channelApi(): FakeApi {
  return signedInApi()
    .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [channelDelivery()] } })
    .on(`GET /tenants/${TENANT}/channels/cn-1/test-recipients`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/channels/cn-2/test-recipients`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/channels/catalogue`, {
      status: 200,
      body: {
        data: [
          { kind: 'whatsapp', provider: 'meta', implemented: true, capabilities: WHATSAPP_MATRIX },
          { kind: 'web_chat', provider: 'web_chat', implemented: true, capabilities: WEB_CHAT_MATRIX },
          {
            kind: 'instagram',
            provider: 'meta',
            implemented: false,
            capabilities: { ...WHATSAPP_MATRIX, kind: 'instagram' },
          },
        ],
      },
    });
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
 * Mounts the workspace with a scripted server, on People unless told otherwise.
 *
 * The UI is switched to English so the assertions below read as the operator's
 * own words; the Arabic strings are the default and are asserted separately.
 */
function start(api: FakeApi, hash = '#/people'): { app: AppHandle; root: HTMLElement } {
  const root = mountRoot();
  let keys = 0;
  const app = mount({
    root,
    host: createHost(hash),
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

function choose(root: ParentNode, selector: string, value: string): void {
  const element = find(root, selector);
  if (!(element instanceof window.HTMLSelectElement)) throw new Error(`not a select: ${selector}`);
  element.value = value;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function text(root: ParentNode | null): string {
  return root?.textContent ?? '';
}

function isDisabled(root: ParentNode, selector: string): boolean {
  return (find(root, selector) as HTMLButtonElement).disabled;
}

function toasts(app: AppHandle): readonly string[] {
  return app.state.toasts.map((toast) => toast.text);
}

/** Opens the invitation dialog and fills it in. */
function fillInvite(root: HTMLElement, email: string, roleId = AGENT_ROLE): void {
  click(root, '[data-act="dialog"][data-arg="invite"]');
  type(root, '#invite-email', email);
  choose(root, '#invite-role', roleId);
}

/* ------------------------------------------------------- loading and refusal -- */

const CUSTOM_ROLE = 'r-custom';

function customRole(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CUSTOM_ROLE,
    key: 'enrollment_lead',
    name: 'Enrollment lead',
    is_builtin: false,
    description: 'Handles enrolment.',
    updated_at: NOW.toISOString(),
    grants: [{ permission_key: 'conversation.read', scope_level: 'scoped' }],
    ...overrides,
  };
}

/** The Owner's workspace with a custom role one colleague holds. */
function rolesApi(): FakeApi {
  return signedInApi()
    .on(`GET /tenants/${TENANT}/roles`, {
      status: 200,
      body: {
        data: [
          { id: AGENT_ROLE, key: 'agent', name: 'Agent', is_builtin: true, description: '', updated_at: NOW.toISOString(), grants: [{ permission_key: 'conversation.read', scope_level: 'own' }] },
          customRole(),
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: { data: [person(), person({ membership_id: 'm-2', email: 'nadia@digital-school.example', role: { id: CUSTOM_ROLE, key: 'enrollment_lead', name: 'Enrollment lead' } })] },
    });
}

function openMenu(root: HTMLElement, id: string): void {
  click(root, `[data-act="menu"][data-arg="${id}"]`);
}

function check(root: ParentNode, selector: string): void {
  const element = find(root, selector);
  if (!(element instanceof window.HTMLInputElement)) throw new Error(`not an input: ${selector}`);
  element.checked = !element.checked;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

describe('what the user-management screens show before and instead of an answer', () => {
  it('marks the lists busy until the slowest one lands', async () => {
    const api = signedInApi();
    const release = api.hold(`GET /tenants/${TENANT}/people`);
    const { root } = start(api);
    await settle();

    expect(root.querySelector('.page--people [aria-busy="true"]')).not.toBeNull();

    release({ status: 200, body: { data: [] } });
    await settle();
    expect(root.querySelector('.page--people [aria-busy="true"]')).toBeNull();
    expect(text(root)).toContain('No users yet');
  });

  it('reports a refusal as a permission state, with nothing to retry', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/people`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'Denied.' } },
    });
    const { root } = start(api);
    await settle();

    const refusal = find(root, '.errorstate--denied');
    expect(text(refusal)).toContain('You don’t have permission for this');
    expect(text(refusal)).toContain('Ask a workspace administrator for access.');
    expect(refusal.querySelector('[data-act="live-reload"]')).toBeNull();
  });

  it('says a concealed record is not available, which is not the same as not permitted', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/roles`, {
      status: 404,
      body: { error: { code: 'resource_not_found', message: 'Not found.' } },
    });
    const { root } = start(api, '#/roles');
    await settle();
    expect(text(find(root, '.errorstate--denied'))).toContain('Not found or not available to you');
    expect(text(root)).not.toContain('You don’t have permission for this');
  });

  it('closes the workspace when a list says the session has ended', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/teams`, NO_SESSION);
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('Your session ended');
    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(root.querySelector('.nav, [data-membership]')).toBeNull();
  });

  it('separates an unreachable server from a rejection, and offers a retry', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/invitations`, () => {
      throw new Error('connection refused');
    });
    const { root } = start(api, '#/people?tab=invitations');
    await settle();

    const failure = find(root, '.errorstate');
    expect(text(failure)).toContain('Can’t reach the server');
    expect(failure.classList.contains('errorstate--denied')).toBe(false);
    expect(failure.querySelector('[data-act="live-reload"]')).not.toBeNull();
  });

  it('quotes the request id so a failure can be traced in the API log', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/teams`, {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Something broke.', request_id: 'r-77' } },
    });
    const { root } = start(api, '#/teams');
    await settle();

    expect(text(root)).toContain('The server couldn’t complete this');
    expect(text(root)).toContain('Request ID: r-77');
    expect(text(root)).not.toContain('Something broke.');
  });

  it('re-reads every list on demand, and not the session', async () => {
    const api = signedInApi();
    const { root } = start(api);
    await settle();
    const before = api.calls.length;

    click(root, '.pagebar [data-act="live-reload"]');
    await settle();

    const reads = api.calls.slice(before).map((call) => call.path);
    expect(reads).toHaveLength(6);
    expect(reads).not.toContain('/auth/session');
  });

  it('keeps the rows and Refresh glyph steady during a requested refresh', async () => {
    const api = signedInApi();
    const { app, root } = start(api);
    await settle();
    const release = api.hold(`GET /tenants/${TENANT}/people`);

    click(root, '.pagebar [data-act="live-reload"]');
    await settle();
    // Nothing is blanked into placeholders; the control says it is working.
    expect(root.querySelector(`tr[data-membership="${MEMBERSHIP}"]`)).not.toBeNull();
    expect(root.querySelector('.skeleton')).toBeNull();
    const control = find(root, '.pagebar [data-act="live-reload"]');
    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(control.querySelector('.btn__icon--refreshing svg')).not.toBeNull();
    expect(app.state.live.refreshing).toBe('live-reload');

    release({ status: 200, body: { data: [person(), person({ membership_id: 'm-2', email: 'nadia@digital-school.example' })] } });
    await settle();
    expect(app.state.live.refreshing).toBeNull();
    expect(find(root, '.pagebar [data-act="live-reload"]').getAttribute('aria-busy')).toBeNull();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('still shows placeholders when a refresh retries a list that never loaded', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/people`, {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Broke.' } },
    });
    const { root } = start(api);
    await settle();
    api.on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person()] } });
    const release = api.hold(`GET /tenants/${TENANT}/people`);
    click(root, '.errorstate [data-act="live-reload"]');
    await settle();
    expect(root.querySelector('.skeleton')).not.toBeNull();
    release({ status: 200, body: { data: [person()] } });
    await settle();
    expect(root.querySelector(`tr[data-membership="${MEMBERSHIP}"]`)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ users -- */

describe('the Users screen', () => {
  it('lists members with role, teams, status and scope, and filters them', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/people`, {
        status: 200,
        body: { data: [person(), person({ membership_id: 'm-2', email: 'nadia@digital-school.example', status: 'suspended', scopes: [{ type: 'team', id: 't-1' }, { type: 'team', id: 't-2' }, { type: 'queue', id: 'q-1' }] })] },
      })
      .on(`GET /tenants/${TENANT}/teams`, {
        status: 200,
        body: { data: [{ id: 'team-1', name: 'Admissions', member_count: 1, archived: false, members: [{ membership_id: MEMBERSHIP, email: 'hana@digital-school.example' }] }] },
      });
    const { app, root } = start(api);
    await settle();

    const hana = text(find(root, `tr[data-membership="${MEMBERSHIP}"]`));
    expect(hana).toContain('Agent');
    expect(hana).toContain('Admissions');
    expect(hana).toContain('No scope');
    const nadia = text(find(root, 'tr[data-membership="m-2"]'));
    expect(nadia).toContain('No team');
    expect(nadia).toContain('Suspended');
    expect(nadia).toContain('Team × 2');
    // A scope type this build does not name is shown by the server's own word.
    expect(nadia).toContain('queue');
    expect(text(find(root, '[role="tablist"]'))).toContain('Users2');

    type(root, '[data-act="user-search"]', 'admissions');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    type(root, '[data-act="user-search"]', 'nobody-matches');
    expect(text(root)).toContain('No user matches this search.');
    expect(app.state.userSearch).toBe('nobody-matches');
  });

  it('keeps invitations on their own tab, with created and expiry dates', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/invitations`, {
        status: 200,
        body: {
          data: [
            invitation({ id: 'inv-9' }),
            invitation({ id: 'inv-8', status: 'accepted', accepted_at: NOW.toISOString() }),
            invitation({ id: 'inv-r', status: 'revoked', revoked_at: NOW.toISOString() }),
            invitation({ id: 'inv-x', status: 'bounced' }),
          ],
        },
      })
      .on(`DELETE /tenants/${TENANT}/invitations/inv-9`, { status: 204, body: null });
    const { app, root } = start(api);
    await settle();
    // The Users tab shows no invitations; its tab counts the pending ones.
    expect(root.querySelector('[data-invitation]')).toBeNull();
    expect(text(find(root, '#tab-invitations'))).toContain('1');

    const { root: invitations } = start(api, '#/people?tab=invitations');
    await settle();
    expect(find(invitations, '#tab-invitations').getAttribute('aria-selected')).toBe('true');
    expect(text(find(invitations, '[data-invitation="inv-8"]'))).toContain('Accepted');
    expect(text(find(invitations, '[data-invitation="inv-r"]'))).toContain('Revoked');
    expect(text(find(invitations, '[data-invitation="inv-x"]'))).toContain('bounced');
    expect(text(find(invitations, '[data-invitation="inv-8"]'))).toContain('—');
    // Only the pending one can be withdrawn.
    expect(invitations.querySelectorAll('[data-act="live-revoke-invite"]')).toHaveLength(1);
    click(invitations, '[data-act="live-revoke-invite"]');
    await settle();
    expect(toasts(handle as AppHandle)).toEqual(['Invitation revoked']);
    expect(app).toBeDefined();
  });

  it('offers an invitation from an empty invitations tab', async () => {
    const { root } = start(signedInApi(), '#/people?tab=invitations');
    await settle();
    expect(text(root)).toContain('No invitations');
    expect(root.querySelectorAll('[data-act="dialog"][data-arg="invite"]')).toHaveLength(2);
  });

  it('shows pending on the control, and toasts only once the server commits', async () => {
    const api = signedInApi();
    const release = api.hold(`POST /tenants/${TENANT}/invitations`);
    const { app, root } = start(api);
    await settle();

    fillInvite(root, 'tarek@digital-school.example');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    expect(find(root, '.dialog [data-act="live-invite"]').getAttribute('aria-busy')).toBe('true');
    expect(isDisabled(root, '.dialog [data-act="live-invite"]')).toBe(true);
    expect(app.state.toasts).toHaveLength(0);

    api.on(`GET /tenants/${TENANT}/invitations`, { status: 200, body: { data: [invitation()] } });
    release({ status: 201, body: { data: invitation() } });
    await settle();

    expect(toasts(app)).toEqual(['Invitation created for tarek@digital-school.example and queued. Email delivery depends on the configured provider.']);
    expect(root.querySelector('.dialog')).toBeNull();
    expect(app.state.dialogForm['inviteEmail']).toBeUndefined();
  });

  it('checks the invitation before sending it', async () => {
    const api = signedInApi();
    const { root } = start(api);
    await settle();

    click(root, '[data-act="dialog"][data-arg="invite"]');
    type(root, '#invite-email', 'not an address');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    expect(text(root.querySelector('.dialog'))).toContain('Enter a valid email address.');
    expect(text(root.querySelector('.dialog'))).toContain('Choose a role.');
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('carries CSRF, and one idempotency key per attempt', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 400,
      body: { error: { code: 'invalid_input', message: 'That is not an address.' } },
    });
    const { root } = start(api);
    await settle();

    fillInvite(root, 'tarek@digital-school.example');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    const posts = api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/invitations'));
    expect(posts.map((call) => call.headers['x-csrf-token'])).toEqual(['csrf-token', 'csrf-token']);
    expect(posts.map((call) => call.headers['idempotency-key'])).toEqual(['key-1', 'key-2']);
  });

  it('shows the server’s reason beside the form, and claims nothing', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/invitations`, {
      status: 403,
      body: {
        error: {
          code: 'delegation_ceiling',
          message: 'You cannot grant access wider than your own.',
          request_id: 'r-12',
          details: [{ field: 'tenant.delete', code: 'not_held', message: 'Exceeds your access.' }],
        },
      },
    });
    const { app, root } = start(api);
    await settle();

    fillInvite(root, 'escalate@digital-school.example');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    const dialog = find(root, '.dialog');
    expect(text(dialog)).toContain('You cannot grant access wider than your own. · Exceeds your access.');
    expect(text(dialog)).toContain('Request ID: r-12');
    expect(app.state.toasts).toHaveLength(0);
    expect((find(root, '#invite-email') as HTMLInputElement).value).toBe('escalate@digital-school.example');
  });

  it('changes a role from the row menu, re-reading the server afterwards', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ role: { id: SUPERVISOR_ROLE, key: 'supervisor', name: 'Supervisor' } }) },
    });
    const { app, root } = start(api);
    await settle();

    openMenu(root, `member:${MEMBERSHIP}`);
    expect(find(root, '.row-menu').getAttribute('role')).toBe('menu');
    click(root, `[data-act="dialog"][data-arg="member-role:${MEMBERSHIP}"]`);
    // The current role is preselected, and saving it unchanged is not offered.
    expect(isDisabled(root, '.dialog [data-act="live-member-role"]')).toBe(true);
    api.on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: { data: [person({ role: { id: SUPERVISOR_ROLE, key: 'supervisor', name: 'Supervisor' }, scopes: [{ type: 'tenant', id: null }] })] },
    });
    choose(root, '#member-role', SUPERVISOR_ROLE);
    click(root, '.dialog [data-act="live-member-role"]');
    await settle();

    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ roleId: SUPERVISOR_ROLE });
    expect(toasts(app)).toEqual(['Role is now Supervisor']);
    expect(root.querySelector('.dialog')).toBeNull();
    expect(text(find(root, `tr[data-membership="${MEMBERSHIP}"]`))).toContain('Whole workspace');
  });

  it('keeps the dialog open with the reason when a role change is refused', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 403,
      body: { error: { code: 'delegation_ceiling', message: 'Wider than your own.' } },
    });
    const { app, root } = start(api);
    await settle();
    app.dispatch('dialog', `member-role:${MEMBERSHIP}`);
    app.dispatch('live-member-role', MEMBERSHIP);
    await settle();
    // Nothing chosen yet: nothing sent.
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
    choose(root, '#member-role', SUPERVISOR_ROLE);
    click(root, '.dialog [data-act="live-member-role"]');
    await settle();
    expect(text(find(root, '.dialog'))).toContain('Wider than your own.');
  });

  it('suspends, reactivates and grants the whole-workspace scope from the menu', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ status: 'suspended' }) },
    });
    const { app, root } = start(api);
    await settle();

    openMenu(root, `member:${MEMBERSHIP}`);
    click(root, `[data-act="live-status"][data-arg="${MEMBERSHIP}:suspended"]`);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({ status: 'suspended' });
    expect(toasts(app)).toContain('Status is now Suspended');

    api.on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person({ status: 'suspended' })] } });
    app.dispatch('live-reload');
    await settle();
    openMenu(root, `member:${MEMBERSHIP}`);
    expect(root.querySelector(`[data-arg="${MEMBERSHIP}:active"]`)).not.toBeNull();
    // A suspended member cannot be offered ownership.
    expect(root.querySelector(`[data-arg="ownership-offer:${MEMBERSHIP}"]`)).toBeNull();

    click(root, `[data-act="live-scope-tenant"][data-arg="${MEMBERSHIP}"]`);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({ scopes: [{ type: 'tenant', id: null }] });
    expect(toasts(app)).toContain('Scopes updated');
  });

  it('names a status the build does not know by the server’s own word', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ status: 'archived' }) },
    });
    const { app } = start(api);
    await settle();
    app.dispatch('live-status', `${MEMBERSHIP}:revoked`);
    await settle();
    expect(toasts(app)).toEqual(['Status is now archived']);
  });

  it('asks before revoking access, and closes once the server agrees', async () => {
    const api = signedInApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ status: 'revoked' }) },
    });
    const { app, root } = start(api);
    await settle();
    openMenu(root, `member:${MEMBERSHIP}`);
    click(root, `[data-act="dialog"][data-arg="member-revoke:${MEMBERSHIP}"]`);
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(text(find(root, '.dialog'))).toContain('will lose access to this workspace immediately');
    click(root, '.dialog [data-act="live-member-revoke"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'revoked' });
    expect(toasts(app)).toEqual(['Status is now Revoked']);
    expect(root.querySelector('.dialog')).toBeNull();
  });

  it('offers nothing a member cannot have done to themselves, or to someone revoked', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: { data: [
        person({ membership_id: 'own-membership', email: 'owner@digital-school.example', scopes: [{ type: 'tenant', id: null }] }),
        person({ membership_id: 'm-gone', email: 'gone@digital-school.example', status: 'revoked' }),
      ] },
    });
    const { root } = start(api);
    await settle();
    openMenu(root, 'member:own-membership');
    expect(root.querySelector('[data-arg="own-membership:suspended"]')?.hasAttribute('disabled')).toBe(true);
    expect(root.querySelector('[data-arg="ownership-offer:own-membership"]')).toBeNull();
    expect(root.querySelector('[data-arg="member-revoke:own-membership"]')).toBeNull();
    openMenu(root, 'member:m-gone');
    expect(root.querySelector('[data-arg^="m-gone:"]')).toBeNull();
    expect(root.querySelector('[data-arg="member-revoke:m-gone"]')).toBeNull();
  });

  it('adds and removes team membership from the member’s own dialog', async () => {
    const team = { id: 'team-1', name: 'Admissions', member_count: 0, archived: false, members: [] };
    const joined = { ...team, member_count: 1, members: [{ membership_id: MEMBERSHIP, email: 'hana@digital-school.example' }] };
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [team, { id: 'team-old', name: 'Old', member_count: 0, archived: true, members: [] }] } })
      .on(`POST /tenants/${TENANT}/teams/team-1/members`, { status: 200, body: { data: joined } })
      .on(`DELETE /tenants/${TENANT}/teams/team-1/members/${MEMBERSHIP}`, { status: 200, body: { data: team } });
    const { app, root } = start(api);
    await settle();

    app.dispatch('dialog', `member-teams:${MEMBERSHIP}`);
    // An archived team the member is not in is not offered.
    expect(text(find(root, '.dialog'))).not.toContain('Old');
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [joined] } });
    click(root, `[data-act="live-member-team"][data-arg="team-1:${MEMBERSHIP}:add"]`);
    await settle();
    expect(api.calls.find((call) => call.path.endsWith('/members'))?.body).toEqual({ membershipId: MEMBERSHIP });
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [team] } });
    click(root, `[data-act="live-member-team"][data-arg="team-1:${MEMBERSHIP}:remove"]`);
    await settle();
    expect(toasts(app)).toContain('Removed from the team');
    app.dispatch('live-member-team', 'team-1:m:unknown');
    await settle();
    expect(app.state.toasts).toHaveLength(2);
  });

  it('says so when a dialog’s member, role or team has gone', async () => {
    const { app, root } = start(signedInApi());
    await settle();
    for (const dialog of ['member-role:x', 'member-revoke:x', 'member-teams:x', 'role-rename:x', 'role-delete:x', 'role-assign:x', 'team-rename:x']) {
      app.dispatch('dialog', dialog);
      expect(text(find(root, '.dialog'))).toContain('This item no longer exists');
    }
  });

  it('says there are no teams yet in the member’s team dialog', async () => {
    const { app, root } = start(signedInApi());
    await settle();
    app.dispatch('dialog', `member-teams:${MEMBERSHIP}`);
    expect(text(find(root, '.dialog'))).toContain('There are no teams yet');
  });

  it('confirms an ownership offer first, then settles it three ways', async () => {
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
      .on(`POST /tenants/${TENANT}/ownership-transfers/tr-1/accept`, { status: 200, body: { data: { ...settled, status: 'accepted' } } })
      .on(`POST /tenants/${TENANT}/ownership-transfers/tr-1/decline`, { status: 200, body: { data: { ...settled, status: 'declined' } } })
      .on(`DELETE /tenants/${TENANT}/ownership-transfers/tr-1`, { status: 204, body: null });
    const { app, root } = start(api);
    await settle();

    openMenu(root, `member:${MEMBERSHIP}`);
    click(root, `[data-act="dialog"][data-arg="ownership-offer:${MEMBERSHIP}"]`);
    expect(api.calls.some((call) => call.path.endsWith('/ownership-transfers') && call.method === 'POST')).toBe(false);
    expect(text(find(root, '.dialog'))).toContain('hana@digital-school.example');

    api.on(`GET /tenants/${TENANT}/ownership-transfers`, { status: 200, body: { data: [transfer] } });
    click(root, '.dialog [data-act="live-offer-ownership"]');
    await settle();
    expect(root.querySelector('.dialog')).toBeNull();
    expect(text(root)).toContain('Ownership transfer awaiting a decision');
    expect(text(root)).toContain('Offer to hana@digital-school.example');

    click(root, '[data-arg="tr-1:decline"]');
    await settle();
    click(root, '[data-arg="tr-1:cancel"]');
    await settle();
    click(root, '[data-arg="tr-1:accept"]');
    await settle();
    expect(toasts(app)).toEqual(['Ownership offer declined', 'Ownership offer cancelled', 'Ownership transferred']);
  });

  it('names a pending offer’s recipient by id when they are no longer listed, and hides settled ones', async () => {
    const api = signedInApi().on(`GET /tenants/${TENANT}/ownership-transfers`, {
      status: 200,
      body: { data: [
        { id: 'tr-p', status: 'pending', from_membership: 'own-membership', to_membership: 'someone-gone', created_at: NOW.toISOString(), expires_at: NOW.toISOString(), settled_at: null },
        { id: 'tr-old', status: 'accepted', from_membership: 'own-membership', to_membership: MEMBERSHIP, created_at: NOW.toISOString(), expires_at: NOW.toISOString(), settled_at: NOW.toISOString() },
      ] },
    });
    const { root } = start(api);
    await settle();
    expect(root.querySelectorAll('.transfer')).toHaveLength(1);
    expect(text(find(root, '.transfer'))).toContain('someone-gone');
  });

  it('ignores an ownership decision it does not recognise', async () => {
    const { app } = start(signedInApi());
    await settle();
    app.dispatch('live-ownership', 'tr-1:destroy');
    await settle();
    expect(app.state.toasts).toHaveLength(0);
  });

  it('says the member has gone when an ownership offer points at nobody', async () => {
    const { app, root } = start(signedInApi());
    await settle();
    app.dispatch('dialog', 'ownership-offer:nobody');
    expect(text(find(root, '.dialog'))).toContain('This member no longer exists');
  });

  it('offers nothing it cannot back: no invite without member management, no role change without roles', async () => {
    const api = signedInApi()
      .on('GET /me/memberships', {
        status: 200,
        body: { data: [{ id: 'own-membership', tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' }, role: { id: 'custom', key: 'viewer', name: 'Viewer' }, permissions: ['member.manage'] }] },
      })
      .on(`GET /tenants/${TENANT}/roles`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } })
      .on(`GET /tenants/${TENANT}/teams`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root } = start(api);
    await settle();
    openMenu(root, `member:${MEMBERSHIP}`);
    expect(root.querySelector('[data-arg^="member-role:"]')).toBeNull();
    expect(root.querySelector('[data-arg^="member-teams:"]')).toBeNull();
    // Roles are not in the navigation: they need role.manage.
    expect([...root.querySelectorAll('.nav__item')].map((item) => item.getAttribute('data-arg'))).toEqual(['people', 'teams', 'settings']);
  });

  it('shows no menu at all when nothing can be done to a member', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person({ membership_id: 'own-membership', email: 'owner@digital-school.example', status: 'revoked', scopes: [{ type: 'tenant', id: null }] })] } })
      .on(`GET /tenants/${TENANT}/roles`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } })
      .on(`GET /tenants/${TENANT}/teams`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root } = start(api);
    await settle();
    expect(root.querySelector('[data-arg="member:own-membership"]')).toBeNull();
  });

  it('speaks Arabic by default, which is the workspace’s own language', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/teams`, {
      status: 201,
      body: { data: { id: 'team-1', name: 'القبول', member_count: 0, archived: false, members: [] } },
    });
    const root = mountRoot();
    const app = mount({ root, host: createHost('#/teams'), now: NOW, fetch: api.fetch, readCsrfToken: () => 'csrf-token', newKey: () => 'key-1' });
    handle = app;
    await settle();

    expect(text(find(root, '.header__title'))).toBe('الفرق');
    expect(text(find(root, '.nav'))).toContain('إدارة المستخدمين');
    click(root, '[data-act="dialog"][data-arg="team-create"]');
    type(root, '#team-name', 'القبول');
    click(root, '.dialog [data-act="live-create-team"]');
    await settle();
    expect(toasts(app)).toEqual(['أُنشئ الفريق القبول']);
    expect(root.querySelector('.dialog')).toBeNull();
  });
});

/* ------------------------------------------------------------------ roles -- */

describe('the Roles screen', () => {
  it('lists roles with type, holders and permission counts, built-in ones read-only', async () => {
    const { root } = start(rolesApi(), '#/roles');
    await settle();
    const custom = text(find(root, '[data-role="enrollment_lead"]'));
    expect(custom).toContain('Custom');
    expect(custom).toContain('Handles enrolment.');
    expect(custom).toContain('1 / 5');
    expect(text(find(root, '[data-role="agent"]'))).toContain('Built-in');
    // Built-ins come first, and offer no actions.
    expect(root.querySelector('tbody tr')?.getAttribute('data-role')).toBe('agent');
    expect(root.querySelector('[data-arg="role:agent-role"], [data-arg="role:22222222-2222-4222-8222-222222222222"]')).toBeNull();
    expect(root.querySelector(`[data-arg="role:${CUSTOM_ROLE}"]`)).not.toBeNull();
  });

  it('shows counts as unknown when the member or catalogue lists were refused', async () => {
    const api = rolesApi()
      .on(`GET /tenants/${TENANT}/people`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } })
      .on(`GET /tenants/${TENANT}/permissions`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root } = start(api, '#/roles');
    await settle();
    const row = text(find(root, '[data-role="enrollment_lead"]'));
    expect(row).toContain('—');
    expect(row).toContain('1');
    expect(root.querySelector('[data-arg="role-create"]')).not.toBeNull();
  });

  it('creates a role from a name and description, with no grants, then opens it', async () => {
    const created = customRole({ id: 'r-new', key: 'lead', name: 'Lead', description: 'Leads.', grants: [] });
    const api = rolesApi().on(`POST /tenants/${TENANT}/roles`, { status: 201, body: { data: created } });
    const { app, root } = start(api, '#/roles');
    await settle();

    click(root, '[data-act="dialog"][data-arg="role-create"]');
    expect(isDisabled(root, '.dialog [data-act="live-create-role"]')).toBe(true);
    type(root, '#role-name', 'Lead');
    const description = find(root, '#role-description') as HTMLTextAreaElement;
    description.value = 'Leads.';
    description.dispatchEvent(new window.Event('input', { bubbles: true }));
    api.on(`GET /tenants/${TENANT}/roles`, { status: 200, body: { data: [customRole(), created] } });
    click(root, '.dialog [data-act="live-create-role"]');
    await settle();

    expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/roles'))?.body).toEqual({ name: 'Lead', description: 'Leads.', grants: [] });
    expect(toasts(app)).toContain('Created the role Lead');
    expect(root.querySelector('.dialog')).toBeNull();
    expect(app.state.route.params['role']).toBe('r-new');
    expect(text(find(root, '.admin-head__title'))).toBe('Lead');
  });

  it('stays on the list when a created role does not come back in the list', async () => {
    const api = rolesApi().on(`POST /tenants/${TENANT}/roles`, { status: 201, body: { data: customRole({ id: 'r-new', name: 'Ghost' }) } });
    const { app } = start(api, '#/roles');
    await settle();
    app.dispatch('dialog', 'role-create');
    app.dispatch('form', 'roleName:Ghost');
    app.dispatch('live-create-role');
    await settle();
    expect(app.state.route.params['role']).toBeUndefined();
    expect(app.state.dialog).toBeNull();
  });

  it('keeps what was typed when creating a role is refused', async () => {
    const api = rolesApi().on(`POST /tenants/${TENANT}/roles`, {
      status: 409,
      body: { error: { code: 'role_name_taken', message: 'A role with that name exists.' } },
    });
    const { app, root } = start(api, '#/roles');
    await settle();
    click(root, '[data-act="dialog"][data-arg="role-create"]');
    type(root, '#role-name', 'Agent');
    click(root, '.dialog [data-act="live-create-role"]');
    await settle();
    expect(text(find(root, '.dialog'))).toContain('A role with that name exists.');
    expect(app.state.dialogForm['roleName']).toBe('Agent');
  });

  it('edits a role’s name and description, resending the grants the server reported', async () => {
    const api = rolesApi().on(`PATCH /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, { status: 200, body: { data: customRole({ name: 'Admissions lead' }) } });
    const { app, root } = start(api, '#/roles');
    await settle();
    openMenu(root, `role:${CUSTOM_ROLE}`);
    click(root, `[data-act="dialog"][data-arg="role-rename:${CUSTOM_ROLE}"]`);
    expect((find(root, '#role-rename') as HTMLInputElement).value).toBe('Enrollment lead');
    type(root, '#role-rename', 'Admissions lead');
    click(root, '.dialog [data-act="live-rename-role"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Admissions lead',
      description: 'Handles enrolment.',
      grants: [{ permission: 'conversation.read', scope: 'scoped' }],
    });
    expect(toasts(app)).toContain('Renamed to Admissions lead');
    expect(root.querySelector('.dialog')).toBeNull();

    app.dispatch('dialog', `role-rename:${CUSTOM_ROLE}`);
    const description = find(root, '#role-rename-description') as HTMLTextAreaElement;
    description.value = '  New purpose  ';
    description.dispatchEvent(new window.Event('input', { bubbles: true }));
    app.dispatch('live-rename-role', CUSTOM_ROLE);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toMatchObject({ description: 'New purpose' });
  });

  it('keeps the rename dialog open when the server refuses it', async () => {
    const api = rolesApi().on(`PATCH /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, { status: 409, body: { error: { code: 'role_exists', message: 'Taken.' } } });
    const { app, root } = start(api, '#/roles');
    await settle();
    app.dispatch('dialog', `role-rename:${CUSTOM_ROLE}`);
    app.dispatch('live-rename-role', CUSTOM_ROLE);
    await settle();
    expect(text(find(root, '.dialog'))).toContain('Taken.');
  });

  it('ignores a rename aimed at a role the server never sent', async () => {
    const { app } = start(signedInApi());
    await settle();
    app.dispatch('live-rename-role', 'r-unknown');
    await settle();
    expect(app.state.toasts).toHaveLength(0);
  });

  it('refuses up front to delete a role somebody holds, and deletes an unused one', async () => {
    const api = rolesApi()
      .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person()] } })
      .on(`DELETE /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, { status: 204, body: null });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    app.dispatch('role-grant-toggle', 'report.read');
    openMenu(root, `role:${CUSTOM_ROLE}`);
    click(root, `[data-act="dialog"][data-arg="role-delete:${CUSTOM_ROLE}"]`);
    expect(text(find(root, '.dialog'))).toContain('will be deleted permanently');
    api.on(`GET /tenants/${TENANT}/roles`, { status: 200, body: { data: [] } });
    click(root, '.dialog [data-act="live-delete-role"]');
    await settle();
    expect(toasts(app)).toContain('Role deleted');
    expect(root.querySelector('.dialog')).toBeNull();
    // Its page no longer exists, and neither does the draft on it.
    expect(app.state.route.params['role']).toBeUndefined();
    expect(app.state.roleDraft).toBeNull();

    const held = rolesApi();
    const { root: second } = start(held, '#/roles');
    await settle();
    (handle as AppHandle).dispatch('dialog', `role-delete:${CUSTOM_ROLE}`);
    expect(text(find(second, '.dialog'))).toContain('1 member(s) hold this role');
    expect(isDisabled(second, '.dialog [data-act="live-delete-role"]')).toBe(true);
  });

  it('keeps the page and the dialog when a delete is refused, and deletes from the list too', async () => {
    const api = rolesApi()
      .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person()] } })
      .on(`DELETE /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, { status: 409, body: { error: { code: 'role_in_use', message: 'In use.' } } });
    const { app, root } = start(api, '#/roles');
    await settle();
    app.dispatch('dialog', `role-delete:${CUSTOM_ROLE}`);
    app.dispatch('live-delete-role', CUSTOM_ROLE);
    await settle();
    expect(text(find(root, '.dialog'))).toContain('In use.');
    api.on(`DELETE /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, { status: 204, body: null });
    app.dispatch('live-delete-role', CUSTOM_ROLE);
    await settle();
    expect(app.state.route.screen).toBe('roles');
  });
});

/* ------------------------------------------------------------ role detail -- */

describe('a role in detail', () => {
  it('shows the header, a compact summary and the permission modules', async () => {
    const { root } = start(rolesApi(), `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    expect(text(find(root, '.breadcrumb'))).toBe('RolesEnrollment lead');
    expect(text(find(root, '.admin-head'))).toContain('Custom');
    const summary = text(find(root, '.role-summary'));
    expect(summary).toContain('Assigned users1');
    expect(summary).toContain('Permissions1 / 5');
    expect(summary).toContain('Role typeCustom');
    expect(summary).toContain('Last updated');
    expect(find(root, '#tab-permissions').getAttribute('aria-selected')).toBe('true');
    expect(text(find(root, '.permissions__count'))).toBe('1 of 5 enabled');
    // Real keys under friendly labels, grouped by module; an unknown key under Other.
    const conversations = find(root, '[data-group="conversations"]');
    expect(text(conversations)).toContain('Read conversations');
    expect(text(conversations)).toContain('conversation.read');
    expect(text(find(conversations, '.permission-card__count'))).toBe('1/1');
    expect(text(find(root, '[data-group="other"]'))).toContain('future.thing');
  });

  it('explains every control it cannot offer instead of pretending it worked', async () => {
    const { root } = start(rolesApi(), `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    // Not delegable: never on a custom role.
    expect((find(root, '[data-permission="tenant.delete"] input') as HTMLInputElement).disabled).toBe(true);
    expect(text(find(root, '[data-permission="tenant.delete"]'))).toContain('Not delegable');
    // Delegable, but the operator does not hold it.
    expect((find(root, '[data-permission="contact.export"] input') as HTMLInputElement).disabled).toBe(true);
    expect(text(find(root, '[data-permission="contact.export"]'))).toContain('You don’t hold it');
    // Held and delegable: editable.
    expect((find(root, '[data-permission="report.read"] input') as HTMLInputElement).disabled).toBe(false);
  });

  it('drafts a change, shows it as unsaved, then saves the whole grant set', async () => {
    const api = rolesApi().on(`PATCH /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, {
      status: 200,
      body: { data: customRole({ grants: [{ permission_key: 'conversation.read', scope_level: 'scoped' }, { permission_key: 'report.read', scope_level: 'own' }] }) },
    });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    expect(root.querySelector('.savebar')).toBeNull();

    check(root, '[data-permission="report.read"] input');
    expect(app.state.roleDraft?.grants).toEqual({ 'conversation.read': 'scoped', 'report.read': 'tenant' });
    expect(text(find(root, '.permissions__count'))).toBe('2 of 5 enabled');
    expect(root.querySelector('.savebar')).not.toBeNull();
    choose(root, '[data-permission="report.read"] select', 'own');
    expect(app.state.roleDraft?.grants['report.read']).toBe('own');
    // Nothing reaches the server until Save.
    expect(api.calls.some((call) => call.method === 'PATCH')).toBe(false);

    api.on(`GET /tenants/${TENANT}/roles`, {
      status: 200,
      body: { data: [customRole({ grants: [{ permission_key: 'conversation.read', scope_level: 'scoped' }, { permission_key: 'report.read', scope_level: 'own' }] })] },
    });
    click(root, '.savebar [data-act="live-save-role"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Enrollment lead',
      description: 'Handles enrolment.',
      grants: [{ permission: 'conversation.read', scope: 'scoped' }, { permission: 'report.read', scope: 'own' }],
    });
    expect(toasts(app)).toContain('Saved permissions for Enrollment lead');
    expect(app.state.roleDraft).toBeNull();
    expect(root.querySelector('.savebar')).toBeNull();
  });

  it('keeps the draft and shows the server’s refusal when saving fails', async () => {
    const api = rolesApi().on(`PATCH /tenants/${TENANT}/roles/${CUSTOM_ROLE}`, {
      status: 403,
      body: { error: { code: 'delegation_ceiling', message: 'Wider than your own.' } },
    });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    check(root, '[data-permission="conversation.read"] input');
    expect(app.state.roleDraft?.grants).toEqual({});
    click(root, '[data-act="live-save-role"]');
    await settle();
    expect(text(root)).toContain('Wider than your own.');
    expect(app.state.roleDraft).not.toBeNull();

    // Unchecking and rechecking returns to the saved state: nothing unsaved.
    check(root, '[data-permission="conversation.read"] input');
    choose(root, '[data-permission="conversation.read"] select', 'scoped');
    expect(root.querySelector('.savebar')).toBeNull();
    check(root, '[data-permission="conversation.read"] input');
    click(root, '[data-act="role-draft-discard"]');
    expect(app.state.roleDraft).toBeNull();
    expect(app.state.live.error).toBeNull();
  });

  it('ignores edits and saves that do not belong to an editable role', async () => {
    const { app, root } = start(rolesApi(), `#/roles?role=${AGENT_ROLE}`);
    await settle();
    // A built-in role renders the same matrix, read-only, with no draft.
    expect(text(root)).toContain('Permissions for this system role cannot be edited.');
    expect((find(root, '[data-permission="conversation.read"] input') as HTMLInputElement).disabled).toBe(true);
    expect(root.querySelector('.permission-row__lock')).toBeNull();
    app.dispatch('role-grant-toggle', 'report.read');
    app.dispatch('role-grant-scope', 'conversation.read:tenant');
    expect(app.state.roleDraft).toBeNull();
    app.dispatch('live-save-role', AGENT_ROLE);
    await settle();
    expect(app.state.toasts).toHaveLength(0);

    const { app: custom } = start(rolesApi(), `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    // A scope for a key the draft does not hold, or one that is not a scope, changes nothing.
    custom.dispatch('role-grant-scope', 'report.read:tenant');
    custom.dispatch('role-grant-scope', 'conversation.read:everything');
    expect(custom.state.roleDraft).toBeNull();
    custom.dispatch('live-save-role', CUSTOM_ROLE);
    await settle();
    expect(custom.state.toasts).toHaveLength(0);
  });

  it('marks everything read-only for someone who cannot manage roles', async () => {
    const api = rolesApi().on('GET /me/memberships', {
      status: 200,
      body: { data: [{ id: 'own-membership', tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' }, role: { id: 'custom', key: 'viewer', name: 'Viewer' }, permissions: ['member.manage', 'role.manage'] }] },
    });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    // Holds role.manage, but none of these keys: each explains why.
    expect(text(find(root, '[data-permission="report.read"]'))).toContain('You don’t hold it');
    app.state.live.session = { ...app.state.live.session, memberships: [] } as typeof app.state.live.session;
    app.render();
    expect(text(find(root, '[data-permission="report.read"]'))).toContain('You cannot manage roles');
  });

  it('searches permissions by label, key and description, and folds modules', async () => {
    const { app, root } = start(rolesApi(), `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    click(root, '[data-act="permission-group"][data-arg="conversations"]');
    expect(find(root, '[data-group="conversations"] .permission-card__toggle').getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-group="conversations"] .permission-row')).toBeNull();

    type(root, '[data-act="permission-search"]', 'export contacts');
    expect([...root.querySelectorAll('.permission-row')].map((row) => row.getAttribute('data-permission'))).toEqual(['contact.export']);
    type(root, '[data-act="permission-search"]', 'conversation.read');
    // A search opens a folded module that matches.
    expect(root.querySelector('[data-permission="conversation.read"]')).not.toBeNull();
    type(root, '[data-act="permission-search"]', 'something newer');
    expect(root.querySelector('[data-permission="future.thing"]')).not.toBeNull();
    type(root, '[data-act="permission-search"]', 'zzz');
    expect(text(root)).toContain('No permission matches this search.');
    type(root, '[data-act="permission-search"]', '');
    click(root, '[data-act="permission-group"][data-arg="conversations"]');
    expect(app.state.collapsedGroups).toEqual([]);
  });

  it('warns about unsaved changes on the list and before the page unloads', async () => {
    const { app, root } = start(rolesApi(), `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    check(root, '[data-permission="report.read"] input');
    app.dispatch('nav', 'roles');
    await settle();
    expect(app.state.route.params['role']).toBeUndefined();
    expect(text(root)).toContain('You have unsaved changes to Enrollment lead');
  });

  it('asks before the page unloads only while a draft differs from the saved role', async () => {
    const api = rolesApi();
    const root = mountRoot();
    const app = mount({
      root,
      host: createHost(`#/roles?role=${CUSTOM_ROLE}`),
      now: NOW,
      fetch: api.fetch,
      readCsrfToken: () => 'csrf-token',
      newKey: () => 'key-1',
      page: browserPageLifecycle(window),
    });
    handle = app;
    await settle();
    const unload = (): boolean => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    app.dispatch('role-grant-toggle', 'report.read');
    expect(unload()).toBe(true);
    // Toggled back: a draft identical to the saved role is nothing to lose.
    app.dispatch('role-grant-toggle', 'report.read');
    expect(unload()).toBe(false);
    // A draft for a role that has since gone is nothing to lose either.
    app.state.roleDraft = { roleId: 'r-gone', grants: {} };
    expect(unload()).toBe(false);
  });

  it('shows the holders on their own tab, and assigns more through the membership API', async () => {
    const api = rolesApi().on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, {
      status: 200,
      body: { data: person({ role: { id: CUSTOM_ROLE, key: 'enrollment_lead', name: 'Enrollment lead' } }) },
    });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}&tab=users`);
    await settle();
    expect(find(root, '#tab-users').getAttribute('aria-selected')).toBe('true');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(text(find(root, 'tbody'))).toContain('nadia@digital-school.example');
    expect(text(root)).toContain('every member always holds exactly one role');

    click(root, `[data-act="dialog"][data-arg="role-assign:${CUSTOM_ROLE}"]`);
    expect(isDisabled(root, '.dialog [data-act="live-role-assign"]')).toBe(true);
    type(root, '.dialog [data-form="assignSearch"]', 'hana');
    check(root, `#assign-${MEMBERSHIP}`);
    expect(text(find(root, '.dialog [data-act="live-role-assign"]'))).toContain('Assign (1)');
    check(root, `#assign-${MEMBERSHIP}`);
    check(root, `#assign-${MEMBERSHIP}`);
    api.on(`GET /tenants/${TENANT}/people`, {
      status: 200,
      body: { data: [person({ role: { id: CUSTOM_ROLE, key: 'enrollment_lead', name: 'Enrollment lead' } }), person({ membership_id: 'm-2', email: 'nadia@digital-school.example', role: { id: CUSTOM_ROLE, key: 'enrollment_lead', name: 'Enrollment lead' } })] },
    });
    click(root, '.dialog [data-act="live-role-assign"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ roleId: CUSTOM_ROLE });
    expect(toasts(app)).toContain('Role assigned to 1 member(s)');
    expect(root.querySelector('.dialog')).toBeNull();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);

    app.dispatch('dialog', `role-assign:${CUSTOM_ROLE}`);
    expect(text(find(root, '.dialog'))).toContain('There are no other members to assign.');
    app.dispatch('live-role-assign', CUSTOM_ROLE);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('stops assigning at the first refusal and keeps the dialog', async () => {
    const api = rolesApi()
      .on(`GET /tenants/${TENANT}/people`, { status: 200, body: { data: [person(), person({ membership_id: 'm-3', email: 'omar@digital-school.example' })] } })
      .on(`PATCH /tenants/${TENANT}/people/${MEMBERSHIP}`, { status: 403, body: { error: { code: 'delegation_ceiling', message: 'Wider than your own.' } } });
    const { app, root } = start(api, `#/roles?role=${CUSTOM_ROLE}&tab=users`);
    await settle();
    expect(text(root)).toContain('Nobody has this role');
    app.dispatch('dialog', `role-assign:${CUSTOM_ROLE}`);
    app.dispatch('assign-pick', MEMBERSHIP);
    app.dispatch('assign-pick', 'm-3');
    app.dispatch('live-role-assign', CUSTOM_ROLE);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(text(find(root, '.dialog'))).toContain('Wider than your own.');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('says a role is unavailable, or still loading, rather than drawing a blank', async () => {
    const api = rolesApi();
    const release = api.hold(`GET /tenants/${TENANT}/roles`);
    const { root } = start(api, '#/roles?role=missing');
    await settle();
    expect(root.querySelector('.page--roles [aria-busy="true"]')).not.toBeNull();
    release({ status: 200, body: { data: [customRole()] } });
    await settle();
    expect(text(root)).toContain('This role does not exist');

    const refused = signedInApi().on(`GET /tenants/${TENANT}/roles`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root: second } = start(refused, '#/roles?role=missing');
    await settle();
    expect(text(second)).toContain('Role unavailable');
    expect(text(second)).toContain('You don’t have permission for this');
  });

  it('shows the catalogue and holder lists as refused where the server refused them', async () => {
    const api = rolesApi()
      .on(`GET /tenants/${TENANT}/permissions`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } })
      .on(`GET /tenants/${TENANT}/people`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root } = start(api, `#/roles?role=${CUSTOM_ROLE}`);
    await settle();
    expect(text(find(root, '.role-summary'))).toContain('Permissions1');
    expect(text(find(root, '.role-summary'))).toContain('Assigned users—');
    expect(root.querySelector('.errorstate--denied')).not.toBeNull();
    const { root: users } = start(api, `#/roles?role=${CUSTOM_ROLE}&tab=users`);
    await settle();
    expect(users.querySelector('.errorstate--denied')).not.toBeNull();
    expect(users.querySelector('[data-arg^="role-assign:"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ teams -- */

describe('the Teams screen', () => {
  const empty = { id: 'team-1', name: 'Enrollment', member_count: 0, archived: false, members: [] };
  const filled = { ...empty, member_count: 1, members: [{ membership_id: MEMBERSHIP, email: 'hana@digital-school.example' }] };

  it('creates a team from a dialog and lists it with members and status', async () => {
    const api = signedInApi().on(`POST /tenants/${TENANT}/teams`, { status: 201, body: { data: empty } });
    const { app, root } = start(api, '#/teams');
    await settle();
    expect(text(root)).toContain('No teams');
    click(root, '.pagebar [data-act="dialog"][data-arg="team-create"]');
    expect(isDisabled(root, '.dialog [data-act="live-create-team"]')).toBe(true);
    type(root, '#team-name', 'Enrollment');
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty, { ...empty, id: 'team-2', name: 'Old', archived: true }] } });
    click(root, '.dialog [data-act="live-create-team"]');
    await settle();
    expect(toasts(app)).toContain('Created the team Enrollment');
    expect(text(find(root, '[data-team="team-1"]'))).toContain('Active');
    expect(text(find(root, '[data-team="team-2"]'))).toContain('Archived');
  });

  it('adds and removes members, renames, archives and restores a team in detail', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty] } })
      .on(`POST /tenants/${TENANT}/teams/team-1/members`, { status: 200, body: { data: filled } })
      .on(`DELETE /tenants/${TENANT}/teams/team-1/members/${MEMBERSHIP}`, { status: 200, body: { data: empty } })
      .on(`PATCH /tenants/${TENANT}/teams/team-1`, { status: 200, body: { data: { ...empty, archived: true } } });
    const { app, root } = start(api, '#/teams?team=team-1');
    await settle();
    expect(text(find(root, '.breadcrumb'))).toBe('TeamsEnrollment');
    expect(text(root)).toContain('No members yet');
    expect(isDisabled(root, '[data-act="live-team-add"]')).toBe(true);

    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [filled] } });
    choose(root, 'select[data-form="teamMember_team-1"]', MEMBERSHIP);
    click(root, '[data-act="live-team-add"]');
    await settle();
    expect(api.calls.find((call) => call.path.endsWith('/members'))?.body).toEqual({ membershipId: MEMBERSHIP });
    expect(text(find(root, `[data-team-member="${MEMBERSHIP}"]`))).toContain('Agent');
    // Everyone is in the team now: nobody left to add.
    expect(text(find(root, 'select[data-form="teamMember_team-1"]'))).toContain('Nobody to add');

    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [empty] } });
    click(root, '[data-act="live-remove-member"]');
    await settle();
    expect(toasts(app)).toContain('Removed from the team');

    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [{ ...empty, archived: true }] } });
    openMenu(root, 'team:team-1');
    click(root, '[data-act="live-archive-team"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({ archived: true });
    expect(toasts(app)).toContain('Team archived');
    expect(text(root)).toContain('it takes no new members until it is restored');
    expect(root.querySelector('[data-act="live-team-add"]')).toBeNull();

    api.on(`PATCH /tenants/${TENANT}/teams/team-1`, { status: 200, body: { data: { ...empty, name: 'Admissions' } } });
    api.on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [{ ...empty, name: 'Admissions' }] } });
    openMenu(root, 'team:team-1');
    click(root, '[data-act="live-archive-team"][data-arg="team-1:restore"]');
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({ archived: false });

    openMenu(root, 'team:team-1');
    click(root, '[data-act="dialog"][data-arg="team-rename:team-1"]');
    // Unchanged or empty, the name is not sent.
    expect(isDisabled(root, '.dialog [data-act="live-rename-team"]')).toBe(true);
    app.dispatch('live-rename-team', 'team-1');
    type(root, '#team-rename', 'Admissions office');
    click(root, '.dialog [data-act="live-rename-team"]');
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toEqual({ name: 'Admissions office' });
    expect(toasts(app)).toContain('Renamed to Admissions');
    expect(root.querySelector('.dialog')).toBeNull();
  });

  it('names a member the people list does not include by the team’s own record', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [{ ...filled, members: [{ membership_id: 'm-elsewhere', email: 'elsewhere@digital-school.example' }] }] } });
    const { root } = start(api, '#/teams?team=team-1');
    await settle();
    expect(text(find(root, '[data-team-member="m-elsewhere"]'))).toContain('elsewhere@digital-school.example');
  });

  it('says a team is unavailable, or still loading, rather than drawing a blank', async () => {
    const api = signedInApi();
    const release = api.hold(`GET /tenants/${TENANT}/teams`);
    const { root } = start(api, '#/teams?team=missing');
    await settle();
    expect(root.querySelector('.page--teams [aria-busy="true"]')).not.toBeNull();
    release({ status: 200, body: { data: [] } });
    await settle();
    expect(text(root)).toContain('This team does not exist');

    const refused = signedInApi().on(`GET /tenants/${TENANT}/teams`, { status: 403, body: { error: { code: 'permission_denied', message: 'Denied.' } } });
    const { root: second } = start(refused, '#/teams?team=missing');
    await settle();
    expect(text(second)).toContain('Team unavailable');
  });

  it('offers no changes to someone who can only look', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/teams`, { status: 200, body: { data: [filled] } })
      .on('GET /me/memberships', {
        status: 200,
        body: { data: [{ id: 'own-membership', tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' }, role: { id: 'custom', key: 'roles', name: 'Roles only' }, permissions: ['role.manage'] }] },
      });
    const { app, root } = start(api, '#/teams?team=team-1');
    await settle();
    // Teams need member.manage; this membership lands on Roles instead.
    expect(app.state.route.screen).toBe('roles');
    app.state.route = { screen: 'teams', conversationId: null, params: { team: 'team-1' } };
    app.render();
    expect(root.querySelector('[data-act="live-remove-member"], [data-act="live-team-add"], [data-arg="team:team-1"]')).toBeNull();
    app.state.route = { screen: 'teams', conversationId: null, params: {} };
    app.render();
    expect(root.querySelector('[data-arg="team-create"]')).toBeNull();
  });
});

/* ------------------------------------------------------------- transports -- */

describe('the transport the browser actually gets', () => {
  it('asks for the session first, and only then for what the screen shows', async () => {
    const api = signedInApi().on('GET /auth/sessions', { status: 200, body: { data: [] } });
    handle = mount({
      root: mountRoot(),
      host: createHost('#/settings'),
      now: NOW,
      fetch: api.fetch,
      readCsrfToken: () => 'csrf-token',
    });
    await settle();
    // Settings reads this person's own sessions plus the label catalogue it can
    // manage. It does not fan out into People, Inbox, or campaign data.
    expect(api.calls.map((call) => call.path)).toEqual([
      '/auth/session',
      '/me/memberships',
      '/auth/sessions',
      `/tenants/${TENANT}/labels?includeRetired=true`,
      `/tenants/${TENANT}/notifications/unread-count`,
    ]);
  });

  it('opens the inbox against the server, and nothing else', async () => {
    const api = signedInApi()
      .on(`GET /tenants/${TENANT}/conversations/unassigned`, { status: 200, body: { data: [] } })
      .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
        status: 200,
        body: { data: [] },
      })
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [] } })
      .on(`GET /tenants/${TENANT}/campaigns`, { status: 200, body: { data: [] } })
      .on(`GET /tenants/${TENANT}/saved-views?resource=conversations`, { status: 200, body: { data: [] } });
    handle = mount({
      root: mountRoot(),
      host: createHost('#/inbox'),
      now: NOW,
      fetch: api.fetch,
      readCsrfToken: () => 'csrf-token',
      openEventSource: () => ({ addEventListener: () => undefined, close: () => undefined }),
    });
    await settle();
    // The two inbox lists, durable saved views and the compact picker catalogues.
    // These ID-backed values are fetched up front so operators never have to
    // paste a raw identifier into an Inbox filter.
    expect(api.calls.map((call) => call.path)).toEqual([
      '/auth/session',
      '/me/memberships',
      `/tenants/${TENANT}/conversations/unassigned`,
      `/tenants/${TENANT}/conversations?queue=mine`,
      `/tenants/${TENANT}/labels`,
      `/tenants/${TENANT}/custom-fields`,
      `/tenants/${TENANT}/saved-views?resource=conversations`,
      `/tenants/${TENANT}/people`,
      `/tenants/${TENANT}/teams`,
      `/tenants/${TENANT}/channels`,
      `/tenants/${TENANT}/campaigns`,
      `/tenants/${TENANT}/notifications/unread-count`,
    ]);
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

    fillInvite(root, 'tarek@digital-school.example');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.headers['x-csrf-token']).toBeUndefined();
    // A key is still sent — the API refuses a keyless mutation — it is just
    // not the deterministic one the other tests inject.
    expect(post?.headers['idempotency-key']).toMatch(/^\d+-\d+$/);
  });

  it('says the server cannot be reached when no transport is configured at all', async () => {
    const root = mountRoot();
    handle = mount({ root, host: createHost(), now: NOW });
    handle.dispatch('lang', 'en');
    await settle();
    expect(text(root)).toContain('Can’t reach the server');
    expect(root.querySelector('[data-act="live-session-retry"]')).not.toBeNull();
    // Not a sign-in form: nobody can say yet whether there is a session.
    expect(root.querySelector('#signin-email, .nav')).toBeNull();
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
    app.dispatch('live-test-channel', 'cn-1');
    app.dispatch('live-reload');
    app.dispatch('live-channels-reload');
    app.dispatch('live-sessions-reload');
    await settle();
    expect(api.calls.length).toBe(before);
    expect(app.state.toasts).toHaveLength(0);
  });

  it('reports a membership list that could not be read rather than claiming there is none', async () => {
    const api = signedInApi().on('GET /me/memberships', {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Later.', request_id: 'r-5' } },
    });
    const { root } = start(api);
    await settle();
    expect(text(root)).toContain('The service is temporarily unavailable');
    expect(text(root)).toContain('Request ID: r-5');
    expect(text(root)).not.toContain('No active workspace');

    api.on('GET /me/memberships', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    click(root, '[data-act="live-session-retry"]');
    await settle();
    expect(root.querySelector('#signin-email')).not.toBeNull();
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

    const root = find(document, '#app') as HTMLElement;
    fillInvite(root, 'tarek@digital-school.example');
    click(root, '.dialog [data-act="live-invite"]');
    await settle();

    expect(api.calls.find((call) => call.method === 'POST')?.headers['x-csrf-token']).toBe(
      'cookie-token',
    );
  });
});

/* ----------------------------------------------------------------- settings -- */

describe('the Settings screen', () => {
  const current = {
    id: 's-now',
    created_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
    current: true,
  };
  const other = { ...current, id: 's-old', current: false };

  function settingsApi(): FakeApi {
    return signedInApi().on('GET /auth/sessions', { status: 200, body: { data: [current, other] } });
  }

  it('lists this person’s sessions and offers to end only the other ones', async () => {
    const { root } = start(settingsApi(), '#/settings');
    await settle();
    expect(text(find(root, '[data-session="s-now"]'))).toContain('This browser');
    expect(root.querySelector('[data-session="s-now"] [data-act="live-revoke-session"]')).toBeNull();
    expect(root.querySelector('[data-session="s-old"] [data-act="live-revoke-session"]')).not.toBeNull();
    // The account facts come from the session and membership the server sent.
    expect(text(root)).toContain('owner@digital-school.example');
    expect(text(root)).toContain('Digital School');
  });

  it('ends another session only after the server confirms, then re-reads the list', async () => {
    const api = settingsApi().on('DELETE /auth/sessions/s-old', { status: 204, body: null });
    const release = api.hold('DELETE /auth/sessions/s-old');
    const { app, root } = start(api, '#/settings');
    await settle();

    click(root, '[data-session="s-old"] [data-act="live-revoke-session"]');
    await settle();
    expect(find(root, '[data-session="s-old"] [data-act="live-revoke-session"]').getAttribute('aria-busy')).toBe('true');
    expect(app.state.toasts).toHaveLength(0);

    api.on('GET /auth/sessions', { status: 200, body: { data: [current] } });
    release({ status: 204, body: null });
    await settle();
    expect(toasts(app)).toEqual(['Session ended']);
    expect(root.querySelector('[data-session="s-old"]')).toBeNull();
    expect(api.calls.filter((call) => call.path === '/auth/sessions')).toHaveLength(2);
  });

  it('shows a refused revoke beside the list and keeps the session listed', async () => {
    const api = settingsApi().on('DELETE /auth/sessions/s-old', {
      status: 404,
      body: { error: { code: 'resource_not_found', message: 'No such session.', request_id: 'r-3' } },
    });
    const { app, root } = start(api, '#/settings');
    await settle();
    click(root, '[data-act="live-revoke-session"]');
    await settle();
    expect(text(root)).toContain('Not found or not available to you');
    expect(root.querySelector('[data-session="s-old"]')).not.toBeNull();
    expect(app.state.toasts).toHaveLength(0);
  });

  it('offers a retry when the sessions could not be read', async () => {
    const api = signedInApi().on('GET /auth/sessions', () => {
      throw new Error('offline');
    });
    const { root } = start(api, '#/settings');
    await settle();
    expect(text(root)).toContain('Can’t reach the server');
    api.on('GET /auth/sessions', { status: 200, body: { data: [current] } });
    click(root, '[data-act="live-sessions-reload"]');
    await settle();
    expect(root.querySelector('[data-session="s-now"]')).not.toBeNull();
  });
});

/* ----------------------------------------------------------------- channels -- */

describe('the Channels screen', () => {
  function openChannels(api: FakeApi): { app: AppHandle; root: HTMLElement } {
    return start(api, '#/channels');
  }

  /** Expands one connected integration's details. */
  function expand(root: HTMLElement, id = 'cn-1'): Element {
    click(root, `[data-act="connection-toggle"][data-arg="${id}"]`);
    return find(root, `[data-connection="${id}"]`);
  }

  function fillConnect(root: HTMLElement, fields: Record<string, string>): void {
    for (const [id, value] of Object.entries(fields)) type(root, `#${id}`, value);
  }

  it('loads connections, the catalogue and the test allowlist, and only those', async () => {
    const api = channelApi();
    const { root } = openChannels(api);
    await settle();

    expect(text(find(root, '[data-connection="cn-1"]'))).toContain('Enrollment line');
    // Opening Channels does not fetch the People lists: each screen loads what
    // it shows.
    expect(api.calls.some((call) => call.path.endsWith('/people'))).toBe(false);
    expect(api.calls.map((call) => call.path).slice(2)).toEqual([
      `/tenants/${TENANT}/channels`,
      `/tenants/${TENANT}/channels/catalogue`,
      `/tenants/${TENANT}/channels/cn-1/test-recipients`,
      `/tenants/${TENANT}/notifications/unread-count`,
    ]);
  });

  it('does not read the allowlist of a disconnected connection, which has none', async () => {
    // Nothing scripts cn-2's allowlist: asking for it would fail the test.
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: { data: [channelDelivery(), channelDelivery({ id: 'cn-9', display_name: 'Old line', disconnected_at: NOW.toISOString() })] },
    });
    const { app } = openChannels(api);
    await settle();
    expect(api.calls.some((call) => call.path.includes('/cn-9/'))).toBe(false);
    expect(app.state.live.testRecipients.status).toBe('ready');
  });

  it('treats an allowlist that could not be read as unknown, not as empty', async () => {
    const api = channelApi()
      .on(`GET /tenants/${TENANT}/channels`, {
        status: 200,
        body: { data: [channelDelivery(), channelDelivery({ id: 'cn-2', display_name: 'Second line' })] },
      })
      .on(`GET /tenants/${TENANT}/channels/cn-2/test-recipients`, {
        status: 403,
        body: { error: { code: 'permission_denied', message: 'No.' } },
      });
    const { app } = openChannels(api);
    await settle();
    expect(app.state.live.testRecipients.status).toBe('error');
  });

  it('draws the six integrations, each with its standing and next step', async () => {
    const { root } = openChannels(channelApi());
    await settle();

    const kinds = [...root.querySelectorAll('[data-channel-kind]')].map((card) =>
      card.getAttribute('data-channel-kind'),
    );
    expect(kinds).toEqual(['whatsapp', 'messenger', 'instagram', 'web_chat', 'telegram', 'custom']);

    const whatsapp = find(root, '[data-channel-kind="whatsapp"]');
    // One number is still waiting for its credential, so the card makes the
    // in-progress connection explicit and never calls it "Connected".
    expect(whatsapp.querySelector('.badge')?.textContent).toBe('Connecting');
    expect(whatsapp.querySelector('[data-act="channel-manage"][data-arg="whatsapp:cn-1"]')).not.toBeNull();
    expect(whatsapp.querySelector('[data-arg="connect-channel:whatsapp"]')).not.toBeNull();
    // Its capabilities are the server's matrix, not a brochure.
    for (const capability of ['Messages', 'Templates', 'Media', 'Receipts', 'Webhooks']) {
      expect(text(whatsapp)).toContain(capability);
    }

    const web = find(root, '[data-channel-kind="web_chat"]');
    expect(text(web)).toContain('Not connected');
    expect(text(web)).not.toContain('Templates');
    expect(web.querySelector('[data-arg="connect-channel:web_chat"]')).not.toBeNull();
  });

  it('shows an integration this build cannot serve as coming soon, with nothing to press', async () => {
    const { root } = openChannels(channelApi());
    await settle();

    for (const kind of ['instagram', 'telegram', 'messenger']) {
      const card = find(root, `[data-channel-kind="${kind}"]`);
      expect(text(card)).toContain('Coming soon');
      expect(card.querySelector('[data-act="dialog"], [data-act="channel-manage"]')).toBeNull();
      expect((card.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('opens the connection a card points at, and focuses it', async () => {
    const { app, root } = openChannels(channelApi());
    await settle();
    click(root, '[data-act="channel-manage"][data-arg="whatsapp:cn-1"]');
    expect(app.state.expandedConnection).toBe('cn-1');
    expect(root.querySelector('[data-connection="cn-1"] .connection__details')).not.toBeNull();
  });

  it('renders a first-party connection without inventing a Meta app', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: {
        data: [
          channelDelivery({
            kind: 'web_chat',
            provider: 'web_chat',
            provider_app_id: null,
            external_asset_id: 'website-1',
            capabilities: WEB_CHAT_MATRIX,
          }),
        ],
      },
    });
    const { root } = openChannels(api);
    await settle();

    const card = expand(root);
    expect(text(card)).toContain('Website chat');
    expect(text(card)).toContain('website-1');
    expect(text(card)).not.toContain('Meta app');
    // Our own channel obeys no provider window, which is different from a
    // window of zero hours.
    expect(text(card)).toContain('Reply windowNone');
  });

  it('shows the separate evidence behind a state, not just the state', async () => {
    const { root } = openChannels(channelApi());
    await settle();

    const card = find(root, '[data-connection="cn-1"]');
    expect(text(card)).toContain('Verification needed');
    expect(text(card)).toContain('1 of 5 checks');

    expand(root);
    const details = find(root, '[data-connection="cn-1"] .connection__details');
    expect(text(details)).toContain('Asset registered');
    expect(text(details)).toContain('Credential accepted');
    expect(text(details)).toContain('First inbound message');
    // Exactly one of the five is satisfied, and the screen says which.
    expect(details.querySelectorAll('.checklist__item--done')).toHaveLength(1);
    expect(details.querySelectorAll('.checklist__item:not(.checklist__item--done)')).toHaveLength(4);
  });

  it('names an evidence kind this build does not know, rather than hiding it', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: {
        data: [
          channelDelivery({
            evidence: [{ kind: 'quota_confirmed', satisfied: false, observed_at: null }],
          }),
        ],
      },
    });
    const { root } = openChannels(api);
    await settle();
    // A newer server naming a new piece of evidence is information, not noise.
    expect(text(expand(root))).toContain('quota_confirmed');
  });

  it('shows pending on the verify control and toasts only after the server answers', async () => {
    const api = channelApi();
    const release = api.hold(`POST /tenants/${TENANT}/channels/cn-1/test`);
    const { app, root } = openChannels(api);
    await settle();

    expand(root);
    click(root, '[data-act="live-test-channel"]');
    await settle();
    expect(find(root, '[data-act="live-test-channel"]').getAttribute('aria-busy')).toBe('true');
    expect(isDisabled(root, '[data-act="live-test-channel"]')).toBe(true);
    expect(app.state.toasts).toHaveLength(0);

    release({
      status: 200,
      body: { data: channelDelivery({ last_error_code: 'provider_not_connected' }) },
    });
    await settle();
    // The server's own reason, in words. Not a success this screen invents.
    expect(toasts(app)).toEqual(['The provider refused: Provider not connected']);
  });

  it('reports the provider accepting a credential, and shows the state the server re-reads', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels/cn-1/test`, {
      status: 200,
      body: { data: channelDelivery({ status: 'webhook_pending' }) },
    });
    const { app, root } = openChannels(api);
    await settle();

    api.on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: {
        data: [
          channelDelivery({
            status: 'webhook_pending',
            evidence: [
              { kind: 'asset_verified', satisfied: true, observed_at: NOW.toISOString() },
              { kind: 'credential_verified', satisfied: true, observed_at: NOW.toISOString() },
              { kind: 'webhook_subscribed', satisfied: false, observed_at: null },
              { kind: 'first_inbound', satisfied: false, observed_at: null },
              { kind: 'first_outbound', satisfied: false, observed_at: null },
            ],
          }),
        ],
      },
    });
    expand(root);
    click(root, '[data-act="live-test-channel"]');
    await settle();

    expect(toasts(app)).toContain('The provider accepted the credential');
    // Re-read from the server, and still not healthy: evidence is still missing.
    const card = find(root, '[data-connection="cn-1"]');
    expect(text(card)).toContain('Waiting for first event');
    expect(text(card)).toContain('2 of 5 checks');
    // The card now knows when a credential was last accepted.
    expect(text(find(root, '[data-channel-kind="whatsapp"]'))).not.toContain('Last verified—');
  });

  it('shows the last error the server recorded', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: { data: [channelDelivery({ status: 'degraded', last_error_code: 'token_expired' })] },
    });
    const { root } = openChannels(api);
    await settle();
    expect(text(find(root, '[data-connection="cn-1"]'))).toContain('Needs attention');
    expect(text(expand(root))).toContain('Last error: token_expired');
  });

  it('connects an asset through the dialog and never keeps the token', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels`, {
      status: 201,
      body: { data: channelDelivery({ id: 'cn-2', display_name: 'Support line' }) },
    });
    const { app, root } = openChannels(api);
    await settle();

    click(root, '[data-channel-kind="whatsapp"] [data-arg="connect-channel:whatsapp"]');
    const dialog = find(root, '.dialog');
    expect(text(dialog)).toContain('Connect WhatsApp Business');
    // The Meta asset is named the way Meta names it.
    expect(text(dialog)).toContain('Phone Number ID');
    fillConnect(root, {
      'channel-app': '100000000000001',
      'channel-asset': 'phone-2',
      'channel-name': 'Support line',
      'channel-token': 'EAAGtoken0001',
    });

    api.on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: { data: [channelDelivery(), channelDelivery({ id: 'cn-2', display_name: 'Support line' })] },
    });
    click(root, '.dialog [data-act="live-connect-channel"]');
    await settle();

    const post = api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/channels'));
    expect(post?.body).toEqual({
      kind: 'whatsapp',
      externalAssetId: 'phone-2',
      displayName: 'Support line',
      accessToken: 'EAAGtoken0001',
      providerAppId: '100000000000001',
    });
    expect(post?.headers['idempotency-key']).toBe('key-1');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token');
    // The toast says what actually happened: added, and not yet working.
    expect(toasts(app)).toEqual(['Support line added. Verify the connection to finish setup.']);
    expect(app.state.dialogForm['channelToken']).toBeUndefined();
    expect(root.querySelector('.dialog')).toBeNull();
    // The new connection is opened, so the next step is in front of them.
    expect(root.querySelector('[data-connection="cn-2"] .connection__details')).not.toBeNull();
  });

  it('checks the connect form before sending anything', async () => {
    const api = channelApi();
    const { root } = openChannels(api);
    await settle();

    click(root, '[data-arg="connect-channel:whatsapp"]');
    type(root, '#channel-token', 'short');
    click(root, '.dialog [data-act="live-connect-channel"]');
    await settle();

    const dialog = text(find(root, '.dialog'));
    expect(dialog).toContain('Enter the Meta App ID.');
    expect(dialog).toContain('Enter the asset ID.');
    expect(dialog).toContain('Enter a display name.');
    expect(dialog).toContain('Enter at least 8 characters.');
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('drops the token from the form even when the connect is refused', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels`, {
      status: 409,
      body: {
        error: { code: 'asset_already_connected', message: 'That provider asset is already connected.' },
      },
    });
    const { app, root } = openChannels(api);
    await settle();

    click(root, '[data-arg="connect-channel:whatsapp"]');
    fillConnect(root, {
      'channel-app': '100000000000001',
      'channel-asset': 'phone-taken',
      'channel-name': 'Taken',
      'channel-token': 'EAAGtoken0002',
    });
    click(root, '.dialog [data-act="live-connect-channel"]');
    await settle();

    expect(text(find(root, '.dialog'))).toContain('That provider asset is already connected.');
    expect(app.state.toasts).toHaveLength(0);
    // A credential left in a form field is a credential in a screenshot.
    expect(app.state.dialogForm['channelToken']).toBeUndefined();
    expect((find(root, '#channel-token') as HTMLInputElement).value).toBe('');
    // The others survive, so the attempt can be corrected.
    expect(app.state.dialogForm['channelAsset']).toBe('phone-taken');
  });

  it('shows what the server said about each field beside the connect form', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels`, {
      status: 400,
      body: {
        error: {
          code: 'invalid_input',
          message: 'The request is not valid.',
          details: [
            { field: 'externalAssetId', code: 'malformed', message: 'That is not an asset id.' },
          ],
        },
      },
    });
    const { root } = openChannels(api);
    await settle();
    click(root, '[data-arg="connect-channel:whatsapp"]');
    fillConnect(root, {
      'channel-app': '100000000000001',
      'channel-asset': 'nope',
      'channel-name': 'Bad',
      'channel-token': 'EAAGtoken0003',
    });
    click(root, '.dialog [data-act="live-connect-channel"]');
    await settle();
    const dialog = text(find(root, '.dialog'));
    expect(dialog).toContain('Check what you entered');
    expect(dialog).toContain('That is not an asset id.');
  });

  it('connects website chat without asking for a Meta app', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels`, {
      status: 201,
      body: {
        data: channelDelivery({ id: 'cn-2', kind: 'web_chat', provider: 'web_chat', provider_app_id: null }),
      },
    });
    const { app, root } = openChannels(api);
    await settle();

    click(root, '[data-arg="connect-channel:web_chat"]');
    expect(root.querySelector('#channel-app')).toBeNull();
    expect(text(find(root, 'label[for="channel-asset"]'))).toBe('Widget ID');
    expect(text(find(root, 'label[for="channel-token"]'))).toBe('Signing key');
    fillConnect(root, {
      'channel-asset': 'website-1',
      'channel-name': 'Website',
      'channel-token': 'signing-key-0001',
    });
    const origins = find(root, '#channel-origins') as HTMLTextAreaElement;
    origins.value = 'https://school.example';
    origins.dispatchEvent(new window.Event('input', { bubbles: true }));
    click(root, '.dialog [data-act="live-connect-channel"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/channels'))?.body).toEqual({
      kind: 'web_chat',
      externalAssetId: 'website-1',
      displayName: 'Website',
      accessToken: 'signing-key-0001',
      providerAppId: null,
      settings: { origins: ['https://school.example'] },
    });
    expect(app.state.channelKind).toBe('web_chat');
  });

  it('refuses to connect Telegram, which this build does not implement', async () => {
    const api = channelApi();
    const { app, root } = openChannels(api);
    await settle();
    const before = api.calls.length;

    app.dispatch('dialog', 'connect-channel:telegram');
    expect(text(find(root, '.dialog'))).toContain('This channel is not supported in this version.');
    expect(root.querySelector('.dialog [data-act="live-connect-channel"]')).toBeNull();
    // Even a stale dispatch sends nothing.
    app.state.dialogForm = { channelAsset: 'bot', channelName: 'Bot', channelToken: 'token-0001' };
    app.dispatch('live-connect-channel');
    // And with no dialog open at all, there is no kind to connect.
    app.dispatch('close-dialog');
    app.state.dialogForm = { channelAsset: 'phone', channelName: 'Line', channelToken: 'token-0001' };
    app.dispatch('live-connect-channel');
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('rotates a credential and clears its field', async () => {
    const api = channelApi().on(`POST /tenants/${TENANT}/channels/cn-1/credential`, {
      status: 200,
      body: { data: channelDelivery({ credential_fingerprint: 'a'.repeat(64) }) },
    });
    const { app, root } = openChannels(api);
    await settle();

    expand(root);
    expect(isDisabled(root, '[data-act="live-rotate-channel"]')).toBe(true);
    type(root, '[data-form="channelToken_cn-1"]', 'EAAGrotated0001');
    expect(isDisabled(root, '[data-act="live-rotate-channel"]')).toBe(false);
    click(root, '[data-act="live-rotate-channel"]');
    await settle();

    expect(api.calls.find((call) => call.path.endsWith('/credential'))?.body).toEqual({
      accessToken: 'EAAGrotated0001',
    });
    expect(toasts(app)).toContain('The new credential is stored — test it to prove it works');
    expect(app.state.dialogForm['channelToken_cn-1']).toBeUndefined();
  });

  it('confirms a disconnect, then shows the connection as disconnected rather than hiding it', async () => {
    const api = channelApi().on(`DELETE /tenants/${TENANT}/channels/cn-1`, {
      status: 204,
      body: null,
    });
    const { app, root } = openChannels(api);
    await settle();

    expand(root);
    click(root, '[data-arg="disconnect-channel:cn-1"]');
    // Opening the confirmation sends nothing.
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(text(find(root, '.dialog'))).toContain('revokes its stored credential');

    api.on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: {
        data: [channelDelivery({ status: 'disconnected', disconnected_at: NOW.toISOString() })],
      },
    });
    click(root, '.dialog [data-act="live-disconnect-channel"]');
    await settle();

    expect(toasts(app)).toContain('Disconnected, and its credentials revoked');
    expect(root.querySelector('.dialog')).toBeNull();
    const card = find(root, '[data-connection="cn-1"]');
    expect(text(card)).toContain('Disconnected');
    expect(text(card)).toContain('Its history is kept');
    // No controls on a disconnected connection: there is nothing to verify or
    // rotate.
    expect(root.querySelector('[data-act="live-test-channel"]')).toBeNull();
    expect(text(find(root, '[data-channel-kind="whatsapp"]'))).toContain('Disconnected');

    // A stale confirmation for it says so instead of offering the button again.
    app.dispatch('dialog', 'disconnect-channel:cn-1');
    expect(text(find(root, '.dialog'))).toContain('no longer active');
  });

  it('keeps the confirmation open when a disconnect is refused', async () => {
    const api = channelApi().on(`DELETE /tenants/${TENANT}/channels/cn-1`, {
      status: 409,
      body: { error: { code: 'campaign_running', message: 'A campaign is still sending on it.' } },
    });
    const { app, root } = openChannels(api);
    await settle();
    app.dispatch('dialog', 'disconnect-channel:cn-1');
    click(root, '.dialog [data-act="live-disconnect-channel"]');
    await settle();
    expect(text(find(root, '.dialog'))).toContain('A campaign is still sending on it.');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('filters the connected list by channel once there is more than one kind', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 200,
      body: {
        data: [
          channelDelivery(),
          channelDelivery({ id: 'cn-2', kind: 'web_chat', display_name: 'Website', capabilities: WEB_CHAT_MATRIX }),
        ],
      },
    });
    const { root } = openChannels(api);
    await settle();
    expect(root.querySelectorAll('[data-connection]')).toHaveLength(2);
    click(root, '.connections [data-act="channel-kind"][data-arg="web_chat"]');
    expect([...root.querySelectorAll('[data-connection]')].map((row) => row.getAttribute('data-connection'))).toEqual(['cn-2']);
  });

  it('reports a refused channel list as a permission state', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'Denied.' } },
    });
    const { root } = openChannels(api);
    await settle();
    expect(text(find(root, '.errorstate--denied'))).toContain('You don’t have permission for this');
    // No card claims "Not connected" without the company's connections.
    expect(root.querySelector('[data-channel-kind]')).toBeNull();
  });

  it('separates an unreachable server from a rejection, and offers a retry that works', async () => {
    const api = channelApi();
    api.on(`GET /tenants/${TENANT}/channels/catalogue`, () => {
      throw new Error('connection refused');
    });
    const { root } = openChannels(api);
    await settle();
    expect(text(root)).toContain('Can’t reach the server');

    api.on(`GET /tenants/${TENANT}/channels/catalogue`, { status: 200, body: { data: [] } });
    click(root, '.errorstate [data-act="live-channels-reload"]');
    await settle();
    expect(root.querySelector('[data-channel-kind="whatsapp"]')).not.toBeNull();
  });

  it('marks the lists busy until they land, then says there is nothing yet', async () => {
    const api = channelApi();
    const release = api.hold(`GET /tenants/${TENANT}/channels`);
    const { root } = openChannels(api);
    await settle();
    expect(root.querySelector('.integration--loading [aria-busy="true"]')).not.toBeNull();
    release({ status: 200, body: { data: [] } });
    await settle();
    expect(text(root)).toContain('No channels connected yet');
    expect(text(find(root, '[data-channel-kind="whatsapp"]'))).toContain('Not connected');
  });

  it('speaks Arabic by default here too', async () => {
    const root = mountRoot();
    handle = mount({
      root,
      host: createHost('#/channels'),
      now: NOW,
      fetch: channelApi().fetch,
      readCsrfToken: () => 'csrf-token',
    });
    await settle();
    expect(text(find(root, '.header__title'))).toBe('القنوات');
    expect(text(root)).toContain('بانتظار التحقق');
  });

  it('closes the workspace when the channel list says the session has ended', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, NO_SESSION);
    const { root } = openChannels(api);
    await settle();
    expect(text(root)).toContain('Your session ended');
    expect(root.querySelector('[data-channel-kind]')).toBeNull();
  });

  it('quotes the request id on a server failure', async () => {
    const api = channelApi().on(`GET /tenants/${TENANT}/channels`, {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Something broke.', request_id: 'r-91' } },
    });
    const { root } = openChannels(api);
    await settle();
    expect(text(root)).toContain('The server couldn’t complete this');
    expect(text(root)).toContain('Request ID: r-91');
  });

  it('moves between server-backed screens without re-probing the session', async () => {
    const api = channelApi();
    const { app, root } = openChannels(api);
    await settle();
    const probes = api.calls.filter((call) => call.path === '/auth/session').length;

    app.dispatch('nav', 'people');
    await settle();
    expect(root.querySelector(`tr[data-membership="${MEMBERSHIP}"]`)).not.toBeNull();
    expect(api.calls.filter((call) => call.path === '/auth/session')).toHaveLength(probes);
  });
});
