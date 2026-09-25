/**
 * @vitest-environment happy-dom
 */
import { BUILTIN_ROLES } from '@convo/domain';
import type { BuiltinRoleKey } from '@convo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/client.js';
import type { AppHandle } from '../app.js';
import { mount } from '../app.js';
import type { RouterHost } from '../router.js';
import { currentMembership, ROUTING_GRANTS, routingAbility } from './ability.js';
import type { EventSourceLike } from './realtime.js';

/**
 * Work routing, through the real client, actions and renderer.
 *
 * The first test is the one that matters most: the browser holds a copy of who
 * may assign and who may only ask, and it is regenerated here from
 * `BUILTIN_ROLES` rather than eyeballed. Everything after it is what an
 * operator sees — a request that does not move the conversation, a refusal in
 * their words with the id to quote, and a thread that clears itself when it is
 * no longer theirs to read.
 */

const NOW = new Date('2026-09-10T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ME = '44444444-4444-4444-8444-444444444444';
const LAYLA = '55555555-5555-4555-8555-555555555555';
const OMAR = '66666666-6666-4666-8666-666666666666';
const OFFER = '77777777-7777-4777-8777-777777777777';

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

class FakeApi {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  private readonly routes = new Map<string, Reply | (() => Reply)>();

  on(key: string, reply: Reply | (() => Reply)): this {
    this.routes.set(key, reply);
    return this;
  }

  bodyOf(key: string): Record<string, unknown> | undefined {
    return this.calls.filter((c) => `${c.method} ${c.path}` === key).at(-1)?.body as
      | Record<string, unknown>
      | undefined;
  }

  countOf(key: string): number {
    return this.calls.filter((c) => `${c.method} ${c.path}` === key).length;
  }

  readonly fetch: FetchLike = (url, init) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '');
    this.calls.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = this.routes.get(`${method} ${path}`);
    if (route === undefined) {
      throw new Error(`the test did not script ${method} ${path}`);
    }
    const reply = typeof route === 'function' ? route() : route;
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

class FakeStream implements EventSourceLike {
  static last: FakeStream | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor() {
    FakeStream.last = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    // Nothing to close.
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

function streamEvent(type: string): unknown {
  return {
    schemaVersion: 1,
    id: `e-${type}`,
    seq: 9,
    type,
    entity: { type: 'conversation', id: CONVERSATION, version: 5 },
    scope: { conversationId: CONVERSATION, inboxId: 'cn-1', teamId: null, assigneeMembershipId: ME },
    occurredAt: NOW.toISOString(),
    payload: {},
    cursor: 'cursor-9',
  };
}

function createHost(hash: string): RouterHost {
  let current = hash;
  return {
    location: {
      get hash(): string {
        return current;
      },
      set hash(next: string) {
        current = next;
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONVERSATION,
    connectionId: 'cn-1',
    peerIdentity: '15559998888',
    teamId: null,
    assigneeMembershipId: ME,
    status: 'open',
    priority: 'normal',
    version: 4,
    waitingSince: null,
    inboxLabel: 'خط التسجيل',
    channel: 'whatsapp',
    participantMembershipIds: [ME],
    contactId: null,
    pendingReason: null,
    snoozedUntil: null,
    snoozeTimezone: null,
    resolution: null,
    resolvedAt: null,
    lastActivityAt: '2026-09-10T09:21:00.000Z',
    ownerState: 'human_active',
    ownerVersion: 2,
    ...overrides,
  };
}

function offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OFFER,
    conversationId: CONVERSATION,
    fromMembershipId: ME,
    fromLabel: 'هَناء',
    toMembershipId: LAYLA,
    toLabel: 'ليلى',
    state: 'pending',
    note: 'لديك خبرة بهذه الحالة',
    basedOnVersion: 4,
    createdAt: '2026-09-10T09:25:00.000Z',
    expiresAt: '2026-09-10T10:30:00.000Z',
    settledAt: null,
    settledByMembershipId: null,
    ...overrides,
  };
}

function page(rows: readonly unknown[]): Reply {
  return {
    status: 200,
    body: { data: rows, page: { next_cursor: null, has_more: false }, request_id: 'req-1' },
  };
}

/** A signed-in workspace with one open conversation and one colleague. */
function routingApi(
  roleKey = 'supervisor',
  record = conversation(),
  permissions: readonly string[] | null = permissionsFor(roleKey),
): FakeApi {
  return new FakeApi()
    .on('GET /auth/session', {
      status: 200,
      body: { data: { user: { id: 'u1', email: 'hana@digital-school.example' } } },
    })
    .on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: ME,
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: `${roleKey}-role`, key: roleKey, name: roleKey },
            ...(permissions === null ? {} : { permissions }),
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/conversations/unassigned`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/conversations?queue=mine`, { status: 200, body: { data: [record] } })
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, { status: 200, body: { data: record } })
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, page([]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/episodes`, page([]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`, page([]))
    .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/read`, {
      status: 200,
      body: { data: { readThrough: NOW.toISOString() } },
    })
    .on(`GET /tenants/${TENANT}/directory/agents?conversation_id=${CONVERSATION}`, {
      status: 200,
      body: {
        data: [
          { membershipId: ME, label: 'هَناء', assigned: true },
          { membershipId: LAYLA, label: 'ليلى', assigned: false },
          { membershipId: OMAR, label: 'عمر', assigned: false },
        ],
        page: { next_cursor: null, has_more: false },
        request_id: 'req-1',
      },
    });
}

function permissionsFor(roleKey: string): readonly string[] {
  const ability = ROUTING_GRANTS[roleKey];
  // Every role here reads its own conversations; the routing keys are what vary.
  return [
    'conversation.read',
    ...(ability?.mayAssign === true ? ['conversation.assign'] : []),
    ...(ability?.mayAsk === true ? ['conversation.handoff.request'] : []),
  ];
}

let handle: AppHandle | null = null;

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function open(
  api: FakeApi,
  hash = `#/inbox/${CONVERSATION}`,
): Promise<{ app: AppHandle; root: HTMLElement }> {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  FakeStream.last = null;
  const app = mount({
    root,
    host: createHost(hash),
    now: NOW,
    fetch: api.fetch,
    readCsrfToken: () => 'csrf-token',
    newKey: () => 'client-message-1',
    openEventSource: () => new FakeStream(),
  });
  handle = app;
  await settle();
  return { app, root };
}

function text(root: ParentNode): string {
  return (root as HTMLElement).textContent ?? '';
}

function click(root: ParentNode, selector: string): void {
  const target = root.querySelector(selector);
  if (target === null) throw new Error(`no element for ${selector}`);
  target.dispatchEvent(new window.Event('click', { bubbles: true }));
}

function choose(root: ParentNode, value: string): void {
  const select = root.querySelector('[data-act="live-routing-choice"]') as HTMLSelectElement | null;
  if (select === null) throw new Error('no assignee picker');
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function control(act: string, arg?: string): string {
  return `[data-act="${act}"]${arg === undefined ? '' : `[data-arg="${arg}"]`}`;
}

afterEach(() => {
  handle?.destroy();
  handle = null;
});

/* ------------------------------------------------------------------ drift -- */

describe('the routing controls the screen offers', () => {
  /**
   * The browser's copy of who may assign and who may only ask, regenerated from
   * the domain's role matrix. A control that would always be refused is worse
   * than a missing one — it teaches an operator the software is unreliable
   * rather than that they lack the authority.
   */
  it.each(Object.keys(BUILTIN_ROLES))('matches the role matrix for %s', (key) => {
    const grants = BUILTIN_ROLES[key as BuiltinRoleKey].grants;
    expect(ROUTING_GRANTS[key]).toEqual({
      mayAssign: grants['conversation.assign'] !== undefined,
      mayAsk: grants['conversation.handoff.request'] !== undefined,
    });
  });

  it('covers every built-in role', () => {
    expect(Object.keys(ROUTING_GRANTS).sort()).toEqual(Object.keys(BUILTIN_ROLES).sort());
  });

  it('is the clarification ADR-0017 exists for', () => {
    // An Agent may ask a colleague and may not reassign anybody. If this ever
    // reads otherwise, the matrix changed and the ADR has to change with it.
    expect(ROUTING_GRANTS['agent']).toEqual({ mayAssign: false, mayAsk: true });
    expect(ROUTING_GRANTS['supervisor']?.mayAssign).toBe(true);
    expect(ROUTING_GRANTS['analyst']).toEqual({ mayAssign: false, mayAsk: false });
  });
});

/* ------------------------------------------------------------- assignment -- */

describe('assigning a conversation', () => {
  it('offers assign, ask and priority to somebody who can route', async () => {
    const { root } = await open(routingApi());
    expect(root.querySelector(control('live-routing-open', 'assign'))).not.toBeNull();
    expect(root.querySelector(control('live-routing-open', 'handoff'))).not.toBeNull();
    expect(root.querySelector(control('live-routing-open', 'priority'))).not.toBeNull();
  });

  it('offers an Agent only the request', async () => {
    const { root } = await open(routingApi('agent'));
    // business-rules.md §7 denies an Agent "assign others / override routing",
    // and ADR-0017 gives them the handoff request instead.
    expect(root.querySelector(control('live-routing-open', 'assign'))).toBeNull();
    expect(root.querySelector(control('live-routing-open', 'priority'))).toBeNull();
    expect(root.querySelector(control('live-routing-open', 'handoff'))).not.toBeNull();
  });

  it('shows nothing at all to somebody who routes nothing', async () => {
    const { root } = await open(routingApi('analyst'));
    expect(root.querySelector('.routing')).toBeNull();
  });

  it('loads the colleagues only when the picker opens', async () => {
    const api = routingApi();
    const { root } = await open(api);
    const key = `GET /tenants/${TENANT}/directory/agents?conversation_id=${CONVERSATION}`;
    // A per-conversation list fetched for every thread somebody glances at
    // would be a request per glance.
    expect(api.countOf(key)).toBe(0);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    expect(api.countOf(key)).toBe(1);
  });

  it('sends the version the operator saw', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      { status: 200, body: { data: conversation({ assigneeMembershipId: LAYLA, version: 5 }) } },
    );
    const { app, root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-assign'));
    await settle();

    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`)).toEqual({
      version: 4,
      assigneeMembershipId: LAYLA,
    });
    expect(app.state.toasts.at(-1)?.text).toContain('أُسندت');
    // Redrawn from what the server returned, not from what was clicked.
    expect(text(root.querySelector('.routing__assignee') as HTMLElement)).toContain('ليلى');
  });

  it('leaves the person who already holds it out of the picker', async () => {
    const { root } = await open(routingApi());
    click(root, control('live-routing-open', 'assign'));
    await settle();
    const options = [
      ...(root.querySelectorAll('[data-act="live-routing-choice"] option') as unknown as HTMLOptionElement[]),
    ].map((option) => option.value);
    expect(options).not.toContain(ME);
    expect(options).toContain(LAYLA);
  });

  it('takes it off every desk as an operation, not a gap', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      { status: 200, body: { data: conversation({ assigneeMembershipId: null, version: 5 }) } },
    );
    const { root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    click(root, control('live-routing-unassign'));
    await settle();
    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`)).toEqual({
      version: 4,
      assigneeMembershipId: null,
    });
    expect(text(root.querySelector('.routing__assignee') as HTMLElement)).toContain('لا أحد بعد');
  });

  it('lets an agent release only their own assignment through the dedicated action', async () => {
    const api = routingApi('agent').on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/release`,
      { status: 200, body: { data: conversation({ assigneeMembershipId: null, version: 5 }) } },
    );
    const { root, app } = await open(api);
    expect(root.querySelector('[data-act="live-routing-open"][data-arg="assign"]')).toBeNull();
    click(root, control('live-routing-release-own'));
    await settle();
    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/release`)).toEqual({ version: 4 });
    expect(app.state.inboxQueue).toBe('unassigned');
    expect(app.state.route.conversationId).toBeNull();
    expect(root.querySelector('.routing__assignee')).toBeNull();
    expect(root.querySelector('[data-act="live-routing-release-own"]')).toBeNull();
  });

  it('marks only the operator’s conversation unread and refreshes the queue', async () => {
    const api = routingApi('agent').on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/unread`,
      { status: 200, body: { data: { unread: true } } },
    );
    const { root } = await open(api);
    click(root, control('live-inbox-mark-unread'));
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/unread`)).toBe(1);
    expect(api.countOf(`GET /tenants/${TENANT}/conversations?queue=mine`)).toBeGreaterThan(1);
  });

  it('says who lost the race, with the id to quote', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      {
        status: 409,
        body: {
          error: {
            code: 'conversation_version_conflict',
            message: 'stale',
            request_id: 'req-conflict',
          },
        },
      },
    );
    const { app, root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-assign'));
    await settle();

    const toast = app.state.toasts.at(-1)?.text ?? '';
    expect(toast).toContain('تغيّرت المحادثة');
    // Without the request id, "it failed" is not something anybody can look up.
    expect(toast).toContain('req-conflict');
    // Nothing was applied locally.
    expect(app.state.live.openConversation.status === 'ready').toBe(true);
  });

  it('reports an ineligible colleague as a fact about their access', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      {
        status: 422,
        body: {
          error: { code: 'assignee_not_eligible', message: 'no', request_id: 'req-eligible' },
        },
      },
    );
    const { app, root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, OMAR);
    await settle();
    click(root, control('live-routing-assign'));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('لم يعد بإمكان هذا الزميل');
  });

  it('will not send an assignment with nobody chosen', async () => {
    const api = routingApi();
    const { root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    const confirm = root.querySelector(control('live-routing-assign')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    click(root, control('live-routing-assign'));
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`)).toBe(0);
  });

  it('says so when nobody else can take it', async () => {
    const api = routingApi().on(
      `GET /tenants/${TENANT}/directory/agents?conversation_id=${CONVERSATION}`,
      page([{ membershipId: ME, label: 'هَناء', assigned: true }]),
    );
    const { root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    // A staffing fact somebody needs to see, not an empty control.
    expect(text(root.querySelector('.routing__form') as HTMLElement)).toContain('لا يوجد زميل متاح');
  });

  it('offers a retry when the colleagues could not be read', async () => {
    let attempts = 0;
    const api = routingApi().on(
      `GET /tenants/${TENANT}/directory/agents?conversation_id=${CONVERSATION}`,
      () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: 503,
              body: { error: { code: 'unavailable', message: 'No answer.', request_id: 'r' } },
            }
          : page([{ membershipId: LAYLA, label: 'ليلى', assigned: false }]);
      },
    );
    const { root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    expect(root.querySelector('.routing__form .errorstate')).not.toBeNull();
    click(root, `.routing__form ${control('live-routing-open', 'assign')}`);
    await settle();
    expect(root.querySelector('[data-act="live-routing-choice"]')).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- handoff -- */

describe('asking a colleague', () => {
  it('sends the request and says the conversation has not moved', async () => {
    const api = routingApi('agent')
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, {
        status: 201,
        body: { data: offer() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([offer()]));
    const { app, root } = await open(api);
    click(root, control('live-routing-open', 'handoff'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-ask'));
    await settle();

    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`)).toEqual({
      version: 4,
      toMembershipId: LAYLA,
      note: null,
    });
    expect(app.state.toasts.at(-1)?.text).toContain('ما زالت لديك');
  });

  it('carries the note that explains the request', async () => {
    const api = routingApi('agent')
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, {
        status: 201,
        body: { data: offer() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([offer()]));
    const { root } = await open(api);
    click(root, control('live-routing-open', 'handoff'));
    await settle();
    choose(root, LAYLA);
    const note = root.querySelector('.routing__note') as HTMLTextAreaElement;
    note.value = 'تكلّمت معها سابقًا';
    note.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    click(root, control('live-routing-ask'));
    await settle();
    expect(
      api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`)?.['note'],
    ).toBe('تكلّمت معها سابقًا');
  });

  it('shows a pending offer as waiting, not as a move', async () => {
    const api = routingApi('agent').on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
      page([offer()]),
    );
    const { root } = await open(api);
    const banner = root.querySelector('.routing__offer') as HTMLElement;
    expect(text(banner)).toContain('ليلى');
    expect(text(banner)).toContain('لديك خبرة بهذه الحالة');
    // The whole point: it is still this person's conversation.
    expect(text(banner)).toContain('تبقى المحادثة مع صاحبها');
    expect(text(root.querySelector('.routing__assignee') as HTMLElement)).toContain('أنت');
  });

  it('offers accept and decline only to the person who was asked', async () => {
    const mine = routingApi('agent').on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
      page([offer({ toMembershipId: ME, toLabel: 'هَناء', fromMembershipId: LAYLA })]),
    );
    const asked = await open(mine);
    expect(asked.root.querySelector(control('live-handoff-settle', `${OFFER}:accept`))).not.toBeNull();
    expect(asked.root.querySelector(control('live-handoff-settle', `${OFFER}:cancel`))).toBeNull();
    handle?.destroy();

    const theirs = routingApi('agent').on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
      page([offer()]),
    );
    const asking = await open(theirs);
    // The requester gets the withdrawal, not an answer: answering on somebody's
    // behalf is not an answer.
    expect(asking.root.querySelector(control('live-handoff-settle', `${OFFER}:accept`))).toBeNull();
    expect(asking.root.querySelector(control('live-handoff-settle', `${OFFER}:cancel`))).not.toBeNull();
  });

  it('accepts an offer and re-reads what the server now says', async () => {
    const settled = offer({ toMembershipId: ME, toLabel: 'هَناء', fromMembershipId: LAYLA });
    let accepted = false;
    const api = routingApi('agent')
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/accept`, () => {
        accepted = true;
        return { status: 200, body: { data: { ...settled, state: 'accepted' } } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, () =>
        page([accepted ? { ...settled, state: 'accepted' } : settled]),
      );
    const { app, root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:accept`));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('استلمت المحادثة');
    // The banner is gone because the offer is settled, not because the browser
    // hid it.
    expect(root.querySelector('.routing__offer')).toBeNull();
  });

  it('reports a request somebody else answered first', async () => {
    const api = routingApi('agent')
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([offer()]))
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/cancel`, {
        status: 409,
        body: {
          error: { code: 'handoff_not_pending', message: 'settled', request_id: 'req-late' },
        },
      });
    const { app, root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:cancel`));
    await settle();
    const toast = app.state.toasts.at(-1)?.text ?? '';
    expect(toast).toContain('أُجيب على هذا الطلب');
    expect(toast).toContain('req-late');
  });

  it('reports an offer the conversation has outrun', async () => {
    const api = routingApi('agent')
      .on(
        `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
        page([offer({ toMembershipId: ME, fromMembershipId: LAYLA })]),
      )
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/accept`, {
        status: 409,
        body: {
          error: { code: 'handoff_superseded', message: 'moved', request_id: 'req-moved' },
        },
      });
    const { app, root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:accept`));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('انتقلت المحادثة إلى شخص آخر');
  });

  it('refuses to ask with nobody chosen', async () => {
    const api = routingApi('agent');
    const { root } = await open(api);
    click(root, control('live-routing-open', 'handoff'));
    await settle();
    click(root, control('live-routing-ask'));
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`)).toBe(0);
  });
});

/* --------------------------------------------------- priority and helpers -- */

describe('priority and collaborators', () => {
  it('changes priority through the four real values', async () => {
    const api = routingApi().on(`PATCH /tenants/${TENANT}/conversations/${CONVERSATION}/priority`, {
      status: 200,
      body: { data: conversation({ priority: 'urgent', version: 5 }) },
    });
    const { root } = await open(api);
    click(root, control('live-routing-open', 'priority'));
    await settle();
    const choices = root.querySelectorAll('[data-act="live-routing-priority"]');
    expect(choices).toHaveLength(4);
    click(root, control('live-routing-priority', 'urgent'));
    await settle();
    expect(api.bodyOf(`PATCH /tenants/${TENANT}/conversations/${CONVERSATION}/priority`)).toEqual({
      version: 4,
      priority: 'urgent',
    });
  });

  it('sends nothing for the priority it already has', async () => {
    const api = routingApi();
    const { root } = await open(api);
    click(root, control('live-routing-open', 'priority'));
    await settle();
    click(root, control('live-routing-priority', 'normal'));
    await settle();
    expect(api.countOf(`PATCH /tenants/${TENANT}/conversations/${CONVERSATION}/priority`)).toBe(0);
  });

  it('marks a helper who actually took part, and says what removal keeps', async () => {
    const api = routingApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`,
      page([
        {
          membershipId: LAYLA,
          label: 'ليلى',
          addedAt: '2026-09-10T09:00:00.000Z',
          participated: true,
        },
      ]),
    );
    const { root } = await open(api);
    const row = root.querySelector('.routing__collab') as HTMLElement;
    expect(text(row)).toContain('ليلى');
    expect(text(row)).toContain('شارك بالفعل');
    const end = row.querySelector(control('live-collaborator-remove', LAYLA)) as HTMLElement;
    // Removal ends future access; it does not erase what they wrote, and the
    // control says which half survives.
    expect(end.getAttribute('title')).toContain('ما كتبه يبقى');
  });

  it('invites and removes through the server', async () => {
    const api = routingApi()
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`, {
        status: 200,
        body: {
          data: [
            {
              membershipId: LAYLA,
              label: 'ليلى',
              addedAt: NOW.toISOString(),
              participated: false,
            },
          ],
          page: { next_cursor: null, has_more: false },
          request_id: 'r',
        },
      })
      .on(
        `DELETE /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators/${LAYLA}?version=4`,
        page([]),
      );
    const { root } = await open(api);
    click(root, control('live-routing-open', 'collaborators'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-collaborator-add'));
    await settle();
    expect(
      api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`),
    ).toEqual({ version: 4, membershipId: LAYLA });

    click(root, control('live-collaborator-remove', LAYLA));
    await settle();
    expect(
      api.countOf(
        `DELETE /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators/${LAYLA}?version=4`,
      ),
    ).toBe(1);
  });
});

/* ------------------------------------------------------- edges and drafts -- */

describe('the edges of the routing surface', () => {
  it('says who holds it even before the directory has loaded', async () => {
    const api = routingApi('supervisor', conversation({ assigneeMembershipId: LAYLA })).on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`,
      page([
        { membershipId: LAYLA, label: 'ليلى', addedAt: NOW.toISOString(), participated: false },
      ]),
    );
    const { root } = await open(api);
    // The picker has not been opened, so the name comes from the collaborator
    // list instead of the id.
    expect(text(root.querySelector('.routing__assignee') as HTMLElement)).toContain('ليلى');
  });

  it('says "a colleague" when nothing has named them yet', async () => {
    const { root } = await open(routingApi('supervisor', conversation({ assigneeMembershipId: OMAR })));
    // Honest rather than blank, and never a raw membership id: an id means
    // nothing to an operator.
    const assignee = text(root.querySelector('.routing__assignee') as HTMLElement);
    expect(assignee).toContain('زميل في الفريق');
    expect(assignee).not.toContain(OMAR);
  });

  it('shows an offer with no note, and one on a conversation nobody holds', async () => {
    const api = routingApi(
      'supervisor',
      conversation({ assigneeMembershipId: null }),
    ).on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
      page([offer({ note: null })]),
    );
    const { root } = await open(api);
    const banner = root.querySelector('.routing__offer') as HTMLElement;
    expect(banner.querySelector('.routing__offernote')).toBeNull();
    expect(text(banner)).toContain('لم تُسند بعد');
  });

  it('shows a helper to an Agent without offering them controls they lack', async () => {
    const api = routingApi('agent').on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`,
      page([
        { membershipId: LAYLA, label: 'ليلى', addedAt: NOW.toISOString(), participated: false },
      ]),
    );
    const { root } = await open(api);
    expect(text(root.querySelector('.routing__collab') as HTMLElement)).toContain('ليلى');
    // Seeing who is helping is not authority to change it.
    expect(root.querySelector(control('live-collaborator-remove', LAYLA))).toBeNull();
    expect(root.querySelector(control('live-routing-open', 'collaborators'))).toBeNull();
  });

  it('says a helper who never acted simply loses access', async () => {
    const api = routingApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/collaborators`,
      page([
        { membershipId: LAYLA, label: 'ليلى', addedAt: NOW.toISOString(), participated: false },
      ]),
    );
    const { root } = await open(api);
    const end = root.querySelector(control('live-collaborator-remove', LAYLA)) as HTMLElement;
    expect(end.getAttribute('title')).toContain('ينتهي وصولهم');
  });

  it('draws no form for a control this person cannot see', async () => {
    const { app, root } = await open(routingApi('agent'));
    // Dispatched past the button, which is not rendered for an Agent at all.
    // A hidden button is not the control; the renderer refuses too, and the
    // server refuses after that.
    app.dispatch('live-routing-open', 'assign');
    await settle();
    expect(root.querySelector('.routing__form')).toBeNull();
    app.dispatch('live-routing-open', 'priority');
    await settle();
    expect(root.querySelector('[data-act="live-routing-priority"]')).toBeNull();
  });

  it('ignores a routing control rendered with an argument it does not know', async () => {
    const api = routingApi();
    const { app } = await open(api);
    app.dispatch('live-routing-open', 'demolish');
    await settle();
    expect(app.state.live.routingPanel).toBeNull();
    expect(
      api.countOf(`GET /tenants/${TENANT}/directory/agents?conversation_id=${CONVERSATION}`),
    ).toBe(0);
  });

  it('ignores an answer to an offer that is not one of the three', async () => {
    const api = routingApi('agent').on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`,
      page([offer()]),
    );
    const { app } = await open(api);
    app.dispatch('live-handoff-settle', `${OFFER}:ignore`);
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/handoffs/${OFFER}/ignore`)).toBe(0);
  });

  it('closes the form and gives back what was in it', async () => {
    const { app, root } = await open(routingApi());
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-close'));
    await settle();
    expect(app.state.live.routingPanel).toBeNull();
    // A colleague chosen for one act and abandoned must not still be chosen
    // when a different one is opened.
    expect(app.state.live.routingChoice).toBe('');
    expect(app.state.live.handoffNote).toBe('');
  });

  it('withdraws an offer and says so', async () => {
    let cancelled = false;
    const api = routingApi('agent')
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/cancel`, () => {
        cancelled = true;
        return { status: 200, body: { data: offer({ state: 'cancelled' }) } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, () =>
        page([cancelled ? offer({ state: 'cancelled' }) : offer()]),
      );
    const { app, root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:cancel`));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('سُحب الطلب');
  });

  it('declines an offer and says so', async () => {
    let declined = false;
    const mine = offer({ toMembershipId: ME, fromMembershipId: LAYLA });
    const api = routingApi('agent')
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/decline`, () => {
        declined = true;
        return { status: 200, body: { data: { ...mine, state: 'declined' } } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, () =>
        page([declined ? { ...mine, state: 'declined' } : mine]),
      );
    const { app, root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:decline`));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('اعتذرت');
  });

  it('does nothing routing-shaped when no conversation is open', async () => {
    const api = routingApi();
    const { app } = await open(api, '#/inbox');
    app.dispatch('live-routing-open', 'assign');
    app.dispatch('live-routing-assign');
    app.dispatch('live-routing-ask');
    app.dispatch('live-routing-priority', 'urgent');
    app.dispatch('live-collaborator-add');
    app.dispatch('live-collaborator-remove', LAYLA);
    app.dispatch('live-handoff-settle', `${OFFER}:accept`);
    await settle();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('passes a refusal it has no words for straight through', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      {
        status: 500,
        body: { error: { code: 'internal', message: 'The server failed.', request_id: null } },
      },
    );
    const { app, root } = await open(api);
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-assign'));
    await settle();
    // No id to quote, so none is invented.
    expect(app.state.toasts.at(-1)?.text).toBe('The server failed.');
  });

  it('says the same things in English', async () => {
    const api = routingApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/assignments`,
      { status: 200, body: { data: conversation({ assigneeMembershipId: LAYLA, version: 5 }) } },
    );
    const { app, root } = await open(api);
    app.dispatch('lang', 'en');
    await settle();
    click(root, control('live-routing-open', 'assign'));
    await settle();
    choose(root, LAYLA);
    await settle();
    click(root, control('live-routing-assign'));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('Assigned.');
  });

  it('offers nothing to a role this build has never heard of', async () => {
    const { app, root } = await open(routingApi('chief_vibes_officer', conversation(), null));
    // The server is ahead of the browser. Guessing what an unknown role may do
    // would be guessing at somebody's authority.
    expect(root.querySelector('.routing')).toBeNull();
    expect(currentMembership(app.state.live)?.roleKey).toBe('chief_vibes_officer');
    expect(routingAbility(app.state.live)).toEqual({ mayAssign: false, mayAsk: false });
  });

  it('uses the actual grants of a custom role', async () => {
    const { root } = await open(
      routingApi('queue_coordinator', conversation(), ['conversation.read', 'conversation.assign']),
    );
    expect(root.querySelector(control('live-routing-open', 'assign'))).not.toBeNull();
    expect(root.querySelector(control('live-routing-open', 'priority'))).not.toBeNull();
    expect(root.querySelector(control('live-routing-open', 'handoff'))).toBeNull();
  });

  it('offers nothing without an active membership', async () => {
    const api = new FakeApi()
      .on('GET /auth/session', {
        status: 200,
        body: { data: { user: { id: 'u1', email: 'nobody@example.com' } } },
      })
      .on('GET /me/memberships', { status: 200, body: { data: [] } });
    const { app, root } = await open(api, '#/inbox');
    expect(root.querySelector('.routing')).toBeNull();
    expect(currentMembership(app.state.live)).toBeNull();
    expect(routingAbility(app.state.live)).toEqual({ mayAssign: false, mayAsk: false });
  });

  it('offers nothing before anybody has signed in', async () => {
    const api = new FakeApi().on('GET /auth/session', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'no', request_id: 'r' } },
    });
    const { app, root } = await open(api, '#/inbox');
    expect(root.querySelector('.routing')).toBeNull();
    expect(currentMembership(app.state.live)).toBeNull();
    expect(routingAbility(app.state.live)).toEqual({ mayAssign: false, mayAsk: false });
  });

  it('offers nothing when the session names a company the memberships do not', async () => {
    const api = routingApi();
    api.on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: ME,
            tenant: { id: 'another-tenant', name: 'Elsewhere', slug: 'elsewhere' },
            role: { id: 'owner-role', key: 'owner', name: 'Owner' },
          },
        ],
      },
    });
    const { app } = await open(api, '#/inbox');
    // Nothing to draw controls from, and nothing guessed from the first
    // membership that happens to be in the list.
    expect(app.state.live.session.status).toBe('signed_in');
    expect(app.state.live.assignees.status).toBe('idle');
  });
});

describe('when routing changes under the agent', () => {
  it('re-reads the offers on a handoff event, and not the whole conversation', async () => {
    const api = routingApi('agent');
    const { root } = await open(api);
    const record = api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`);
    api.on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([offer()]));

    FakeStream.last?.emit('conversation.handoff', streamEvent('conversation.handoff'));
    await settle();

    // The banner appears because the offers were re-read; the record was not,
    // because an offer somebody made does not move the conversation.
    expect(root.querySelector('.routing__offer')).not.toBeNull();
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`)).toBe(record);
  });

  it('re-reads the record when the routing itself moved', async () => {
    const api = routingApi();
    const { root } = await open(api);
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`);
    api.on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
      status: 200,
      body: { data: conversation({ priority: 'urgent', version: 5 }) },
    });

    FakeStream.last?.emit('conversation.routing', streamEvent('conversation.routing'));
    await settle();

    expect(api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`)).toBe(before + 1);
    expect(text(root.querySelector('.routing__current') as HTMLElement)).toContain('عاجلة');
  });
});

/* ---------------------------------------------------------- losing access -- */

describe('when the conversation stops being yours', () => {
  it('clears the thread instead of leaving somebody else’s timeline on screen', async () => {
    let moved = false;
    const settledOffer = offer({ toMembershipId: LAYLA, fromMembershipId: ME });
    const api = routingApi('agent')
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([settledOffer]))
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/cancel`, () => {
        moved = true;
        return { status: 200, body: { data: { ...settledOffer, state: 'cancelled' } } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, () =>
        moved
          ? {
              status: 403,
              body: { error: { code: 'permission_denied', message: 'no', request_id: 'r' } },
            }
          : { status: 200, body: { data: conversation() } },
      );
    const { app, root } = await open(api);
    // The composer holds a half-written reply, which must not survive either.
    app.dispatch('live-composer', 'سأتحقق');
    click(root, control('live-handoff-settle', `${OFFER}:cancel`));
    await settle();

    expect(text(root)).toContain('انتقلت هذه المحادثة');
    expect(app.state.live.composer).toBe('');
    expect(root.querySelector('.msg')).toBeNull();
  });

  it('reads a concealed conversation after a handoff the same way', async () => {
    let moved = false;
    const settledOffer = offer({ toMembershipId: LAYLA, fromMembershipId: ME });
    const api = routingApi('agent')
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/handoffs`, page([settledOffer]))
      .on(`POST /tenants/${TENANT}/handoffs/${OFFER}/cancel`, () => {
        moved = true;
        return { status: 200, body: { data: { ...settledOffer, state: 'cancelled' } } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, () =>
        moved
          ? { status: 404, body: { error: { code: 'resource_not_found', message: 'no', request_id: 'r' } } }
          : { status: 200, body: { data: conversation() } },
      );
    const { root } = await open(api);
    click(root, control('live-handoff-settle', `${OFFER}:cancel`));
    await settle();
    // The API hides a conversation outside your scope as "not found"; after a
    // handoff that is the same fact as a refusal.
    expect(text(root)).toContain('انتقلت هذه المحادثة');
  });

  it('still says plainly "not permitted" for a conversation that was never theirs', async () => {
    const api = routingApi().on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'no', request_id: 'r' } },
    });
    const { root } = await open(api);
    // "This conversation moved" about a thread somebody never had would be a
    // lie about what just happened.
    expect(text(root)).not.toContain('انتقلت هذه المحادثة');
  });
});
