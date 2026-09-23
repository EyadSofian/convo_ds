/**
 * @vitest-environment happy-dom
 */
import {
  applyTrigger,
  CONVERSATION_STATES,
  type ConversationState,
  type LifecycleTrigger,
} from '@convo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/client.js';
import type { AppHandle } from '../app.js';
import { mount } from '../app.js';
import type { RouterHost } from '../router.js';
import {
  COMMANDS_FOR,
  LIFECYCLE_COMMANDS,
  type LifecycleCommandName,
} from '../ui/lifecycle-panel.js';
import type { EventSourceLike } from './realtime.js';

/**
 * The conversation lifecycle, the private notes and the read cursor, through
 * the real client, actions and renderer.
 *
 * The first test in this file is the one that matters most: the browser holds a
 * copy of §18.1's availability, and it is regenerated here from the domain's
 * own table rather than eyeballed. Everything else is what the operator sees —
 * a refusal in their words, a note that cannot reach a customer, a wake time
 * that reads as the future it is.
 */

const NOW = new Date('2026-09-10T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';
const NOTE = '77777777-7777-4777-8777-777777777777';

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
    const call = this.calls.filter((entry) => `${entry.method} ${entry.path}` === key).at(-1);
    return call?.body as Record<string, unknown> | undefined;
  }

  countOf(key: string): number {
    return this.calls.filter((call) => `${call.method} ${call.path}` === key).length;
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

function event(type: string): unknown {
  return {
    schemaVersion: 1,
    id: `e-${type}`,
    seq: 9,
    type,
    entity: { type: 'conversation', id: CONVERSATION, version: 5 },
    scope: {
      conversationId: CONVERSATION,
      inboxId: 'cn-1',
      teamId: null,
      assigneeMembershipId: MEMBERSHIP,
    },
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
    assigneeMembershipId: MEMBERSHIP,
    status: 'open',
    priority: 'high',
    version: 4,
    waitingSince: null,
    inboxLabel: 'خط التسجيل',
    channel: 'whatsapp',
    participantMembershipIds: [MEMBERSHIP],
    contactId: null,
    pendingReason: null,
    snoozedUntil: null,
    snoozeTimezone: null,
    resolution: null,
    resolvedAt: null,
    lastActivityAt: '2026-09-10T09:21:00.000Z',
    ...overrides,
  };
}

function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NOTE,
    conversationId: CONVERSATION,
    authorMembershipId: MEMBERSHIP,
    body: 'العميل اتصل بالفعل، لا تكرّر السؤال',
    createdAt: '2026-09-10T09:25:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function episode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ep-1',
    seq: 1,
    openedAt: '2026-09-10T09:00:00.000Z',
    openedBy: 'customer_inbound',
    firstInboundAt: '2026-09-10T09:00:00.000Z',
    firstResponseAt: '2026-09-10T09:04:00.000Z',
    closedAt: null,
    resolution: null,
    ...overrides,
  };
}

/**
 * The first read answers `first`, every read after it answers `rest`.
 *
 * A refusal is usually the screen finding out the record moved, so a test of
 * one has to hand back a *different* record than the one that was rendered.
 */
function readsThen(first: unknown, rest: unknown): () => Reply {
  let served = false;
  return () => {
    const body = { data: served ? rest : first };
    served = true;
    return { status: 200, body };
  };
}

function page(rows: readonly unknown[]): Reply {
  return {
    status: 200,
    body: { data: rows, page: { next_cursor: null, has_more: false }, request_id: 'req-1' },
  };
}

/** A signed-in agent with one open conversation, its notes and its episodes. */
function threadApi(record: Record<string, unknown> = conversation()): FakeApi {
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
            permissions: ['conversation.read', 'conversation.unassigned.preview', 'conversation.reply', 'conversation.note', 'conversation.handoff.request'],
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/conversations/unassigned`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
      status: 200,
      body: { data: [record] },
    })
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, { status: 200, body: { data: record } })
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, page([]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, page([note()]))
    .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/episodes`, page([episode()]))
    .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/read`, {
      status: 200,
      body: { data: { readThrough: NOW.toISOString() } },
    });
}

let handle: AppHandle | null = null;

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
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

function type(root: ParentNode, selector: string, value: string): void {
  const field = root.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (field === null) throw new Error(`no field for ${selector}`);
  field.value = value;
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function control(root: ParentNode, act: string, arg?: string): string {
  return `[data-act="${act}"]${arg === undefined ? '' : `[data-arg="${arg}"]`}`;
}

afterEach(() => {
  handle?.destroy();
  handle = null;
});

/* ------------------------------------------------------------------ drift -- */

describe('the controls the screen offers', () => {
  /**
   * The browser's availability map, regenerated from the domain's own table.
   *
   * A command is offered when the table permits it *and* it does something —
   * resolving an already-resolved conversation is permitted and changes nothing,
   * while re-snoozing changes no status but reschedules the wake job.
   */
  const TRIGGER_OF: Readonly<Record<LifecycleCommandName, LifecycleTrigger>> = {
    wait: 'agent_waits',
    snooze: 'agent_snoozes',
    resolve: 'agent_resolves',
    reopen: 'agent_reopens',
    archive: 'agent_archives',
  };

  function derived(status: ConversationState): readonly LifecycleCommandName[] {
    return LIFECYCLE_COMMANDS.filter((command) => {
      const outcome = applyTrigger(status, TRIGGER_OF[command]);
      return outcome.refusal === null && (outcome.changed || outcome.effects.length > 0);
    });
  }

  it.each(CONVERSATION_STATES)('matches the lifecycle table for %s', (status) => {
    expect(COMMANDS_FOR[status]).toEqual(derived(status));
  });

  it('covers every state the domain knows about', () => {
    expect(Object.keys(COMMANDS_FOR).sort()).toEqual([...CONVERSATION_STATES].sort());
  });
});

/* ------------------------------------------------------------ transitions -- */

describe('moving a conversation', () => {
  it('offers only what the conversation can actually do', async () => {
    const { root } = await open(threadApi());
    expect(root.querySelector(control(root, 'live-lifecycle-open', 'wait'))).not.toBeNull();
    expect(root.querySelector(control(root, 'live-lifecycle-open', 'resolve'))).not.toBeNull();
    // Reopening an open conversation and archiving an unresolved one are both
    // refused by the table, so neither is on screen to press.
    expect(root.querySelector(control(root, 'live-lifecycle-do', 'reopen'))).toBeNull();
    expect(root.querySelector(control(root, 'live-lifecycle-do', 'archive'))).toBeNull();
  });

  it('records a waiting reason with the version the agent saw', async () => {
    const api = threadApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      {
        status: 200,
        body: { data: conversation({ status: 'pending', version: 5, pendingReason: 'رقم الطلب' }) },
      },
    );
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'wait'));
    await settle();
    type(root, '[data-form="lifecycleReason"]', 'رقم الطلب');
    click(root, control(root, 'live-lifecycle-do', 'wait'));
    await settle();

    expect(
      api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toEqual({ version: 4, command: 'wait', reason: 'رقم الطلب' });
    // The reason is what the status pill cannot say on its own.
    expect(text(root.querySelector('.lifecycle__notice') as HTMLElement)).toContain('رقم الطلب');
  });

  it('sends nothing when the reason is empty', async () => {
    const api = threadApi();
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'wait'));
    await settle();
    click(root, control(root, 'live-lifecycle-do', 'wait'));
    await settle();
    expect(
      api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toBe(0);
  });

  it('turns a snooze preset into an instant in this browser’s zone', async () => {
    const api = threadApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      {
        status: 200,
        body: {
          data: conversation({
            status: 'snoozed',
            version: 5,
            snoozedUntil: '2026-09-10T10:30:00.000Z',
            snoozeTimezone: 'Europe/Helsinki',
          }),
        },
      },
    );
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'snooze'));
    await settle();
    click(root, control(root, 'live-lifecycle-do', 'snooze:60'));
    await settle();

    const body = api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`);
    expect(body?.['command']).toBe('snooze');
    // One hour from the injected clock, as an instant — not a duration the
    // server would resolve against a different one.
    expect(body?.['wakeAt']).toBe('2026-09-10T10:30:00.000Z');
    expect(body?.['timezone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('reads a typed wake time as local, not as UTC', async () => {
    const api = threadApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      { status: 200, body: { data: conversation({ status: 'snoozed', version: 5 }) } },
    );
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'snooze'));
    await settle();
    type(root, '[data-form="lifecycleWakeAt"]', '2026-09-11T09:00');
    click(root, control(root, 'live-lifecycle-do', 'snooze'));
    await settle();

    const sent = api.bodyOf(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
    )?.['wakeAt'];
    // Whatever the runner's zone is, nine in the morning *there* is what was
    // meant. Appending a Z would shift every snooze by the offset.
    expect(sent).toBe(new Date('2026-09-11T09:00').toISOString());
  });

  it('refuses to send a snooze with no time at all', async () => {
    const api = threadApi();
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'snooze'));
    await settle();
    click(root, control(root, 'live-lifecycle-do', 'snooze'));
    await settle();
    expect(
      api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toBe(0);
  });

  it('ignores a wake time that is not a date', async () => {
    const api = threadApi();
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'snooze'));
    await settle();
    type(root, '[data-form="lifecycleWakeAt"]', 'الأسبوع القادم');
    click(root, control(root, 'live-lifecycle-do', 'snooze'));
    await settle();
    expect(
      api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toBe(0);
  });

  it('shows a snooze as the future it is', async () => {
    const record = conversation({
      status: 'snoozed',
      snoozedUntil: '2026-09-10T12:30:00.000Z',
      snoozeTimezone: 'Africa/Cairo',
    });
    const { root } = await open(threadApi(record));
    const notice = text(root.querySelector('.lifecycle__notice') as HTMLElement);
    // Three hours ahead of the injected clock. `relativeTime` would have said
    // "now", which is the one answer that is certainly wrong.
    expect(notice).toContain('خلال 3 س');
    expect(notice).toContain('Africa/Cairo');
  });

  it('records a resolution and offers what a resolved conversation can do', async () => {
    const resolved = conversation({
      status: 'resolved',
      version: 5,
      resolution: 'أُرسل بديل الطلب',
      resolvedAt: NOW.toISOString(),
    });
    const api = threadApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      { status: 200, body: { data: resolved } },
    );
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    type(root, '[data-form="lifecycleResolution"]', 'أُرسل بديل الطلب');
    click(root, control(root, 'live-lifecycle-do', 'resolve'));
    await settle();

    expect(
      api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toEqual({ version: 4, command: 'resolve', resolution: 'أُرسل بديل الطلب' });
    // The controls follow the new status without a reload.
    expect(root.querySelector(control(root, 'live-lifecycle-do', 'reopen'))).not.toBeNull();
    expect(root.querySelector(control(root, 'live-lifecycle-do', 'archive'))).not.toBeNull();
    expect(root.querySelector(control(root, 'live-lifecycle-open', 'wait'))).toBeNull();
  });

  it('sends reopen and archive with no form at all', async () => {
    const api = threadApi(conversation({ status: 'resolved', resolution: 'تم' })).on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      { status: 200, body: { data: conversation({ status: 'open', version: 5 }) } },
    );
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-do', 'reopen'));
    await settle();
    expect(
      api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`),
    ).toEqual({ version: 4, command: 'reopen' });
  });

  it('archives a resolved thread', async () => {
    const api = threadApi(conversation({ status: 'resolved', resolution: 'تم' })).on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      { status: 200, body: { data: conversation({ status: 'archived', version: 5 }) } },
    );
    const { app, root } = await open(api);
    click(root, control(root, 'live-lifecycle-do', 'archive'));
    await settle();
    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`)).toEqual({
      version: 4,
      command: 'archive',
    });
    expect(app.state.toasts.at(-1)?.text).toContain('أُرشِفت');
  });

  it('closes the form and drops what was typed in it', async () => {
    const { app, root } = await open(threadApi());
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    type(root, '[data-form="lifecycleResolution"]', 'نص مهجور');
    click(root, control(root, 'live-lifecycle-close'));
    await settle();
    expect(root.querySelector('.lifecycle__form')).toBeNull();
    // Reopening a different form must not inherit it: that is how the wrong
    // sentence gets recorded against the wrong fact.
    expect(app.state.dialogForm['lifecycleResolution']).toBeUndefined();
  });

  it('reports a lost race as a colleague having moved first', async () => {
    const api = threadApi()
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`, {
        status: 409,
        body: {
          error: {
            code: 'conversation_version_conflict',
            message: 'stale version',
            request_id: 'req-2',
          },
        },
      })
      // Open first, resolved afterwards: the whole point is that the record
      // moved between the render and the click.
      .on(
        `GET /tenants/${TENANT}/conversations/${CONVERSATION}`,
        readsThen(conversation(), conversation({ status: 'resolved', version: 9, resolution: 'أغلقها زميل' })),
      );
    const { app, root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    type(root, '[data-form="lifecycleResolution"]', 'تم');
    click(root, control(root, 'live-lifecycle-do', 'resolve'));
    await settle();

    expect(app.state.toasts.at(-1)?.text).toContain('تغيّرت المحادثة');
    // Re-read, not patched: what is on screen is what the server now says.
    expect(text(root.querySelector('.lifecycle__notice') as HTMLElement)).toContain('أغلقها زميل');
  });

  it('explains a refusal in the operator’s words', async () => {
    const api = threadApi()
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`, {
        status: 409,
        body: {
          error: {
            code: 'archived_conversation_is_immutable',
            message: 'archived',
            request_id: 'req-2',
          },
        },
      })
      .on(
        `GET /tenants/${TENANT}/conversations/${CONVERSATION}`,
        readsThen(conversation(), conversation({ status: 'archived' })),
      );
    const { app, root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    type(root, '[data-form="lifecycleResolution"]', 'تم');
    click(root, control(root, 'live-lifecycle-do', 'resolve'));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('مؤرشفة');
  });

  it('passes an unmapped refusal through rather than inventing one', async () => {
    const api = threadApi()
      .on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`, {
        status: 403,
        body: {
          error: { code: 'permission_denied', message: 'Your role cannot.', request_id: 'r' },
        },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation() },
      });
    const { app, root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    type(root, '[data-form="lifecycleResolution"]', 'تم');
    click(root, control(root, 'live-lifecycle-do', 'resolve'));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('Your role cannot.');
  });

  it('sends no empty resolution', async () => {
    const api = threadApi();
    const { root } = await open(api);
    click(root, control(root, 'live-lifecycle-open', 'resolve'));
    await settle();
    click(root, control(root, 'live-lifecycle-do', 'resolve'));
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`)).toBe(0);
  });

  it('shows a wake time even when no zone came back with it', async () => {
    const record = conversation({
      status: 'snoozed',
      snoozedUntil: '2026-09-10T12:30:00.000Z',
      snoozeTimezone: null,
    });
    const { root } = await open(threadApi(record));
    const notice = root.querySelector('.lifecycle__notice') as HTMLElement;
    expect(text(notice)).toContain('خلال 3 س');
    expect(notice.querySelector('.lifecycle__noticezone')).toBeNull();
  });

  it('leaves an archived conversation with no controls and no composer', async () => {
    const { root } = await open(threadApi(conversation({ status: 'archived' })));
    expect(root.querySelector('.lifecycle__controls')).toBeNull();
    // No composer either: a disabled box says something is broken; the notice
    // says the conversation is finished and a new message starts another.
    expect(root.querySelector('.composer')).toBeNull();
    expect(text(root.querySelector('.lifecycle__notice') as HTMLElement)).toContain('مؤرشفة');
  });
});

/* ------------------------------------------------------------------ notes -- */

describe('in English', () => {
  it('says the same things', async () => {
    const api = threadApi().on(
      `POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`,
      { status: 200, body: { data: conversation({ status: 'pending', version: 5 }) } },
    );
    const { app, root } = await open(api);
    app.dispatch('lang', 'en');
    await settle();

    click(root, control(root, 'live-lifecycle-open', 'wait'));
    await settle();
    type(root, '[data-form="lifecycleReason"]', 'their order number');
    click(root, control(root, 'live-lifecycle-do', 'wait'));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('Recorded: waiting for the customer.');
  });
});

describe('internal notes', () => {
  it('shows the notes on the open conversation', async () => {
    const { root } = await open(threadApi());
    expect(text(root.querySelector('.notes') as HTMLElement)).toContain('العميل اتصل بالفعل');
  });

  it('says plainly that the customer never sees them', async () => {
    const { root } = await open(threadApi());
    expect(text(root.querySelector('.notes') as HTMLElement)).toContain('لا يراها العميل');
  });

  it('keeps the note draft out of the reply composer', async () => {
    const { app, root } = await open(threadApi());
    click(root, control(root, 'composer-tab', 'note'));
    type(root, '.composer__input--note', 'ملاحظة داخلية');
    await settle();
    expect(app.state.live.noteDraft).toBe('ملاحظة داخلية');
    // The one field that must never carry it.
    expect(app.state.live.composer).toBe('');
  });

  it('adds a note and clears the draft only once it exists', async () => {
    const api = threadApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, {
      status: 201,
      body: { data: note({ id: 'n-2', body: 'ملاحظة داخلية' }) },
    });
    const { app, root } = await open(api);
    click(root, control(root, 'composer-tab', 'note'));
    type(root, '.composer__input--note', 'ملاحظة داخلية');
    await settle();
    click(root, control(root, 'live-note-add'));
    await settle();

    expect(api.bodyOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/notes`)).toEqual({
      body: 'ملاحظة داخلية',
    });
    expect(app.state.live.noteDraft).toBe('');
  });

  it('keeps what was typed when the write fails', async () => {
    const api = threadApi().on(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, {
      status: 500,
      body: { error: { code: 'internal', message: 'The server failed.', request_id: 'r' } },
    });
    const { app, root } = await open(api);
    click(root, control(root, 'composer-tab', 'note'));
    type(root, '.composer__input--note', 'ملاحظة داخلية');
    await settle();
    click(root, control(root, 'live-note-add'));
    await settle();
    expect(app.state.live.noteDraft).toBe('ملاحظة داخلية');
    expect(app.state.toasts.at(-1)?.text).toBe('The server failed.');
  });

  it('deletes a note and keeps its place in the thread', async () => {
    let deleted = false;
    const api = threadApi()
      .on(`DELETE /tenants/${TENANT}/notes/${NOTE}`, () => {
        deleted = true;
        return { status: 200, body: { data: note({ deletedAt: NOW.toISOString() }) } };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, () =>
        deleted ? page([note({ deletedAt: NOW.toISOString() })]) : page([note()]),
      );
    const { root } = await open(api);
    click(root, control(root, 'live-note-delete', NOTE));
    await settle();

    const item = root.querySelector('.notes__item--deleted');
    expect(item).not.toBeNull();
    // The row stays and says a note was removed: a thread that quietly loses an
    // internal remark cannot be reconstructed afterwards.
    expect(text(item as HTMLElement)).toContain('حُذفت ملاحظة');
    expect(text(item as HTMLElement)).not.toContain('العميل اتصل بالفعل');
  });

  it('names the one rule about editing somebody else’s note', async () => {
    const api = threadApi().on(`DELETE /tenants/${TENANT}/notes/${NOTE}`, {
      status: 403,
      body: { error: { code: 'not_the_author', message: 'not yours', request_id: 'r' } },
    });
    const { app, root } = await open(api);
    click(root, control(root, 'live-note-delete', NOTE));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('كاتب الملاحظة وحده');
  });

  it('passes another refusal through unchanged', async () => {
    const api = threadApi().on(`DELETE /tenants/${TENANT}/notes/${NOTE}`, {
      status: 500,
      body: { error: { code: 'internal', message: 'The server failed.', request_id: 'r' } },
    });
    const { app, root } = await open(api);
    click(root, control(root, 'live-note-delete', NOTE));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('The server failed.');
  });

  it('offers a retry when the notes themselves could not be read', async () => {
    let attempts = 0;
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`,
      () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: 503,
              body: { error: { code: 'unavailable', message: 'No answer.', request_id: 'r' } },
            }
          : page([note()]);
      },
    );
    const { root } = await open(api);
    expect(text(root.querySelector('.notes') as HTMLElement)).toContain('تعذّر إكمال الطلب');
    click(root, control(root, 'live-notes-reload'));
    await settle();
    expect(text(root.querySelector('.notes') as HTMLElement)).toContain('العميل اتصل بالفعل');
  });

  it('says so when there are no notes rather than showing an empty box', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`,
      page([]),
    );
    const { root } = await open(api);
    expect(text(root.querySelector('.notes') as HTMLElement)).toContain('لا ملاحظات بعد');
  });

  it('corrects a note in place, seeded with what it says', async () => {
    let edited = false;
    const api = threadApi()
      .on(`PATCH /tenants/${TENANT}/notes/${NOTE}`, () => {
        edited = true;
        return {
          status: 200,
          body: { data: note({ body: 'العميل اتصل بالفعل', editedAt: NOW.toISOString() }) },
        };
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`, () =>
        page([edited ? note({ body: 'العميل اتصل بالفعل', editedAt: NOW.toISOString() }) : note()]),
      );
    const { app, root } = await open(api);
    click(root, control(root, 'live-note-edit', NOTE));
    await settle();
    // Seeded, not blank: making somebody retype a sentence to fix a word is how
    // the correction ends up shorter than the original.
    expect(app.state.live.noteEdit).toBe('العميل اتصل بالفعل، لا تكرّر السؤال');

    type(root, '.notes__item--editing .notes__field', 'العميل اتصل بالفعل');
    click(root, control(root, 'live-note-edit-save', NOTE));
    await settle();

    expect(api.bodyOf(`PATCH /tenants/${TENANT}/notes/${NOTE}`)).toEqual({
      body: 'العميل اتصل بالفعل',
    });
    expect(app.state.live.editingNoteId).toBeNull();
    expect(text(root.querySelector('.notes__meta') as HTMLElement)).toContain('مُعدّلة');
  });

  it('gives back the new-note draft when an edit is cancelled', async () => {
    const { app, root } = await open(threadApi());
    click(root, control(root, 'composer-tab', 'note'));
    type(root, '.composer__input--note', 'ملاحظة نصف مكتوبة');
    await settle();
    click(root, control(root, 'live-note-edit', NOTE));
    await settle();
    click(root, control(root, 'live-note-edit-cancel'));
    await settle();
    expect(app.state.live.editingNoteId).toBeNull();
    // The two drafts are separate fields precisely so this holds.
    expect(app.state.live.noteDraft).toBe('ملاحظة نصف مكتوبة');
  });

  it('keeps the correction on screen when the edit is refused', async () => {
    const api = threadApi().on(`PATCH /tenants/${TENANT}/notes/${NOTE}`, {
      status: 403,
      body: { error: { code: 'not_the_author', message: 'not yours', request_id: 'r' } },
    });
    const { app, root } = await open(api);
    click(root, control(root, 'live-note-edit', NOTE));
    await settle();
    type(root, '.notes__item--editing .notes__field', 'تصحيح');
    click(root, control(root, 'live-note-edit-save', NOTE));
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('كاتب الملاحظة وحده');
    expect(app.state.live.noteEdit).toBe('تصحيح');
  });

  it('sends no empty note and no empty correction', async () => {
    const api = threadApi();
    const { app, root } = await open(api);
    app.dispatch('live-note-add');
    click(root, control(root, 'live-note-edit', NOTE));
    await settle();
    type(root, '.notes__item--editing .notes__field', '   ');
    app.dispatch('live-note-edit-save', NOTE);
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/notes`)).toBe(0);
    expect(api.countOf(`PATCH /tenants/${TENANT}/notes/${NOTE}`)).toBe(0);
  });

  it('marks a note that was edited', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`,
      page([note({ editedAt: NOW.toISOString() })]),
    );
    const { root } = await open(api);
    expect(text(root.querySelector('.notes__meta') as HTMLElement)).toContain('مُعدّلة');
  });
});

/* --------------------------------------------------------------- episodes -- */

describe('reporting episodes', () => {
  it('shows one row per time the conversation was worked', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/episodes`,
      page([
        episode({ id: 'ep-1', seq: 1, closedAt: '2026-09-10T09:10:00.000Z', resolution: 'أُجيب' }),
        episode({ id: 'ep-2', seq: 2, firstResponseAt: null }),
      ]),
    );
    const { root } = await open(api);
    const items = root.querySelectorAll('.episodes__item');
    expect(items).toHaveLength(2);
    expect(text(items[0] as HTMLElement)).toContain('أُجيب');
    // A clock that never started is an em dash, not a zero: they are different
    // facts and a report that confused them would read as an instant reply.
    expect(text(items[1] as HTMLElement)).toContain('—');
  });

  it('marks only the newest open episode as the current one', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/episodes`,
      page([
        // An earlier episode left open: not the current one, and not shown as
        // though this conversation were being worked twice at once.
        episode({ id: 'ep-1', seq: 1 }),
        episode({ id: 'ep-2', seq: 2 }),
      ]),
    );
    const { root } = await open(api);
    const badges = root.querySelectorAll('.episodes__item .badge');
    expect(badges[0]?.className).toContain('badge--neutral');
    expect(badges[1]?.className).toContain('badge--accent');
  });

  it('says nothing at all when the episodes could not be read', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/episodes`,
      {
        status: 503,
        body: { error: { code: 'unavailable', message: 'No answer.', request_id: 'r' } },
      },
    );
    const { root } = await open(api);
    // Every conversation has at least one episode, so "none" only ever means
    // "not loaded" — and a box saying that teaches nothing.
    expect(root.querySelector('.episodes')).toBeNull();
  });
});

/* --------------------------------------------------------------- realtime -- */

describe('when the record moves under the agent', () => {
  it('re-reads the conversation on a state event, not only its messages', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}`,
      readsThen(conversation(), conversation({ status: 'resolved', version: 9, resolution: 'أغلقها زميل' })),
    );
    const { root } = await open(api);
    expect(root.querySelector(control(root, 'live-lifecycle-open', 'wait'))).not.toBeNull();

    FakeStream.last?.emit('conversation.state', event('conversation.state'));
    await settle();

    // The lifecycle controls are drawn from the status and the version, so a
    // state event that moved only the timeline would leave an agent pressing
    // buttons against a record that is no longer there.
    expect(text(root.querySelector('.lifecycle__notice') as HTMLElement)).toContain('أغلقها زميل');
    expect(root.querySelector(control(root, 'live-lifecycle-do', 'reopen'))).not.toBeNull();
  });

  it('refreshes the conversation capability for an inbound event without adding duplicate reads', async () => {
    const api = threadApi();
    await open(api);
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`);

    FakeStream.last?.emit('message.inbound', event('message.inbound'));
    await settle();

    // The timeline and service-window capability are both refreshed. The
    // capability read is required because inbound evidence can reopen the
    // WhatsApp reply window without changing the conversation's lifecycle.
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`)).toBe(before + 1);
    expect(
      api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`),
    ).toBeGreaterThan(1);
  });

  it('keeps a failed re-read from replacing a working screen', async () => {
    let reads = 0;
    const api = threadApi().on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, () => {
      reads += 1;
      return reads === 1
        ? { status: 200, body: { data: conversation() } }
        : {
            status: 503,
            body: { error: { code: 'unavailable', message: 'No answer.', request_id: 'r' } },
          };
    });
    const { root } = await open(api);
    FakeStream.last?.emit('conversation.state', event('conversation.state'));
    await settle();
    // The last good record stands. The next action against a stale version is
    // refused by the server's fence anyway, which is the check that matters.
    expect(root.querySelector('.thread__header')).not.toBeNull();
    expect(root.querySelector(control(root, 'live-lifecycle-open', 'wait'))).not.toBeNull();
  });
});

/* ---------------------------------------------------------- malformed UI -- */

describe('a control rendered with the wrong argument', () => {
  /**
   * These cannot happen from the screens in this repository — the renderer
   * builds every one of these arguments from a closed list. They are asserted
   * because the answer must be "do nothing", not "post it and read the server's
   * 400 back to the operator as though they had made a mistake".
   */
  it('does not post an unknown transition', async () => {
    const api = threadApi();
    const { app } = await open(api);
    app.dispatch('live-lifecycle-do', 'demolish');
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`)).toBe(0);
  });

  it('opens no form for a transition that has none', async () => {
    const { app } = await open(threadApi());
    app.dispatch('live-lifecycle-open', 'reopen');
    await settle();
    expect(app.state.live.lifecyclePanel).toBeNull();
  });

  it('reloads no notes when no conversation is open', async () => {
    const api = threadApi();
    const { app } = await open(api, '#/inbox');
    const before = api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`);
    app.dispatch('live-notes-reload');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`)).toBe(before);
  });

  it('acts on nothing when no conversation is open', async () => {
    const api = threadApi();
    const { app } = await open(api, '#/inbox');
    app.dispatch('live-lifecycle-do', 'archive');
    app.dispatch('live-note-delete', NOTE);
    app.dispatch('live-note-edit-save', NOTE);
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`)).toBe(0);
    expect(api.countOf(`DELETE /tenants/${TENANT}/notes/${NOTE}`)).toBe(0);
    expect(api.countOf(`PATCH /tenants/${TENANT}/notes/${NOTE}`)).toBe(0);
  });

  it('shows a status this build has never heard of, and offers nothing for it', async () => {
    const { root } = await open(threadApi(conversation({ status: 'quarantined' })));
    // The server is ahead of the browser. Guessing which transitions an unknown
    // status allows would be a guess at somebody's data.
    expect(text(root.querySelector('.thread__header') as HTMLElement)).toContain('quarantined');
    expect(root.querySelector('.lifecycle__controls')).toBeNull();
  });

  it('ignores a wake time the date parser cannot read', async () => {
    const api = threadApi();
    const { app } = await open(api);
    app.dispatch('live-lifecycle-open', 'snooze');
    await settle();
    // Dispatched past the `datetime-local` control, which refuses to hold a
    // value like this at all. The parser behind it must refuse too, rather than
    // posting an `Invalid Date`.
    app.dispatch('form', 'lifecycleWakeAt:الأسبوع القادم');
    app.dispatch('live-lifecycle-do', 'snooze');
    await settle();
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/transitions`)).toBe(0);
  });

  it('opens an empty correction for a note it cannot find', async () => {
    const api = threadApi().on(
      `GET /tenants/${TENANT}/conversations/${CONVERSATION}/notes`,
      {
        status: 503,
        body: { error: { code: 'unavailable', message: 'No answer.', request_id: 'r' } },
      },
    );
    const { app } = await open(api);
    // The notes never loaded, so there is nothing to seed from. Blank, not the
    // text of whichever note happened to be first.
    app.dispatch('live-note-edit', NOTE);
    await settle();
    expect(app.state.live.noteEdit).toBe('');

    const loaded = await open(threadApi());
    loaded.app.dispatch('live-note-edit', 'a-note-that-is-not-here');
    await settle();
    expect(loaded.app.state.live.noteEdit).toBe('');
  });

  it('does nothing at all without an active membership', async () => {
    const api = new FakeApi()
      .on('GET /auth/session', {
        status: 200,
        body: { data: { user: { id: 'u1', email: 'nobody@example.com' } } },
      })
      .on('GET /me/memberships', { status: 200, body: { data: [] } });
    const { app } = await open(api, '#/inbox');
    // One guard for every action: a session with no company renders screens
    // with no controls, and the actions behind them refuse rather than build a
    // URL with `undefined` in it.
    app.dispatch('live-lifecycle-do', 'archive');
    app.dispatch('live-note-add');
    app.dispatch('live-note-delete', NOTE);
    app.dispatch('live-note-edit-save', NOTE);
    await settle();
    expect(api.calls.filter((call) => call.path.includes('/conversations'))).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- unread -- */

describe('the read cursor', () => {
  it('marks a conversation read once its contents are on screen', async () => {
    const api = threadApi();
    await open(api);
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/read`)).toBe(1);
  });

  it('does not move the cursor for a conversation it could not read', async () => {
    const api = threadApi().on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'no', request_id: 'r' } },
    });
    await open(api);
    expect(api.countOf(`POST /tenants/${TENANT}/conversations/${CONVERSATION}/read`)).toBe(0);
  });

  it('marks an unread row without guessing about one that says nothing', async () => {
    const api = threadApi().on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
      status: 200,
      body: {
        data: [
          conversation({ id: CONVERSATION, unread: true }),
          conversation({ id: 'other-id', peerIdentity: '15551110000' }),
        ],
      },
    });
    const { root } = await open(api, '#/inbox');
    click(root, control(root, 'live-inbox-queue', 'mine'));
    await settle();
    const rows = root.querySelectorAll('.convrow--record');
    expect(rows[0]?.classList.contains('convrow--unread')).toBe(true);
    // Absent is not the same as read; a row with no answer keeps no marker
    // rather than having one cleared for it.
    expect(rows[1]?.classList.contains('convrow--unread')).toBe(false);
  });
});
