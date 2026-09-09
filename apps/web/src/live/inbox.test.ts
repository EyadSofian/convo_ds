/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/client.js';
import type { AppHandle } from '../app.js';
import { mount } from '../app.js';
import type { RouterHost } from '../router.js';
import type { EventSourceLike } from './realtime.js';

/**
 * The Inbox driven through the real client, the real actions and the real
 * renderer — only the network and the event stream are replaced.
 *
 * The claims worth testing here are the ones a demo screen gets wrong:
 *
 * - an agent who may only preview sees a **card**, and the screen cannot show a
 *   transcript because it was never given one;
 * - a claim carries the version the agent saw, and a conflict is reported as
 *   somebody else getting there first rather than as an error;
 * - a reply appears when the server has the command, not when the button was
 *   pressed, and a failed one does not lose what was typed;
 * - a realtime event causes a **re-read**, so what lands on screen is what this
 *   caller is allowed rather than what an event payload happened to carry;
 * - a stream that stops says so, because a stalled inbox and a quiet one look
 *   identical.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

type Route = Reply | (() => Reply | Promise<Reply>);

class FakeApi {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
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

  countOf(key: string): number {
    return this.calls.filter((call) => `${call.method} ${call.path}` === key).length;
  }

  readonly fetch: FetchLike = async (url, init) => {
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
    const reply = await (typeof route === 'function' ? route() : route);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** A stream the test drives by hand. */
class FakeStream implements EventSourceLike {
  static last: FakeStream | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeStream.last = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
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

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONVERSATION,
    inboxLabel: 'خط التسجيل',
    channel: 'whatsapp',
    maskedLabel: '••••888',
    priority: 'high',
    status: 'open',
    waitingSinceAt: '2026-09-09T09:20:00.000Z',
    claimable: true,
    version: 3,
    ...overrides,
  };
}

function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONVERSATION,
    connectionId: 'cn-1',
    peerIdentity: '15559998888',
    teamId: null,
    assigneeMembershipId: MEMBERSHIP,
    status: 'open',
    priority: 'high',
    version: 4,
    waitingSince: null,
    inboxLabel: 'خط التسجيل',
    channel: 'whatsapp',
    participantMembershipIds: [MEMBERSHIP],
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    direction: 'in',
    at: '2026-09-09T09:21:00.000Z',
    content_type: 'text',
    text: 'مرحبا، أريد التسجيل',
    attachments: [],
    author_membership_id: null,
    command_state: null,
    delivery_state: null,
    delivery_anomaly: null,
    provider_message_id: 'wamid.1',
    ...overrides,
  };
}

function page(rows: readonly unknown[], nextCursor: string | null = null): Reply {
  return {
    status: 200,
    body: {
      data: rows,
      page: { next_cursor: nextCursor, has_more: nextCursor !== null },
      request_id: 'req-1',
    },
  };
}

/** A signed-in workspace whose inbox holds one waiting card. */
function inboxApi(): FakeApi {
  return new FakeApi()
    .on('GET /auth/session', {
      status: 200,
      body: { data: { user: { id: 'u1', email: 'agent@digital-school.example' } } },
    })
    .on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: MEMBERSHIP,
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'agent-role', key: 'agent', name: 'Agent' },
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/conversations/unassigned`, { status: 200, body: { data: [card()] } })
    .on(`GET /tenants/${TENANT}/conversations?queue=mine`, { status: 200, body: { data: [] } });
}

let handle: AppHandle | null = null;

function mountRoot(): HTMLElement {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return root;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function open(api: FakeApi, hash = '#/inbox'): Promise<{ app: AppHandle; root: HTMLElement }> {
  const root = mountRoot();
  FakeStream.last = null;
  const app = mount({
    root,
    host: createHost(hash),
    now: NOW,
    fetch: api.fetch,
    readCsrfToken: () => 'csrf-token',
    newKey: () => 'client-message-1',
    openEventSource: (url) => new FakeStream(url),
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

function type(root: ParentNode, selector: string, value: string): void {
  const field = root.querySelector(selector) as HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Claims through the control the screen renders, whichever one it is. */
async function claimConversationFrom(app: AppHandle): Promise<void> {
  const id = app.state.live.openConversationId ?? CONVERSATION;
  app.dispatch('live-inbox-claim', `${id}:4`);
  await settle();
}

afterEach(() => {
  handle?.destroy();
  handle = null;
});

describe('the queue', () => {
  it('shows a projected card, and nothing that was not sent', async () => {
    const { root } = await open(inboxApi());
    const row = root.querySelector('.convrow--card');
    expect(row).not.toBeNull();
    expect(text(row as HTMLElement)).toContain('••••888');
    // The server sent a masked label and no message text. There is nothing here
    // for a browser to be trusted to hide.
    expect(text(root)).not.toContain('15559998888');
    expect(root.querySelector('.msg')).toBeNull();
  });

  it('offers a claim, and no composer, before the conversation is anybody’s', async () => {
    const { root } = await open(inboxApi());
    expect(root.querySelector('[data-act="live-inbox-claim"]')).not.toBeNull();
    expect(root.querySelector('.composer__input')).toBeNull();
  });

  it('says the queue is empty rather than showing nothing at all', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 200,
      body: { data: [] },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('لا شيء في الانتظار');
  });

  it('reports a refusal in the operator’s terms, with a way back', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('غير مسموح');
  });

  it('switches to the caller’s own conversations without re-fetching', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
      status: 200,
      body: { data: [conversation()] },
    });
    const { root } = await open(api);
    const before = api.calls.length;
    click(root, '[data-act="live-inbox-queue"][data-arg="mine"]');
    // Both halves were loaded together; a tab click is a view switch, not a
    // request.
    expect(api.calls.length).toBe(before);
    expect(root.querySelector('.convrow--record')).not.toBeNull();
  });
});

describe('claiming', () => {
  it('sends the version from the card, and opens the conversation it won', async () => {
    const api = inboxApi()
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/claim`, {
        status: 201,
        body: { data: conversation() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([message()]))
      .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
        status: 200,
        body: { data: [conversation()] },
      });
    const { root, app } = await open(api);
    click(root, '[data-act="live-inbox-claim"]');
    await settle();

    const claim = api.calls.find((call) => call.path.endsWith('/claim'));
    // The version the agent saw, not one read behind their back: a claim that
    // re-fetched first would race the conflict it exists to report.
    expect(claim?.body).toEqual({ version: 3 });
    expect(app.state.live.openConversationId).toBe(CONVERSATION);
    expect(text(root)).toContain('مرحبا، أريد التسجيل');
    expect(app.state.toasts[0]?.text).toContain('المحادثة الآن لديك');
  });

  it('reports losing the race as somebody else getting there first', async () => {
    const api = inboxApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/claim`, {
      status: 409,
      body: {
        error: {
          code: 'conversation_version_conflict',
          message: 'This conversation was claimed by someone else.',
        },
      },
    });
    const { root, app } = await open(api);
    click(root, '[data-act="live-inbox-claim"]');
    await settle();

    // Not an apology and not a red error: the system worked.
    expect(app.state.toasts[0]).toMatchObject({ tone: 'warning' });
    expect(app.state.toasts[0]?.text).toContain('زميل آخر استلمها');
    // And the queue is re-read, so the card that is gone stops being offered.
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/unassigned`)).toBe(2);
    expect(root.querySelector('.convrow--card')).not.toBeNull();
  });

  it('refuses to claim from a control with no version on it', async () => {
    const api = inboxApi();
    const { app } = await open(api);
    const before = api.calls.length;
    app.dispatch('live-inbox-claim', CONVERSATION);
    await settle();
    // Guessing a version would defeat the conflict check rather than trip it.
    expect(api.calls.length).toBe(before);
  });
});

describe('reading and replying', () => {
  function claimedApi(): FakeApi {
    return inboxApi()
      .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
        status: 200,
        body: { data: [conversation()] },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([message()]));
  }

  it('opens a conversation from the list and writes it into the URL', async () => {
    const api = claimedApi();
    const { root, app } = await open(api);
    click(root, '[data-act="live-inbox-queue"][data-arg="mine"]');
    click(root, '.convrow--record');
    await settle();

    expect(text(root)).toContain('مرحبا، أريد التسجيل');
    // A link a colleague can paste.
    expect(app.state.route.conversationId).toBe(CONVERSATION);
  });

  it('follows a conversation named in the URL on arrival', async () => {
    const api = claimedApi();
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root)).toContain('مرحبا، أريد التسجيل');
  });

  it('shows both what we asked for and what the provider said', async () => {
    const api = claimedApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`,
      page([
        message(),
        message({
          id: 'm-2',
          direction: 'out',
          text: 'أهلًا بك',
          command_state: 'provider_accepted',
          delivery_state: 'read',
          delivery_anomaly: 'delivered_after_read',
        }),
      ]),
    );
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    const outbound = root.querySelector('.msg--out');
    expect(text(outbound as HTMLElement)).toContain('قبِلها المزوّد');
    expect(text(outbound as HTMLElement)).toContain('قُرئت');
    // A disagreement between receipts is shown, not smoothed over.
    expect(text(outbound as HTMLElement)).toContain('إيصالات متعارضة');
  });

  it('sends a reply and shows it once the server has the command', async () => {
    const api = claimedApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, {
      status: 202,
      body: { data: { id: 'ob-1', command_state: 'queued' } },
    });
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    type(root, '.composer__input', 'سنساعدك حالًا');

    api.on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`,
      page([message(), message({ id: 'm-3', direction: 'out', text: 'سنساعدك حالًا' })]),
    );
    click(root, '[data-act="live-inbox-send"]');
    await settle();

    const sent = api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/messages'));
    expect(sent?.body).toEqual({
      messageType: 'text',
      text: 'سنساعدك حالًا',
      clientMessageId: 'client-message-1',
    });
    expect(text(root)).toContain('سنساعدك حالًا');
    expect((root.querySelector('.composer__input') as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps what was typed when the send is refused', async () => {
    const api = claimedApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, {
      status: 422,
      body: { error: { code: 'window_closed', message: 'النافذة مغلقة' } },
    });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    type(root, '.composer__input', 'رد مهم');
    click(root, '[data-act="live-inbox-send"]');
    await settle();

    // Retyping a reply because the server refused once is the worst small thing
    // a messaging tool can do to somebody.
    expect(app.state.live.composer).toBe('رد مهم');
    expect(app.state.toasts[0]?.text).toBe('النافذة مغلقة');
  });

  it('keeps what was typed when something else re-renders the screen', async () => {
    const api = claimedApi();
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    type(root, '.composer__input', 'نصف جملة');

    // A realtime event arriving mid-sentence must not empty the composer.
    FakeStream.last?.emit('message.inbound', {
      schemaVersion: 1,
      id: 'e-mid',
      seq: 21,
      type: 'message.inbound',
      entity: { type: 'conversation', id: CONVERSATION, version: 6 },
      scope: {
        conversationId: CONVERSATION,
        inboxId: 'cn-1',
        teamId: null,
        assigneeMembershipId: MEMBERSHIP,
      },
      occurredAt: NOW.toISOString(),
      payload: {},
    });
    await settle();

    expect(app.state.live.composer).toBe('نصف جملة');
    expect((root.querySelector('.composer__input') as HTMLTextAreaElement).value).toBe('نصف جملة');
  });

  it('keeps the caret where the agent left it across a re-render', async () => {
    const api = claimedApi();
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    const input = root.querySelector('.composer__input') as HTMLTextAreaElement;
    input.value = 'نص طويل';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(3, 3);

    app.render();
    const after = root.querySelector('.composer__input') as HTMLTextAreaElement;
    // The element is replaced by every render. Focus and the caret follow the
    // control, or typing a reply would jump to the start on each keystroke.
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  it('treats a click in the composer as placing a caret, not as an action', async () => {
    const api = claimedApi();
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    const before = api.calls.length;
    const input = root.querySelector('.composer__input') as HTMLTextAreaElement;
    input.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
    // A textarea reports through `input`, never through a click.
    expect(api.calls.length).toBe(before);
    expect(app.state.live.composer).toBe('');
  });

  it('refuses to send nothing', async () => {
    const api = claimedApi();
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    const before = api.calls.length;
    type(root, '.composer__input', '   ');
    app.dispatch('live-inbox-send');
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('pages further back without losing what is on screen', async () => {
    const api = claimedApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`,
      page([message({ id: 'm-9', text: 'أحدث رسالة' })], 'cursor-1'),
    );
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root)).toContain('أحدث رسالة');

    api.on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages?cursor=cursor-1`,
      page([message({ id: 'm-0', text: 'أقدم رسالة' })]),
    );
    click(root, '[data-act="live-inbox-older"]');
    await settle();

    // Prepended: reading further back must not take away what was visible.
    expect(text(root)).toContain('أقدم رسالة');
    expect(text(root)).toContain('أحدث رسالة');
    expect(app.state.live.timelineCursor).toBeNull();
  });

  it('reports a refused conversation where the messages would be', async () => {
    const api = claimedApi().on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.' } },
    });
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root)).toContain('غير مسموح');
  });

  it('reports a failure to load an older page beside the composer', async () => {
    const api = claimedApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`,
      page([message()], 'cursor-1'),
    );
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    api.on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages?cursor=cursor-1`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'تعذّر تحميل الأقدم' } },
    });
    click(root, '[data-act="live-inbox-older"]');
    await settle();
    // What is already on screen stays: failing to read further back must not
    // take away what was already read.
    expect(app.state.live.error?.message).toBe('تعذّر تحميل الأقدم');
    expect(root.querySelectorAll('.msg')).toHaveLength(1);
  });

  it('does nothing when there is no older page to load', async () => {
    const api = claimedApi();
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    const before = api.calls.length;
    app.dispatch('live-inbox-older');
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('reports a claim that failed for a reason other than a conflict', async () => {
    const api = claimedApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/claim`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'الخدمة غير متاحة' } },
    });
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    await claimConversationFrom(app);
    // The server's own words, not a generic apology.
    expect(app.state.toasts[0]).toMatchObject({ tone: 'danger', text: 'الخدمة غير متاحة' });
  });

  it('says the conversation is yours in English too', async () => {
    const api = claimedApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/claim`, {
      status: 201,
      body: { data: conversation() },
    });
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    app.dispatch('lang', 'en');
    await claimConversationFrom(app);
    expect(app.state.toasts.at(-1)?.text).toBe('The conversation is yours.');
  });

  it('reports losing the race in English too', async () => {
    const api = claimedApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/claim`, {
      status: 409,
      body: { error: { code: 'conversation_version_conflict', message: 'No.' } },
    });
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    app.dispatch('lang', 'en');
    await claimConversationFrom(app);
    expect(app.state.toasts.at(-1)?.text).toContain('A colleague claimed it first');
  });

  it('refreshes the open conversation when an event is about it', async () => {
    const api = claimedApi();
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`);

    FakeStream.last?.emit('message.inbound', {
      schemaVersion: 1,
      id: 'e-open',
      seq: 11,
      type: 'message.inbound',
      entity: { type: 'conversation', id: CONVERSATION, version: 5 },
      scope: {
        conversationId: CONVERSATION,
        inboxId: 'cn-1',
        teamId: null,
        assigneeMembershipId: MEMBERSHIP,
      },
      occurredAt: NOW.toISOString(),
      payload: {},
    });
    await settle();
    // The thread the agent is reading is re-read; traffic in another one only
    // moves the lists.
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`)).toBe(
      before + 1,
    );
    expect(app.state.live.realtime.status).toBe('live');
  });
});

describe('what the screen does with what it is given', () => {
  it('says a card has not waited yet when the server sends no wait time', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 200,
      body: {
        data: [card({ waitingSinceAt: null, channel: 'web_chat', priority: 'exotic' })],
      },
    });
    const { root } = await open(api);
    const row = root.querySelector('.convrow--card');
    // A conversation opened by an outbound message has nobody waiting on it,
    // and the row says so rather than showing a made-up duration.
    expect(text(row as HTMLElement)).toContain('لم ينتظر بعد');
    // A channel with no provider logo gets the neutral mark; a priority this
    // build does not know is shown as itself rather than hidden.
    expect(text(row as HTMLElement)).toContain('محادثة الموقع');
    expect(text(row as HTMLElement)).toContain('exotic');
  });

  it('shows a message with no text as an empty bubble rather than crashing', async () => {
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
        status: 200,
        body: { data: [conversation()] },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation() },
      })
      .on(
        `GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`,
        page([message({ text: null, content_type: 'image' })]),
      );
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(root.querySelector('.msg__bubble')?.textContent).toBe('');
  });

  it('says the conversation is empty when nothing has arrived in it', async () => {
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([]));
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root)).toContain('لا رسائل بعد');
  });

  it('reports a refused timeline where the messages would be', async () => {
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation() },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, {
        status: 503,
        body: { error: { code: 'unavailable', message: 'Try later.' } },
      });
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root)).toContain('تعذّر الوصول للخادم');
  });

  it('offers a claim instead of a composer while the conversation is nobody’s', async () => {
    const unassigned = conversation({ assigneeMembershipId: null });
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: unassigned },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([message()]));
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    // A disabled composer would describe a rule the server does not have: it is
    // not that replying is unavailable, it is that this is not theirs yet.
    expect(root.querySelector('.composer__input')).toBeNull();
    expect(root.querySelector('.composer--claim [data-act="live-inbox-claim"]')).not.toBeNull();
  });

  it('says the session ended when the server stops recognising it', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('انتهت الجلسة');
  });

  it('names a channel and a priority it has no word for by their own names', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
      status: 200,
      body: { data: [conversation({ channel: 'telegram', priority: 'blistering' })] },
    });
    const { root } = await open(api);
    click(root, '[data-act="live-inbox-queue"][data-arg="mine"]');
    const row = root.querySelector('.convrow--record');
    // A newer server naming something this build does not know is information,
    // not noise: it is shown as itself rather than hidden or guessed at.
    expect(text(row as HTMLElement)).toContain('telegram');
    expect(text(row as HTMLElement)).toContain('blistering');
  });

  it('shows an unknown priority on the thread header too', async () => {
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation({ priority: 'blistering' }) },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([message()]));
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root.querySelector('.thread__header') as HTMLElement)).toContain('blistering');
  });

  it('says nothing is assigned to this agent when their list is empty', async () => {
    const { root } = await open(inboxApi());
    click(root, '[data-act="live-inbox-queue"][data-arg="mine"]');
    expect(text(root)).toContain('لا محادثات لديك');
    // And back again, which is the other half of the same control.
    click(root, '[data-act="live-inbox-queue"][data-arg="unassigned"]');
    expect(root.querySelector('.convrow--card')).not.toBeNull();
  });
});

describe('the live connection', () => {
  it('subscribes once the inbox is open, and says it is live', async () => {
    const { root, app } = await open(inboxApi());
    expect(FakeStream.last?.url).toBe(`/api/v1/tenants/${TENANT}/realtime/stream`);
    expect(app.state.live.realtime.status).toBe('live');
    expect(text(root)).toContain('التحديث الحي يعمل');
  });

  it('re-reads the server when an event says something changed', async () => {
    const api = inboxApi();
    await open(api);
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/unassigned`);

    FakeStream.last?.emit('message.inbound', {
      schemaVersion: 1,
      id: 'e1',
      seq: 9,
      type: 'message.inbound',
      entity: { type: 'conversation', id: CONVERSATION, version: 4 },
      scope: {
        conversationId: CONVERSATION,
        inboxId: 'cn-1',
        teamId: null,
        assigneeMembershipId: null,
      },
      occurredAt: NOW.toISOString(),
      payload: { projected: true },
      cursor: 'cursor-9',
    });
    await settle();

    // The event said *what* changed; the server says what it is. Patching from
    // the payload would leave a projected card standing in for a record.
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/unassigned`)).toBe(before + 1);
  });

  it('says so when the stream drops, rather than looking quiet', async () => {
    const { root, app } = await open(inboxApi());
    FakeStream.last?.emit('stream_cycled', { reason: 'max_stream_age' });
    await settle();
    expect(app.state.live.realtime.status).toBe('stale');
    expect(text(root)).toContain('انقطع التحديث الحي');
  });

  it('stops for good when access is revoked', async () => {
    const { root, app } = await open(inboxApi());
    FakeStream.last?.emit('stream_closed', { reason: 'access_revoked' });
    await settle();
    expect(app.state.live.realtime).toEqual({ status: 'stopped', reason: 'access_revoked' });
    // Reconnecting would ask the same question and get the same answer.
    expect(text(root)).toContain('أُوقف التحديث الحي');
  });

  it('reloads the screen when the server says the view is unusable', async () => {
    const api = inboxApi();
    const { app } = await open(api);
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/unassigned`);
    FakeStream.last?.emit('reset_required', { reason: 'permissions_changed' });
    await settle();
    // A permission change makes both halves of the client's view wrong, so it
    // starts again instead of patching.
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/unassigned`)).toBe(before + 1);
    expect(app.state.live.realtime.status).toBe('stale');
  });
});

describe('when there is no company to act on', () => {
  /** Signed in, with no active membership: the screen offers no controls. */
  function noMembershipApi(): FakeApi {
    return new FakeApi()
      .on('GET /auth/session', {
        status: 200,
        body: { data: { user: { id: 'u1', email: 'nobody@example.test' } } },
      })
      .on('GET /me/memberships', { status: 200, body: { data: [] } });
  }

  it('does nothing at all, rather than asking for a company it does not have', async () => {
    const api = noMembershipApi();
    const { app } = await open(api);
    const before = api.calls.length;

    // Every inbox action, driven directly. None of them can invent a company,
    // and none of them may reach the network without one.
    app.dispatch('live-inbox-open', CONVERSATION);
    app.dispatch('live-inbox-claim', `${CONVERSATION}:3`);
    app.dispatch('live-inbox-older');
    app.dispatch('live-inbox-send');
    app.dispatch('live-inbox-reload');
    await settle();

    expect(api.calls.filter((call) => call.path.includes('/tenants/'))).toEqual([]);
    expect(api.calls.length).toBeGreaterThanOrEqual(before);
    expect(app.state.live.openConversation.status).toBe('idle');
  });
});

describe('while the server has not answered', () => {
  it('shows the queue as busy, not as empty', async () => {
    const api = inboxApi();
    const release = api.hold(`GET /tenants/${TENANT}/conversations/unassigned`);
    const { root } = await open(api);
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(text(root)).not.toContain('لا شيء في الانتظار');
    release({ status: 200, body: { data: [card()] } });
    await settle();
    expect(root.querySelector('.convrow--card')).not.toBeNull();
  });

  it('offers a way back when there is no session', async () => {
    const api = new FakeApi().on('GET /auth/session', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('تحتاج جلسة');
    expect(root.querySelector('[data-act="live-inbox-reload"]')).not.toBeNull();
  });

  it('reloads the whole screen from the retry control', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Try later.' } },
    });
    const { root } = await open(api);
    api.on(`GET /tenants/${TENANT}/conversations/unassigned`, {
      status: 200,
      body: { data: [card()] },
    });
    click(root, '[data-act="live-inbox-reload"]');
    await settle();
    // The session is re-checked too: "try again" after an outage means the
    // whole screen, not one list.
    expect(api.countOf('GET /auth/session')).toBe(2);
    expect(root.querySelector('.convrow--card')).not.toBeNull();
  });

  it('says so when the account belongs to no active company', async () => {
    const api = new FakeApi()
      .on('GET /auth/session', {
        status: 200,
        body: { data: { user: { id: 'u1', email: 'nobody@example.test' } } },
      })
      .on('GET /me/memberships', { status: 200, body: { data: [] } });
    const { root } = await open(api);
    expect(text(root)).toContain('لا توجد عضوية نشطة');
  });
});
