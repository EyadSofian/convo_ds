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
 * Contacts, through the real client, actions and renderer.
 *
 * What is worth asserting here is mostly what the screen refuses to do. There
 * is no "new contact" and no merge, the search is over names rather than
 * numbers, a suppression is shown above the consent it overrides, and the two
 * refusals the server makes — an import is not consent, a grant cannot lift an
 * opt-out — reach the operator in their own words rather than as a generic
 * failure.
 */

const NOW = new Date('2026-09-10T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';

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

class SilentStream implements EventSourceLike {
  addEventListener(): void {
    // The stream is not what these tests are about.
  }
  close(): void {
    // Nothing to close.
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

function contact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONTACT,
    displayName: 'سارة عبد الله',
    attributes: { grade: 'الصف السادس' },
    createdAt: NOW.toISOString(),
    identities: [
      {
        id: 'ci-1',
        kind: 'whatsapp',
        scopeId: 'cn-1',
        externalId: '15559998888',
        validFrom: NOW.toISOString(),
        validTo: null,
      },
    ],
    consent: [],
    suppressed: [],
    ...overrides,
  };
}

function contactsApi(): FakeApi {
  return new FakeApi()
    .on('GET /auth/session', {
      status: 200,
      body: { data: { user: { id: 'u1', email: 'owner@digital-school.example' } } },
    })
    .on('GET /me/memberships', {
      status: 200,
      body: {
        data: [
          {
            id: MEMBERSHIP,
            tenant: { id: TENANT, name: 'Digital School', slug: 'digital-school' },
            role: { id: 'owner-role', key: 'owner', name: 'Owner' },
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/contacts`, { status: 200, body: { data: [contact()] } })
    .on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, { status: 200, body: { data: contact() } });
}

let handle: AppHandle | null = null;

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function open(api: FakeApi, hash = '#/contacts'): Promise<{ app: AppHandle; root: HTMLElement }> {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  const app = mount({
    root,
    host: createHost(hash),
    now: NOW,
    fetch: api.fetch,
    readCsrfToken: () => 'csrf-token',
    openEventSource: () => new SilentStream(),
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
  const field = root.querySelector(selector) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
}

afterEach(() => {
  handle?.destroy();
  handle = null;
});

describe('the contacts directory', () => {
  it('lists contacts with the channels they are reachable on', async () => {
    const { root } = await open(contactsApi());
    const row = root.querySelector('.contactrow');
    expect(text(row as HTMLElement)).toContain('سارة عبد الله');
    expect(text(row as HTMLElement)).toContain('واتساب');
  });

  it('marks a contact with no live identity rather than implying we can reach them', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 200,
      body: {
        data: [
          contact({
            identities: [
              {
                id: 'ci-0',
                kind: 'whatsapp',
                scopeId: 'cn-1',
                externalId: '15550000000',
                validFrom: '2025-01-01T00:00:00.000Z',
                validTo: '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
        ],
      },
    });
    const { root } = await open(api);
    const row = text(root.querySelector('.contactrow') as HTMLElement);
    expect(row).toContain('لا هوية سارية');
    expect(row).not.toContain('واتساب');
  });

  it('offers no way to create a contact or merge two', async () => {
    const { root } = await open(contactsApi());
    // A contact exists because somebody wrote to us. A form that made one from
    // a typed-in number would be an identity claim nobody verified.
    expect(root.querySelector('[data-act="live-contact-create"]')).toBeNull();
    expect(root.querySelector('[data-act="live-contact-merge"]')).toBeNull();
  });

  it('searches by name, through the server', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts?q=%D8%B3%D8%A7%D8%B1%D8%A9`, {
      status: 200,
      body: { data: [contact()] },
    });
    const { root } = await open(api);
    type(root, '[data-form="contactQuery"]', 'سارة');
    click(root, '[data-act="live-contacts-search"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/contacts?q=%D8%B3%D8%A7%D8%B1%D8%A9`)).toBe(1);
  });

  it('says so when nobody has written yet', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 200,
      body: { data: [] },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('لا جهات اتصال');
  });

  it('reports a refusal in the operator’s terms', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('غير مسموح');
  });
});

describe('one contact', () => {
  it('shows the identities with the channel each belongs to', async () => {
    const { root } = await open(contactsApi());
    click(root, '.contactrow');
    await settle();
    const identity = root.querySelector('.contact__identity');
    expect(text(identity as HTMLElement)).toContain('واتساب');
    expect(text(identity as HTMLElement)).toContain('15559998888');
    expect(text(identity as HTMLElement)).toContain('سارية');
  });

  it('shows a closed identity as ended rather than hiding it', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: {
        data: contact({
          identities: [
            {
              id: 'ci-0',
              kind: 'whatsapp',
              scopeId: 'cn-1',
              externalId: '15550000000',
              validFrom: '2025-01-01T00:00:00.000Z',
              validTo: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    // Messages sent while it was live belong to whoever held it then, so the
    // interval is shown rather than erased.
    expect(text(root.querySelector('.contact__identity') as HTMLElement)).toContain('منتهية');
  });

  it('corrects the display name and redraws from what the server stored', async () => {
    const api = contactsApi().on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ displayName: 'سارة ع.' }) },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    type(root, '[data-form^="contactName_"]', 'سارة ع.');
    click(root, '[data-act="live-contact-save-screen"]');
    await settle();

    const sent = api.calls.find((call) => call.method === 'PATCH');
    expect(sent?.body).toEqual({ displayName: 'سارة ع.' });
    expect(app.state.toasts.at(-1)?.text).toContain('حُفظت');
    expect((root.querySelector('[data-form^="contactName_"]') as HTMLInputElement).value).toBe(
      'سارة ع.',
    );
  });

  it('refuses to save an empty name rather than sending one', async () => {
    const api = contactsApi();
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    const before = api.calls.length;
    type(root, '[data-form^="contactName_"]', '   ');
    click(root, '[data-act="live-contact-save-screen"]');
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('keeps the record the server holds when a save fails', async () => {
    const api = contactsApi().on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Try later.' } },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    type(root, '[data-form^="contactName_"]', 'اسم لم يُحفظ');
    click(root, '[data-act="live-contact-save-screen"]');
    await settle();

    expect(app.state.toasts.at(-1)?.tone).toBe('danger');
    expect(app.state.toasts.at(-1)?.text).toContain('Try later.');
    // The record on screen is still the stored one; a failed save is not a save.
    expect(text(root.querySelector('.contact') as HTMLElement)).toContain('الصف السادس');
    expect(app.state.live.busy).toBeNull();
  });

  it('shows an unfamiliar channel by its own name rather than blank', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: {
        data: contact({
          identities: [
            {
              id: 'ci-2',
              kind: 'telegram',
              scopeId: 'cn-9',
              externalId: '@sara',
              validFrom: NOW.toISOString(),
              validTo: null,
            },
          ],
        }),
      },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    // A channel this build has no word for is still a channel the customer is
    // reachable on. An empty pill would hide it.
    expect(text(root.querySelector('.contact__identity') as HTMLElement)).toContain('telegram');
  });

  it('shows a business field that is not text without dropping it', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ attributes: { siblings: ['نور', 'ريم'], grade: 6 } }) },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    const grid = text(root.querySelector('.attrgrid') as HTMLElement);
    expect(grid).toContain('نور');
    expect(grid).toContain('6');
  });

  it('says so plainly when the company keeps no business fields', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ attributes: {} }) },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    // An empty grid would read as a record that failed to load.
    expect(text(root.querySelector('.contact') as HTMLElement)).toContain('لا حقول عمل مسجّلة');
    expect(root.querySelector('.attrgrid')).toBeNull();
  });

  it('asks for a sign-in when the session ends between the list and the record', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    // Not "not permitted": the role never came into it, the session did.
    expect(text(root)).toContain('انتهت الجلسة');
    expect(text(root)).not.toContain('غير مسموح');
  });
});

describe('the customer panel beside a conversation', () => {
  const CONVERSATION = '55555555-5555-4555-8555-555555555555';

  function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: CONVERSATION,
      connectionId: 'cn-1',
      peerIdentity: '15559998888',
      teamId: null,
      assigneeMembershipId: MEMBERSHIP,
      status: 'open',
      priority: 'normal',
      version: 4,
      waitingSince: null,
      inboxLabel: 'خط التسجيل',
      channel: 'whatsapp',
      participantMembershipIds: [MEMBERSHIP],
      contactId: CONTACT,
      ...overrides,
    };
  }

  function inboxApi(contactId: string | null = CONTACT): FakeApi {
    return contactsApi()
      .on(`GET /tenants/${TENANT}/conversations/unassigned`, { status: 200, body: { data: [] } })
      .on(`GET /tenants/${TENANT}/conversations?queue=mine`, {
        status: 200,
        body: { data: [conversation({ contactId })] },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, {
        status: 200,
        body: { data: conversation({ contactId }) },
      })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}/messages`, {
        status: 200,
        body: { data: [], page: { next_cursor: null, has_more: false }, request_id: 'r' },
      });
  }

  it('shows the customer of the open conversation', async () => {
    const { root } = await open(inboxApi(), `#/inbox/${CONVERSATION}`);
    const panel = root.querySelector('.zone--panel') as HTMLElement;
    expect((panel.querySelector('[data-form^="contactName_"]') as HTMLInputElement).value).toBe(
      'سارة عبد الله',
    );
    expect(text(panel)).toContain('15559998888');
  });

  it('says there is no record yet when nobody has written', async () => {
    const { root } = await open(inboxApi(null), `#/inbox/${CONVERSATION}`);
    // A conversation we started does not invent a person from a phone number.
    expect(text(root.querySelector('.zone--panel') as HTMLElement)).toContain(
      'لا يوجد سجل عميل بعد',
    );
  });

  it('reports a refused contact inside the panel, not instead of the thread', async () => {
    const api = inboxApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.' } },
    });
    const { root } = await open(api, `#/inbox/${CONVERSATION}`);
    expect(text(root.querySelector('.zone--panel') as HTMLElement)).toContain('غير مسموح');
    // The conversation is still readable: losing the contact record does not
    // take the thread with it.
    expect(root.querySelector('.zone--thread')).not.toBeNull();
  });

  it('saves a corrected name from the panel', async () => {
    const api = inboxApi().on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ displayName: 'سارة ع.' }) },
    });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    type(root, '.zone--panel [data-form^="contactName_"]', 'سارة ع.');
    click(root, '[data-act="live-contact-save-panel"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('حُفظت');
    const panel = root.querySelector('.zone--panel') as HTMLElement;
    expect((panel.querySelector('[data-form^="contactName_"]') as HTMLInputElement).value).toBe(
      'سارة ع.',
    );
  });

  it('records consent from the panel too', async () => {
    const api = inboxApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 201,
      body: { data: contact() },
    });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    click(root, '.zone--panel [data-act="live-consent-panel"][data-arg$="granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('سُجّلت الموافقة');
  });
});

describe('when there is no company to act on', () => {
  it('does nothing at all rather than asking for one it does not have', async () => {
    const api = new FakeApi()
      .on('GET /auth/session', {
        status: 200,
        body: { data: { user: { id: 'u1', email: 'nobody@example.test' } } },
      })
      .on('GET /me/memberships', { status: 200, body: { data: [] } });
    const { app, root } = await open(api);
    const before = api.calls.length;

    app.dispatch('live-contact-open', CONTACT);
    app.dispatch('live-contacts-search');
    app.dispatch('live-contact-save-screen', CONTACT);
    app.dispatch('live-consent-screen', `${CONTACT}:granted`);
    await settle();

    expect(api.calls.filter((call) => call.path.includes('/tenants/'))).toEqual([]);
    expect(api.calls.length).toBe(before);
    expect(text(root)).toContain('لا توجد عضوية نشطة');
  });

  it('offers a way back when there is no session', async () => {
    const api = new FakeApi().on('GET /auth/session', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('تحتاج جلسة');
    expect(root.querySelector('[data-act="live-contacts-reload"]')).not.toBeNull();
  });

  it('reloads the whole screen from the retry control', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Try later.' } },
    });
    const { root } = await open(api);
    api.on(`GET /tenants/${TENANT}/contacts`, { status: 200, body: { data: [contact()] } });
    click(root, '[data-act="live-contacts-reload"]');
    await settle();
    expect(api.countOf('GET /auth/session')).toBe(2);
    expect(root.querySelector('.contactrow')).not.toBeNull();
  });
});

describe('consent', () => {
  it('records a withdrawal on the channel the contact is reachable on', async () => {
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 201,
      body: {
        data: contact({
          consent: [
            {
              channel: 'whatsapp',
              purpose: 'service',
              state: 'withdrawn',
              source: 'agent_recorded',
              recordedAt: NOW.toISOString(),
              actorMembershipId: MEMBERSHIP,
            },
          ],
        }),
      },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    click(root, '[data-act="live-consent-screen"][data-arg$="withdrawn"]');
    await settle();

    const sent = api.calls.find((call) => call.path.endsWith('/consents'));
    // The channel comes from the contact's live identity, not from a picker:
    // consent about a channel they have no identity on is a fact about nothing.
    expect(sent?.body).toEqual({
      channel: 'whatsapp',
      purpose: 'service',
      state: 'withdrawn',
      source: 'agent_recorded',
      proofRef: null,
    });
    expect(app.state.toasts.at(-1)?.text).toContain('سُجّل الانسحاب');
    expect(text(root)).toContain('انسحاب');
  });

  it('shows a suppression above the consent it overrides', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: {
        data: contact({
          suppressed: ['whatsapp'],
          consent: [
            {
              channel: 'whatsapp',
              purpose: 'marketing',
              state: 'granted',
              source: 'agent_recorded',
              recordedAt: NOW.toISOString(),
              actorMembershipId: MEMBERSHIP,
            },
          ],
        }),
      },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();

    const notice = root.querySelector('.consent__suppressed');
    expect(text(notice as HTMLElement)).toContain('الانسحاب يعلو أي موافقة');
    // Above, not beside: the order on screen is the order of authority.
    const section = notice?.closest('.contact__section') as HTMLElement;
    const children = Array.from(section.children);
    expect(children.indexOf(notice as Element)).toBeLessThan(
      children.indexOf(section.querySelector('.consent__list') as Element),
    );
  });

  it('explains why a grant cannot paper over an opt-out', async () => {
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 409,
      body: {
        error: { code: 'suppression_outranks_consent', message: 'This customer opted out.' },
      },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    click(root, '[data-act="live-consent-screen"][data-arg$="granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('الانسحاب يعلو الموافقة');
  });

  it('explains that an import is not consent', async () => {
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 422,
      body: { error: { code: 'import_is_not_consent', message: 'An import is not consent.' } },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    click(root, '[data-act="live-consent-screen"][data-arg$="granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('الاستيراد ليس موافقة');
  });

  it('reports any other refusal in the server’s own words', async () => {
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 503,
      body: { error: { code: 'unavailable', message: 'الخدمة غير متاحة' } },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    click(root, '[data-act="live-consent-screen"][data-arg$="granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('الخدمة غير متاحة');
  });

  it('records a consent message in English too', async () => {
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 201,
      body: { data: contact() },
    });
    const { root, app } = await open(api);
    app.dispatch('lang', 'en');
    click(root, '.contactrow');
    await settle();
    click(root, '[data-act="live-consent-screen"][data-arg$="granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('Consent recorded.');
  });

  it('ignores a consent control carrying a state it does not know', async () => {
    const api = contactsApi();
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    const before = api.calls.length;
    app.dispatch('live-consent-screen', `${CONTACT}:sideways`);
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('does nothing when the contact has no live identity to be about', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ identities: [] }) },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    const before = api.calls.length;
    click(root, '[data-act="live-consent-screen"][data-arg$="granted"]');
    await settle();
    expect(api.calls.length).toBe(before);
  });
});
