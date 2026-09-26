/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../api/client.js';
import type { AppHandle } from '../app.js';
import { mount } from '../app.js';
import type { LiveContext } from './actions.js';
import { createContact, importContacts, loadContactConnections } from './contact-actions.js';
import type { RouterHost } from '../router.js';
import type { EventSourceLike } from './realtime.js';
import { createState } from '../state.js';

/**
 * Contacts, through the real client, actions and renderer.
 *
 * What is worth asserting here is mostly that contact actions remain explicit:
 * a new record has a selected channel-scoped identity and never implies consent;
 * there is no automatic merge, the search is over names rather than numbers, a
 * suppression is shown above the consent it overrides, and the two
 * refusals the server makes — an import is not consent, a grant cannot lift an
 * opt-out — reach the operator in their own words rather than as a generic
 * failure.
 */

const NOW = new Date('2026-09-10T09:30:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';
const LABEL = '77777777-7777-4777-8777-777777777777';
const FIELD = '88888888-8888-4888-8888-888888888888';

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
    version: 1,
    labels: [],
    customFields: [],
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

function contactsApi(permissions = ['conversation.read', 'conversation.assign', 'conversation.handoff.request', 'contact.read', 'contact.edit', 'contact.export', 'consent.record']): FakeApi {
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
            permissions,
          },
        ],
      },
    })
    .on(`GET /tenants/${TENANT}/contacts`, { status: 200, body: { data: [contact()] } })
    .on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, { status: 200, body: { data: contact() } })
    .on(`GET /tenants/${TENANT}/labels`, { status: 200, body: { data: [] } })
    .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: [] } });
}

let handle: AppHandle | null = null;
let urlCreateDescriptor: PropertyDescriptor | undefined;
let urlRevokeDescriptor: PropertyDescriptor | undefined;

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

function choose(root: ParentNode, selector: string, value: string): void {
  const field = root.querySelector(selector) as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new window.Event('change', { bubbles: true }));
}

afterEach(() => {
  handle?.destroy();
  handle = null;
  if (urlCreateDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
  else Object.defineProperty(URL, 'createObjectURL', urlCreateDescriptor);
  if (urlRevokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
  else Object.defineProperty(URL, 'revokeObjectURL', urlRevokeDescriptor);
  urlCreateDescriptor = undefined;
  urlRevokeDescriptor = undefined;
  vi.restoreAllMocks();
});

describe('the contacts directory', () => {
  it('renders import-only transfer controls safely while a file is ready and a request is busy', async () => {
    const { app, root } = await open(contactsApi(['contact.read', 'contact.edit']));
    app.state.live.connections = { status: 'ready', loadedAt: NOW.getTime(), value: [{
      id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null,
    }] as never };
    app.state.dialogForm = { contactsTool: 'import', contactImportCsv: 'display_name,external_id\nSara,wa-1' };
    app.state.live.busy = 'contacts:import';
    app.render();
    expect(root.querySelector('[data-act="live-contacts-export"]')).toBeNull();
    expect(text(root)).toContain('CSV');
    expect((root.querySelector('[data-act="live-contacts-import"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders export-only transfer controls without exposing the import workflow', async () => {
    const { root } = await open(contactsApi(['contact.read', 'contact.export']));
    expect(root.querySelector('[data-act="live-contacts-export"]')).not.toBeNull();
    expect(root.querySelector('[data-act="live-contacts-import"]')).toBeNull();
    expect(root.querySelector('input[data-act="live-contact-import-file"]')).toBeNull();
    expect(root.querySelector('[data-act="live-contacts-tool"]')).toBeNull();
  });

  it('never draws a tool the operator may not use, even when one is requested', async () => {
    const { app, root } = await open(contactsApi(['contact.read', 'contact.export']));
    app.state.dialogForm = { contactsTool: 'create' };
    app.render();
    expect(root.querySelector('#contacts-tool-create')).toBeNull();
    expect(root.querySelector('[data-act="live-contact-create"]')).toBeNull();
  });

  it('safely declines contact actions when input or tenant context is absent', async () => {
    const state = createState(NOW);
    state.live.session = { status: 'signed_out', error: null };
    const context = {
      state, live: state.live, refresh: () => undefined, now: () => NOW.getTime(), newKey: () => 'key',
      endSession: () => undefined, switchWorkspace: () => undefined,
    } as LiveContext;
    expect(await loadContactConnections(context)).toBe(false);
    expect(await createContact(context, { displayName: '', connectionId: 'cn-1', externalId: 'wa-1', fields: [], labelIds: [], consents: [] })).toBe(false);
    expect(await createContact(context, { displayName: 'Sara', connectionId: '', externalId: 'wa-1', fields: [], labelIds: [], consents: [] })).toBe(false);
    expect(await createContact(context, { displayName: 'Sara', connectionId: 'cn-1', externalId: '', fields: [], labelIds: [], consents: [] })).toBe(false);
    expect(await importContacts(context)).toBe(false);
    context.state.dialogForm = { contactImportCsv: 'invalid', contactImportConnection: 'cn-1' };
    expect(await importContacts(context)).toBe(false);
    context.state.dialogForm = { contactImportCsv: 'display_name,external_id\nSara,wa-1', contactImportConnection: '' };
    expect(await importContacts(context)).toBe(false);
  });

  it('shows at most two of a contact’s labels on its row', async () => {
    const label = (id: string, name: string): Record<string, unknown> => ({ id, name, color: '#6558d9', state: 'active', version: 1 });
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 200,
      body: { data: [contact({ labels: [label('l-1', 'VIP'), label('l-2', 'Parent'), label('l-3', 'Late')] })] },
    });
    const { root } = await open(api);
    const labels = [...root.querySelectorAll('.contactrow .metadata__label')].map((node) => node.textContent);
    expect(labels).toEqual(['VIP', 'Parent']);
  });

  it('reports a contact that could not be read beside the list, with a retry', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 500,
      body: { error: { code: 'internal_error', message: 'Broken.', request_id: 'r-8' } },
    });
    const { root } = await open(api);
    click(root, '.contactrow');
    await settle();
    expect(root.querySelector('.contactrow')).not.toBeNull();
    const failure = root.querySelector('.errorstate') as HTMLElement;
    expect(text(failure)).toContain('r-8');
    expect(failure.querySelector('[data-act="live-contacts-reload"]')).not.toBeNull();
  });

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
    expect(row).toContain('لا توجد هوية سارية');
    expect(row).not.toContain('واتساب');
  });

  it('creates a contact only after a channel identity is selected, without inventing consent', async () => {
    const created = contact({ id: 'contact-new', displayName: 'New customer', consent: [], suppressed: [] });
    const api = contactsApi()
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } })
      .on(`POST /tenants/${TENANT}/contacts`, { status: 201, body: { data: created } });
    const { root, app } = await open(api);
    // Adding is a dialog the operator opens; opening it fetches the channels.
    expect(root.querySelector('.dialog')).toBeNull();
    click(root, '[data-act="live-contact-new"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(1);
    choose(root, '[data-form="contactCreateConnection"]', 'cn-1');
    type(root, '[data-form="contactCreateName"]', 'New customer');
    type(root, '[data-form="contactCreateExternalId"]', '201000000000');
    click(root, '.dialog [data-act="live-contact-create"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path === `/tenants/${TENANT}/contacts`)?.body).toEqual({
      displayName: 'New customer', connectionId: 'cn-1', externalId: '201000000000',
    });
    // Nothing else was written: no consent, no fields, no labels, no re-read.
    expect(api.calls.some((call) => call.path.endsWith('/consents') || call.path.endsWith('/metadata'))).toBe(false);
    expect(api.countOf(`GET /tenants/${TENANT}/contacts/contact-new`)).toBe(0);
    expect(root.querySelector('.dialog')).toBeNull();
    expect(root.querySelector('.contact[data-contact="contact-new"]')).not.toBeNull();
    expect(app.state.toasts.at(-1)?.text).toBe('أُضيفت جهة الاتصال.');
    expect(root.querySelector('[data-act="live-contact-merge"]')).toBeNull();
  });

  describe('the new-contact card', () => {
    const LABEL_A = '99999999-9999-4999-8999-999999999991';
    const catalogue = [
      { id: 'f-email', target: 'contact', key: 'email', name: 'البريد', type: 'email', options: [], state: 'active', version: 1 },
      { id: 'f-level', target: 'contact', key: 'level', name: 'المستوى', type: 'single_select', options: ['A1', 'B1'], state: 'active', version: 1 },
      { id: 'f-vip', target: 'contact', key: 'vip', name: 'مميز', type: 'boolean', options: [], state: 'active', version: 1 },
      { id: 'f-seats', target: 'contact', key: 'seats', name: 'المقاعد', type: 'number', options: [], state: 'active', version: 1 },
      { id: 'f-tags', target: 'contact', key: 'interests', name: 'الاهتمامات', type: 'multi_select', options: ['kids', 'ielts'], state: 'active', version: 1 },
      { id: 'f-start', target: 'contact', key: 'start', name: 'البداية', type: 'date', options: [], state: 'active', version: 1 },
      { id: 'f-mobile', target: 'contact', key: 'mobile', name: 'جوال آخر', type: 'phone', options: [], state: 'active', version: 1 },
    ];
    const MANAGER = ['contact.read', 'contact.edit', 'consent.record', 'catalog.manage'];
    const withCatalogue = (api: FakeApi): FakeApi => api
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }, { id: 'cn-2', kind: 'messenger', display_name: 'Page', disconnected_at: null }] } })
      .on(`GET /tenants/${TENANT}/labels`, { status: 200, body: { data: [{ id: LABEL_A, name: 'VIP', color: '#2563eb', state: 'active', version: 1 }] } })
      .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: catalogue } });

    async function fill(root: HTMLElement): Promise<void> {
      click(root, '[data-act="live-contact-new"]');
      await settle();
      choose(root, '[data-form="contactCreateConnection"]', 'cn-1');
      type(root, '[data-form="contactCreateName"]', 'هالة مصطفى');
      type(root, '[data-form="contactCreateExternalId"]', '201112223344');
    }

    it('creates a whole customer card: details, new catalogue fields, labels and consent', async () => {
      const created = contact({ id: 'contact-card', displayName: 'هالة مصطفى', version: 1 });
      const api = withCatalogue(contactsApi(MANAGER))
        .on(`POST /tenants/${TENANT}/contacts`, { status: 201, body: { data: created } })
        .on(`POST /tenants/${TENANT}/custom-fields`, { status: 201, body: { data: { id: 'f-company', target: 'contact', key: 'company', name: 'الشركة أو المدرسة', type: 'text', options: [], state: 'active', version: 1 } } })
        .on(`PATCH /tenants/${TENANT}/contacts/contact-card/metadata`, { status: 200, body: { data: { version: 2, metadata: { labels: [], customFields: [] } } } })
        .on(`POST /tenants/${TENANT}/contacts/contact-card/consents`, { status: 201, body: { data: created } })
        .on(`GET /tenants/${TENANT}/contacts/contact-card`, { status: 200, body: { data: { ...created, displayName: 'هالة مصطفى (stored)' } } });
      const { root, app } = await open(api);
      await fill(root);
      // Reopening does not fetch the catalogues again.
      click(root, '.dialog [data-act="close-dialog"]');
      await fill(root);
      expect(api.countOf(`GET /tenants/${TENANT}/labels`)).toBe(1);
      // The hint follows the channel, and a WhatsApp identity is shown with its mark.
      expect(root.querySelector('.contact-new__mark.channel-tile--whatsapp')).not.toBeNull();
      expect((root.querySelector('#contact-new-external') as HTMLInputElement).placeholder).toBe('201001234567');
      type(root, '[data-form="newContact_email"]', 'hala@example.com');
      type(root, '[data-form="newContact_company"]', 'Digital School');
      choose(root, '[data-form="newContactField_f-level"]', 'B1');
      choose(root, '[data-form="newContactField_f-vip"]', 'true');
      type(root, '[data-form="newContactField_f-seats"]', '2');
      type(root, '[data-form="newContactField_f-tags"]', 'kids, ielts');
      click(root, '.contact-new .audience-chip');
      click(root, '.contact-new__consent[data-arg^="newContactMarketing"]');
      click(root, '.contact-new__consent[data-arg^="newContactService"]');
      expect(root.querySelectorAll('.contact-new__consent[aria-checked="true"]')).toHaveLength(2);
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();

      expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/custom-fields'))?.body).toEqual({
        target: 'contact', key: 'company', name: 'الشركة أو المدرسة', type: 'text', options: [],
      });
      expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        version: 1,
        addLabels: [LABEL_A],
        fields: [
          { fieldId: 'f-email', value: 'hala@example.com' },
          { fieldId: 'f-company', value: 'Digital School' },
          { fieldId: 'f-level', value: 'B1' },
          { fieldId: 'f-vip', value: true },
          { fieldId: 'f-seats', value: 2 },
          { fieldId: 'f-tags', value: ['kids', 'ielts'] },
        ],
      });
      expect(api.calls.filter((call) => call.path.endsWith('/consents')).map((call) => call.body)).toEqual([
        { channel: 'whatsapp', purpose: 'marketing', state: 'granted', source: 'agent_recorded', proofRef: null },
        { channel: 'whatsapp', purpose: 'service', state: 'granted', source: 'agent_recorded', proofRef: null },
      ]);
      // What the server stored is what is shown.
      expect(text(root.querySelector('.contact[data-contact="contact-card"]') as HTMLElement)).toContain('(stored)');
      expect(app.state.toasts.at(-1)).toMatchObject({ text: 'أُضيفت جهة الاتصال.', tone: 'default' });
      expect(root.querySelector('.dialog')).toBeNull();
    });

    it('keeps the contact and reports each refused detail, in English too', async () => {
      const created = contact({ id: 'contact-part', displayName: 'Hala', version: 1 });
      const api = withCatalogue(contactsApi(MANAGER))
        .on(`POST /tenants/${TENANT}/contacts`, { status: 201, body: { data: created } })
        .on(`POST /tenants/${TENANT}/custom-fields`, { status: 409, body: { error: { code: 'field_key_exists', message: 'Key taken.' } } })
        .on(`PATCH /tenants/${TENANT}/contacts/contact-part/metadata`, { status: 409, body: { error: { code: 'entity_version_conflict', message: 'Stale.' } } })
        .on(`POST /tenants/${TENANT}/contacts/contact-part/consents`, { status: 409, body: { error: { code: 'suppression_outranks_consent', message: 'Opted out.' } } })
        .on(`GET /tenants/${TENANT}/contacts/contact-part`, { status: 500, body: { error: { code: 'internal_error', message: 'Down.' } } });
      const { root, app } = await open(api);
      app.dispatch('lang', 'en');
      await fill(root);
      type(root, '[data-form="newContact_city"]', 'Giza');
      click(root, '.contact-new .audience-chip');
      click(root, '.contact-new__consent[data-arg^="newContactMarketing"]');
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();
      const toast = app.state.toasts.at(-1);
      expect(toast?.tone).toBe('danger');
      expect(toast?.text).toContain('City (Key taken.)');
      expect(toast?.text).toContain('details and labels (Stale.)');
      expect(toast?.text).toContain('consent (Opted out.)');
      // The re-read failed, so the record the create returned is kept on screen.
      expect(root.querySelector('.contact[data-contact="contact-part"]')).not.toBeNull();
    });

    it('reports refused details in Arabic', async () => {
      const created = contact({ id: 'contact-ar', version: 1 });
      const api = withCatalogue(contactsApi(MANAGER))
        .on(`POST /tenants/${TENANT}/contacts`, { status: 201, body: { data: created } })
        .on(`PATCH /tenants/${TENANT}/contacts/contact-ar/metadata`, { status: 409, body: { error: { code: 'entity_version_conflict', message: 'قديم.' } } })
        .on(`POST /tenants/${TENANT}/contacts/contact-ar/consents`, { status: 422, body: { error: { code: 'import_is_not_consent', message: 'مرفوض.' } } })
        .on(`GET /tenants/${TENANT}/contacts/contact-ar`, { status: 200, body: { data: created } });
      const { root, app } = await open(api);
      await fill(root);
      click(root, '.contact-new .audience-chip');
      click(root, '.contact-new__consent[data-arg^="newContactService"]');
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();
      expect(app.state.toasts.at(-1)?.text).toContain('البيانات والتصنيفات (قديم.)');
      expect(app.state.toasts.at(-1)?.text).toContain('الموافقة (مرفوض.)');
    });

    it('checks the card before sending anything', async () => {
      const api = withCatalogue(contactsApi(MANAGER));
      const { root, app } = await open(api);
      click(root, '[data-act="live-contact-new"]');
      await settle();
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();
      expect(Object.keys(app.state.formErrors).sort()).toEqual(['contactCreateConnection', 'contactCreateExternalId', 'contactCreateName']);
      expect(root.querySelectorAll('.dialog .field__error').length).toBe(3);
      await fill(root);
      type(root, '[data-form="newContact_email"]', 'hala@');
      type(root, '[data-form="newContactField_f-mobile"]', '0100');
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();
      expect(app.state.formErrors['newContact_email']).toBeTruthy();
      expect(api.calls.some((call) => call.method === 'POST' && call.path === `/tenants/${TENANT}/contacts`)).toBe(false);
      // A channel that went away since the form was filled is refused too.
      app.state.dialogForm = { ...app.state.dialogForm, contactCreateConnection: 'gone', newContact_email: '' };
      click(root, '.dialog [data-act="live-contact-create"]');
      await settle();
      expect(app.state.formErrors['contactCreateConnection']).toBeTruthy();
    });

    it('shapes the card to what the operator may do and what the company has set up', async () => {
      const agentApi = contactsApi(['contact.read', 'contact.edit'])
        .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [] } })
        .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: [catalogue[0]] } });
      const agent = await open(agentApi);
      // Opened before the catalogues were ever read: the dialog reads them.
      agent.app.state.live.labels = { status: 'idle' };
      click(agent.root, '[data-act="live-contact-new"]');
      await settle();
      const dialog = agent.root.querySelector('.dialog') as HTMLElement;
      // No channel yet: said plainly, and nothing can be created.
      expect(text(dialog.querySelector('.contact-new__empty') as HTMLElement)).toContain('لا توجد قناة متصلة');
      expect((dialog.querySelector('[data-act="live-contact-create"]') as HTMLButtonElement).disabled).toBe(true);
      // Only the details the catalogue has; no labels to pick; no consent to record.
      expect(dialog.querySelector('[data-form="newContact_email"]')).not.toBeNull();
      expect(dialog.querySelector('[data-form="newContact_company"]')).toBeNull();
      expect(dialog.querySelector('.audience-chip')).toBeNull();
      expect(dialog.querySelector('.contact-new__consent')).toBeNull();
      agent.app.state.live.customFields = { status: 'ready', value: [], loadedAt: NOW.getTime() };
      agent.app.state.live.connections = { status: 'loading' };
      agent.app.render();
      expect(agent.root.querySelector('.contact-new [aria-labelledby="contact-new-profile"]')).toBeNull();
      expect(text(agent.root.querySelector('.contact-new__empty') as HTMLElement)).toContain('جارٍ تحميل القنوات');
      // A channel other than WhatsApp has no number placeholder.
      agent.app.state.live.connections = { status: 'ready', value: [{ id: 'cn-9', kind: 'messenger', display_name: 'Page', disconnected_at: null }], loadedAt: NOW.getTime() } as never;
      agent.app.state.dialogForm = { contactCreateConnection: 'cn-9' };
      agent.app.render();
      expect((agent.root.querySelector('#contact-new-external') as HTMLInputElement).placeholder).toBe('');
      expect(text(agent.root.querySelector('.contact-new') as HTMLElement)).toContain('PSID');
    });
  });

  it('preserves an explicit contact-creation conflict for the operator', async () => {
    const api = contactsApi()
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } })
      .on(`POST /tenants/${TENANT}/contacts`, { status: 409, body: { error: { code: 'contact_identity_exists', message: 'This channel identity already exists.' } } });
    const { root } = await open(api);
    click(root, '[data-act="live-contact-new"]');
    await settle();
    choose(root, '[data-form="contactCreateConnection"]', 'cn-1');
    type(root, '[data-form="contactCreateName"]', 'Sara');
    type(root, '[data-form="contactCreateExternalId"]', '201000000000');
    click(root, '.dialog [data-act="live-contact-create"]');
    await settle();
    expect(text(root.querySelector('.dialog') as HTMLElement)).toContain('This channel identity already exists.');
  });

  it('previews a small CSV and submits an explicit connection-bound atomic import', async () => {
    const api = contactsApi()
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } })
      .on(`POST /tenants/${TENANT}/contacts/import`, { status: 201, body: { data: { created: 2 } } });
    const { root } = await open(api);
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    choose(root, '[data-form="contactImportConnection"]', 'cn-1');
    const input = root.querySelector('input[data-act="live-contact-import-file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [{ name: 'leads.csv', size: 66, text: async () => 'display_name,external_id\r\nSara,201\r\nMona,202\r\n' }] });
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    expect(text(root)).toContain('جهة جاهزة للاستيراد');
    click(root, '[data-act="live-contacts-import"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path === `/tenants/${TENANT}/contacts/import`)?.body).toEqual({
      connectionId: 'cn-1',
      rows: [{ displayName: 'Sara', externalId: '201' }, { displayName: 'Mona', externalId: '202' }],
    });
    expect(text(root)).toContain('لم تُسجّل موافقات تسويقية');
    expect(root.querySelector('#contacts-tool-import')).toBeNull();
  });

  it('shows a bounded size error and a malformed CSV preview without submitting', async () => {
    const { app, root } = await open(contactsApi().on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } }));
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    const input = root.querySelector('input[data-act="live-contact-import-file"]') as HTMLInputElement;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    Object.defineProperty(input, 'files', { value: [{ name: 'too-large.csv', size: 1_000_001, text: async () => '' }] });
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    expect(text(root)).toContain('حجم الملف أكبر من 1 ميجابايت');
    app.state.dialogForm = { ...app.state.dialogForm, contactImportError: '', contactImportCsv: 'not,the,template', contactImportFileName: 'bad.csv' };
    app.render();
    expect(text(root)).toContain('تعذّرت معاينة الملف');
  });

  it('reports a rejected import and retains a clear failure for the operator', async () => {
    const api = contactsApi()
      .on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } })
      .on(`POST /tenants/${TENANT}/contacts/import`, { status: 409, body: { error: { code: 'contact_import_conflicts', message: 'Duplicate identity.' } } });
    const { root } = await open(api);
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    choose(root, '[data-form="contactImportConnection"]', 'cn-1');
    const input = root.querySelector('input[data-act="live-contact-import-file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [{ name: 'leads.csv', size: 30, text: async () => 'display_name,external_id\nSara,201\n' }] });
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    click(root, '[data-act="live-contacts-import"]');
    await settle();
    expect(text(root)).toContain('Duplicate identity.');
  });

  it('downloads a permission-scoped CSV export and reports export errors', async () => {
    const createObjectURL = vi.fn(() => 'blob:contacts');
    const revokeObjectURL = vi.fn();
    urlCreateDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    urlRevokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const clickDownload = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/export`, {
      status: 200, body: { data: { filename: 'contacts.csv', content: 'display_name\r\nSara', rowCount: 1 } },
    });
    const { root } = await open(api);
    click(root, '[data-act="live-contacts-export"]');
    await settle();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickDownload).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:contacts');

    const failedApi = contactsApi().on(`GET /tenants/${TENANT}/contacts/export`, {
      status: 503, body: { error: { code: 'unavailable', message: 'Export unavailable.' } },
    });
    const failed = await open(failedApi);
    click(failed.root, '[data-act="live-contacts-export"]');
    await settle();
    expect(text(failed.root)).toContain('Export unavailable.');
  });

  it('opens the import tool, reuses loaded channels and closes on request', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } });
    const { app, root } = await open(api);
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    expect(root.querySelector('#contacts-tool-import')).not.toBeNull();
    expect(root.querySelector('[data-act="live-contacts-tool"][data-arg=""][aria-expanded="true"]')).not.toBeNull();
    // The new-contact dialog keeps the channels already fetched.
    click(root, '[data-act="live-contact-new"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(1);
    click(root, '.dialog [data-act="close-dialog"]');
    // A dialog starts a fresh form, so the tool is put away underneath it.
    expect(root.querySelector('#contacts-tool-import')).toBeNull();
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(1);
    // The close control and anything unknown both put the tool away.
    click(root, '#contacts-tool-import [data-act="live-contacts-tool"][data-arg=""]');
    await settle();
    expect(root.querySelector('#contacts-tool-import')).toBeNull();
    app.dispatch('live-contacts-tool', 'create');
    await settle();
    expect(app.state.dialogForm['contactsTool']).toBe('');
    expect(root.querySelector('.contact-tool')).toBeNull();
  });

  it('offers a retry when the channels could not be loaded', async () => {
    let fail = true;
    const api = contactsApi().on(`GET /tenants/${TENANT}/channels`, () => (fail
      ? { status: 503, body: { error: { code: 'unavailable', message: 'Down.' } } }
      : { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } }));
    const { root } = await open(api);
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    expect(root.querySelector('#contacts-tool-import [data-act="live-contact-connections"]')).not.toBeNull();
    click(root, '#contacts-tool-import [data-act="live-contact-connections"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(2);
    // Opening the dialog after a failure asks again, and says what went wrong.
    click(root, '[data-act="live-contact-new"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(3);
    expect(text(root.querySelector('.contact-new__empty') as HTMLElement)).toContain('Down.');
    expect((root.querySelector('.dialog [data-act="live-contact-create"]') as HTMLButtonElement).disabled).toBe(true);
    click(root, '.dialog [data-act="close-dialog"]');
    fail = false;
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/channels`)).toBe(4);
    expect(root.querySelector('#contacts-tool-import [data-act="live-contact-connections"]')).toBeNull();
  });

  it('sums up the loaded list in the hero, and shows a dash until it has one', async () => {
    const label = { id: 'l-1', name: 'VIP', color: '#6558d9', state: 'active', version: 1 };
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 200,
      body: {
        data: [
          contact({ labels: [label] }),
          contact({ id: 'ct-2', displayName: 'Mona Khalil', identities: [
            { id: 'ci-8', kind: 'instagram', scopeId: 'cn-2', externalId: 'mona', validFrom: NOW.toISOString(), validTo: null },
            { id: 'ci-9', kind: 'whatsapp', scopeId: 'cn-1', externalId: '1555', validFrom: NOW.toISOString(), validTo: null },
          ] }),
          contact({ id: 'ct-3', displayName: 'Old number', identities: [
            { id: 'ci-7', kind: 'messenger', scopeId: 'cn-3', externalId: 'x', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2026-01-01T00:00:00.000Z' },
          ] }),
        ],
      },
    });
    const { app, root } = await open(api);
    const values = [...root.querySelectorAll('.contacts-stat__value')].map((node) => node.textContent);
    // Three rows; two reachable; WhatsApp and Instagram live; one labelled.
    expect(values).toEqual(['3', '2', '2', '1']);
    app.state.live.contacts = { status: 'loading' } as never;
    app.render();
    expect([...root.querySelectorAll('.contacts-stat__value')].map((node) => node.textContent)).toEqual(['—', '—', '—', '—']);
  });

  it('offers a two-line CSV template, header then example', async () => {
    const { root } = await open(contactsApi().on(`GET /tenants/${TENANT}/channels`, { status: 200, body: { data: [{ id: 'cn-1', kind: 'whatsapp', display_name: 'Support WhatsApp', disconnected_at: null }] } }));
    click(root, '[data-act="live-contacts-tool"][data-arg="import"]');
    await settle();
    const link = root.querySelector('.contact-transfer__template') as HTMLAnchorElement;
    const body = decodeURIComponent(link.getAttribute('href')?.split(',').slice(1).join(',') ?? '');
    expect(body.split('\r\n')).toEqual(['display_name,external_id', 'Example Customer,201000000000', '']);
  });

  it('tucks the header away while the page scrolls down and brings it back', async () => {
    const { app, root } = await open(contactsApi());
    const shell = root.querySelector('.app') as HTMLElement;
    const page = root.querySelector('[data-scroll="screen"]') as HTMLElement;
    const scrollTo = (element: HTMLElement, top: number): void => {
      element.scrollTop = top;
      element.dispatchEvent(new window.Event('scroll'));
    };
    expect(shell.getAttribute('data-header')).toBe('shown');
    scrollTo(page, 240);
    expect(shell.getAttribute('data-header')).toBe('hidden');
    // A render keeps the choice; the list's own scroll is not the page's.
    app.render();
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('hidden');
    scrollTo(root.querySelector('[data-scroll="contacts"]') as HTMLElement, 0);
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('hidden');
    scrollTo(root.querySelector('[data-scroll="screen"]') as HTMLElement, 120);
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    scrollTo(root.querySelector('[data-scroll="screen"]') as HTMLElement, 400);
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('hidden');
    // Focus arriving in the header shows it; focus elsewhere does not.
    (root.querySelector('[data-scroll="contacts"]') as HTMLElement).dispatchEvent(new window.Event('focusin', { bubbles: true }));
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('hidden');
    (root.querySelector('.header button') as HTMLElement).dispatchEvent(new window.Event('focusin', { bubbles: true }));
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    (root.querySelector('.header button') as HTMLElement).dispatchEvent(new window.Event('focusin', { bubbles: true }));
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    // An open menu lives in the header, so the header stays while it is open.
    app.state.openMenu = 'user';
    scrollTo(root.querySelector('[data-scroll="screen"]') as HTMLElement, 900);
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    app.state.openMenu = null;
    scrollTo(root.querySelector('[data-scroll="screen"]') as HTMLElement, 1200);
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('hidden');
    // Another screen opens with the header back, and a page opens at its top.
    app.dispatch('nav', 'inbox');
    await settle();
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    scrollTo(root.querySelector('[data-scroll="list"]') as HTMLElement, 900);
    app.dispatch('nav', 'contacts');
    await settle();
    expect(root.querySelector('.app')?.getAttribute('data-header')).toBe('shown');
    expect((root.querySelector('[data-scroll="screen"]') as HTMLElement).scrollTop).toBe(0);
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
    expect(text(root)).toContain('لا توجد جهات اتصال بعد');
  });

  it('reports a refusal in the operator’s terms', async () => {
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts`, {
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.' } },
    });
    const { root } = await open(api);
    expect(text(root)).toContain('لا تملك صلاحية لهذا الإجراء');
    // A refusal is not an outage: no retry would change the answer.
    expect(root.querySelector('.errorstate--denied')).not.toBeNull();
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
              kind: 'pigeon',
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
    expect(text(root.querySelector('.contact__identity') as HTMLElement)).toContain('pigeon');
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
    // An empty grid would read as a record that failed to load, so none is drawn.
    expect(root.querySelector('.contact')).not.toBeNull();
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
    // Not "not permitted": the role never came into it, the session did. The
    // workspace closes and only the sign-in form remains.
    expect(text(root)).toContain('انتهت جلستك');
    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(root.querySelector('.contacts, .nav')).toBeNull();
    expect(text(root)).not.toContain('لا تملك صلاحية');
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
    expect(text(root.querySelector('.zone--panel') as HTMLElement)).toContain('لا تملك صلاحية لهذا الإجراء');
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
    click(root, '.zone--panel [data-act="live-consent-panel"][data-arg$="service:granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('سُجّلت الموافقة');
  });

  it('updates contact metadata from the side panel and keeps a refusal visible', async () => {
    const field = { id: FIELD, target: 'contact', key: 'course', name: 'الدورة', type: 'text', options: [], state: 'active', version: 1 };
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: [field] } })
      .on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}/metadata`, {
        status: 409,
        body: { error: { code: 'entity_version_conflict', message: 'Reload the customer.' } },
      });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    const selector = `[data-form="metadata_contact_${CONTACT}_${FIELD}"]`;
    type(root, selector, 'Data Analysis');
    click(root, `[data-act="live-metadata-field"][data-arg="contact|${CONTACT}|${FIELD}"]`);
    await settle();
    expect(app.state.toasts.at(-1)?.tone).toBe('danger');
    expect(app.state.toasts.at(-1)?.text).toBe('Reload the customer.');
  });

  it('refreshes successful contact metadata inside the side panel', async () => {
    const field = { id: FIELD, target: 'contact', key: 'course', name: 'الدورة', type: 'text', options: [], state: 'active', version: 1 };
    let saved = contact({ version: 1, customFields: [] });
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: [field] } })
      .on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, () => ({ status: 200, body: { data: saved } }))
      .on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}/metadata`, () => {
        saved = contact({ version: 2, customFields: [{ fieldId: FIELD, value: 'Data' }] });
        return {
          status: 200,
          body: {
            data: {
              version: 2,
              metadata: { labels: [], customFields: [{ fieldId: FIELD, value: 'Data' }] },
            },
          },
        };
      });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    type(root, `[data-form="metadata_contact_${CONTACT}_${FIELD}"]`, 'Data');
    click(root, `[data-act="live-metadata-field"][data-arg="contact|${CONTACT}|${FIELD}"]`);
    await settle();
    expect(app.state.live.openContact).toMatchObject({ status: 'ready', value: { version: 2 } });
  });

  it('updates conversation metadata in place without consuming the reply draft', async () => {
    const fieldId = '88888888-8888-4888-8888-888888888886';
    const field = { id: fieldId, target: 'conversation', key: 'lead', name: 'Lead', type: 'text', options: [], state: 'active', version: 1 };
    let version = 4;
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: [field] } })
      .on(`GET /tenants/${TENANT}/conversations/${CONVERSATION}`, () => ({
        status: 200,
        body: { data: conversation({ version, labels: [], customFields: [] }) },
      }))
      .on(`PATCH /tenants/${TENANT}/conversations/${CONVERSATION}/metadata`, () => {
        version += 1;
        return { status: 200, body: { data: { version, metadata: { labels: [], customFields: [{ fieldId, value: 'Hot' }] } } } };
      });
    const { root, app } = await open(api, `#/inbox/${CONVERSATION}`);
    app.dispatch('live-composer', 'draft that must stay');
    type(root, `[data-form="metadata_conversation_${CONVERSATION}_${fieldId}"]`, 'Hot');
    click(root, `[data-act="live-metadata-field"][data-arg="conversation|${CONVERSATION}|${fieldId}"]`);
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH' && call.path.endsWith('/metadata'))?.body).toMatchObject({
      version: 4,
      fields: [{ fieldId, value: 'Hot' }],
    });
    expect(app.state.live.composer).toBe('draft that must stay');
    expect(app.state.toasts.at(-1)?.text).toContain('حُفظ الحقل');
  });

  it('keeps a refused conversation label change visible', async () => {
    const label = { id: LABEL, name: 'مهتم', color: '#5865F2', state: 'active', version: 1 };
    const api = inboxApi()
      .on(`GET /tenants/${TENANT}/labels`, { status: 200, body: { data: [label] } })
      .on(`PATCH /tenants/${TENANT}/conversations/${CONVERSATION}/metadata`, {
        status: 409,
        body: { error: { code: 'entity_version_conflict', message: 'Reload the thread.' } },
      });
    const { app } = await open(api, `#/inbox/${CONVERSATION}`);
    app.dispatch('live-metadata-label', `conversation|${CONVERSATION}|${LABEL}|add`);
    await settle();
    expect(app.state.toasts.at(-1)?.tone).toBe('danger');
    expect(app.state.toasts.at(-1)?.text).toBe('Reload the thread.');
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
    app.dispatch('live-consent-screen', `${CONTACT}:marketing:granted`);
    await settle();

    expect(api.calls.filter((call) => call.path.includes('/tenants/'))).toEqual([]);
    expect(api.calls.length).toBe(before);
    expect(text(root)).toContain('لا توجد مساحة عمل نشطة');
    expect(root.querySelector('.nav')).toBeNull();
  });

  it('offers a way back when there is no session', async () => {
    const api = new FakeApi().on('GET /auth/session', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Sign in.' } },
    });
    const { root } = await open(api);
    // Nothing of the directory is drawn for a browser without a session.
    expect(root.querySelector('#signin-email')).not.toBeNull();
    expect(root.querySelector('.contacts, [data-act="live-contacts-reload"]')).toBeNull();
    expect(api.calls.map((call) => call.path)).toEqual(['/auth/session']);
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
    // The session is not asked again: any 401 on the way closes the workspace.
    expect(api.countOf('GET /auth/session')).toBe(1);
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
    click(root, '[data-act="live-consent-screen"][data-arg$="service:withdrawn"]');
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

  it('sums the profile in four facts, with consent in its order of authority', async () => {
    const granted = {
      channel: 'whatsapp', purpose: 'marketing', state: 'granted', source: 'agent_recorded',
      recordedAt: NOW.toISOString(), actorMembershipId: MEMBERSHIP,
    };
    const api = contactsApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, {
      status: 200,
      body: { data: contact({ consent: [granted] }) },
    });
    const { app, root } = await open(api);
    click(root, '.contactrow');
    await settle();
    const facts = (): string[] => [...root.querySelectorAll('.contact__fact')].map((node) => `${node.className}|${node.textContent ?? ''}`);
    expect(facts()[0]).toContain('وسائل سارية1');
    expect(facts()[1]).toContain('contact__fact--success');
    expect(facts()[1]).toContain('موافقة مسجلة');
    expect(facts()[3]).toContain('2026');
    // No marketing record at all is "not recorded", never a silent grant.
    app.state.live.selectedContact = { status: 'ready', loadedAt: NOW.getTime(), value: contact({ consent: [] }) } as never;
    app.render();
    expect(facts()[1]).toContain('contact__fact--warning');
    // An opt-out outranks the grant it sits beside.
    app.state.live.selectedContact = { status: 'ready', loadedAt: NOW.getTime(), value: contact({ consent: [granted], suppressed: ['whatsapp'] }) } as never;
    app.render();
    expect(facts()[1]).toContain('contact__fact--danger');
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
    expect(text(notice as HTMLElement)).toContain('حتى مع وجود موافقة');
    // Above, not beside: the order on screen is the order of authority.
    const list = root.querySelector('.consent__list') as Element;
    expect(notice?.compareDocumentPosition(list)).toBe(window.Node.DOCUMENT_POSITION_FOLLOWING);
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
    click(root, '[data-act="live-consent-screen"][data-arg$="service:granted"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toBe('Consent recorded.');
  });

  it('records marketing consent — the one a campaign needs — and its withdrawal', async () => {
    const granted = { channel: 'whatsapp', purpose: 'marketing', state: 'granted', source: 'agent_recorded', recordedAt: NOW.toISOString(), actorMembershipId: MEMBERSHIP };
    const api = contactsApi().on(`POST /tenants/${TENANT}/contacts/${CONTACT}/consents`, {
      status: 201,
      body: { data: contact({ consent: [granted, { ...granted, purpose: 'service', state: 'withdrawn' }] }) },
    });
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    // Nothing recorded yet: marketing is the primary action on its own row.
    const marketingGrant = root.querySelector('[data-act="live-consent-screen"][data-arg$="marketing:granted"]') as HTMLButtonElement;
    expect(marketingGrant.className).toContain('btn--primary');
    expect(text(root.querySelector('.consent__purpose--none') as HTMLElement)).toContain('غير مسجلة');
    click(root, '[data-act="live-consent-screen"][data-arg$="marketing:granted"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/consents'))?.body).toMatchObject({ purpose: 'marketing', state: 'granted', channel: 'whatsapp' });
    expect(app.state.toasts.at(-1)?.text).toContain('موافقة التسويق');
    // Recorded: the row shows it, and granting again is no longer the primary action.
    expect(root.querySelector('.consent__purpose--granted')).not.toBeNull();
    expect(root.querySelector('.consent__purpose--withdrawn')).not.toBeNull();
    expect((root.querySelector('[data-act="live-consent-screen"][data-arg$="marketing:granted"]') as HTMLButtonElement).className).not.toContain('btn--primary');
    click(root, '[data-act="live-consent-screen"][data-arg$="marketing:withdrawn"]');
    await settle();
    expect(app.state.toasts.at(-1)?.text).toContain('الانسحاب من التسويق');
    const before = api.calls.length;
    app.dispatch('live-consent-screen', `${CONTACT}:marketing:sideways`);
    app.dispatch('live-consent-screen', `${CONTACT}:promotions:granted`);
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('ignores a consent control carrying a state it does not know', async () => {
    const api = contactsApi();
    const { root, app } = await open(api);
    click(root, '.contactrow');
    await settle();
    const before = api.calls.length;
    app.dispatch('live-consent-screen', `${CONTACT}:sideways`);
    app.dispatch('live-consent-screen', CONTACT);
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

describe('labels and typed business fields', () => {
  const definitions = [
    { id: FIELD, target: 'contact', key: 'course', name: 'الدورة', type: 'text', options: [], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888881', target: 'contact', key: 'seats', name: 'المقاعد', type: 'number', options: [], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888882', target: 'contact', key: 'paid', name: 'تم الدفع', type: 'boolean', options: [], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888883', target: 'contact', key: 'start_date', name: 'تاريخ البدء', type: 'date', options: [], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888884', target: 'contact', key: 'level', name: 'المستوى', type: 'single_select', options: ['Beginner', 'Advanced'], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888885', target: 'contact', key: 'topics', name: 'الموضوعات', type: 'multi_select', options: ['Data', 'Marketing'], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888886', target: 'conversation', key: 'lead', name: 'Lead', type: 'text', options: [], state: 'active', version: 1 },
    { id: '88888888-8888-4888-8888-888888888887', target: 'contact', key: 'retired', name: 'Retired', type: 'text', options: [], state: 'retired', version: 2 },
  ];
  const labels = [
    { id: LABEL, name: 'مهتم', color: '#5865F2', state: 'active', version: 1 },
    { id: '77777777-7777-4777-8777-777777777778', name: 'قديم', color: '#777777', state: 'retired', version: 2 },
  ];

  function metadataApi(record: Record<string, unknown> = contact()): FakeApi {
    return contactsApi()
      .on(`GET /tenants/${TENANT}/labels`, { status: 200, body: { data: labels } })
      .on(`GET /tenants/${TENANT}/custom-fields`, { status: 200, body: { data: definitions } })
      .on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, { status: 200, body: { data: record } });
  }

  it('creates a shared label only after the server accepts it', async () => {
    const api = metadataApi().on(`POST /tenants/${TENANT}/labels`, {
      status: 201,
      body: { data: labels[0] },
    });
    const { root } = await open(api);
    type(root, '[data-form="labelName"]', 'مهتم');
    const color = root.querySelector('[data-form="labelColor"]') as HTMLInputElement;
    color.value = '#5865f2';
    color.dispatchEvent(new window.Event('input', { bubbles: true }));
    click(root, '[data-act="live-label-create"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/labels'))?.body).toEqual({ name: 'مهتم', color: '#5865f2' });
    expect(text(root)).toContain('أُنشئ التصنيف');
  });

  it('keeps a catalogue refusal visible', async () => {
    const api = metadataApi().on(`POST /tenants/${TENANT}/labels`, {
      status: 409,
      body: { error: { code: 'label_exists', message: 'Label exists.' } },
    });
    const { root } = await open(api);
    type(root, '[data-form="labelName"]', 'مهتم');
    click(root, '[data-act="live-label-create"]');
    await settle();
    expect(text(root)).toContain('Label exists.');
  });

  it('keeps a custom-field catalogue refusal visible', async () => {
    const api = metadataApi().on(`POST /tenants/${TENANT}/custom-fields`, {
      status: 409,
      body: { error: { code: 'custom_field_exists', message: 'Field key exists.' } },
    });
    const { root, app } = await open(api);
    type(root, '[data-form="fieldName"]', 'الدورة');
    type(root, '[data-form="fieldKey"]', 'course');
    click(root, '[data-act="live-field-create"]');
    await settle();
    expect(app.state.toasts.at(-1)?.tone).toBe('danger');
    expect(text(root)).toContain('Field key exists.');
  });

  it('creates text and select fields from the live catalogue form', async () => {
    const api = metadataApi().on(`POST /tenants/${TENANT}/custom-fields`, {
      status: 201,
      body: { data: definitions[0] },
    });
    const { root, app } = await open(api);
    app.dispatch('lang', 'en');
    type(root, '[data-form="fieldName"]', 'الدورة');
    type(root, '[data-form="fieldKey"]', 'course');
    click(root, '[data-act="live-field-create"]');
    await settle();
    expect(api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/custom-fields'))?.body).toMatchObject({ type: 'text', options: [] });

    type(root, '[data-form="fieldName"]', 'المستوى');
    type(root, '[data-form="fieldKey"]', 'level');
    choose(root, '[data-form="fieldTarget"]', 'conversation');
    choose(root, '[data-form="fieldType"]', 'multi_select');
    type(root, '[data-form="fieldOptions"]', 'Beginner, Advanced');
    click(root, '[data-act="live-field-create"]');
    await settle();
    const posts = api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/custom-fields'));
    expect(posts[1]?.body).toMatchObject({ target: 'conversation', type: 'multi_select', options: ['Beginner', 'Advanced'] });
    expect(app.state.toasts.at(-1)?.text).toBe('Field created.');
  });

  it('renders each field control and sends typed values', async () => {
    const saved = contact({
      version: 2,
      labels: [],
      customFields: [
        { fieldId: FIELD, value: 'Data Analysis' },
        { fieldId: definitions[1]?.id, value: 2 },
        { fieldId: definitions[2]?.id, value: true },
        { fieldId: definitions[3]?.id, value: '2026-10-01' },
        { fieldId: definitions[4]?.id, value: 'Beginner' },
        { fieldId: definitions[5]?.id, value: ['Data', 'Marketing'] },
      ],
    });
    const api = metadataApi(saved).on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}/metadata`, {
      status: 200,
      body: { data: { version: 3, metadata: { labels: [], customFields: [] } } },
    });
    const { root } = await open(api);
    click(root, `[data-act="live-contact-open"][data-arg="${CONTACT}"]`);
    await settle();
    expect(root.querySelectorAll('.metadata__field')).toHaveLength(6);
    expect(root.querySelector('[data-form$="_paid"]')).toBeNull();

    const cases: [number, string, unknown][] = [
      [0, 'Advanced course', 'Advanced course'],
      [1, '4', 4],
      [2, 'false', false],
      [3, '2026-11-01', '2026-11-01'],
      [4, 'Advanced', 'Advanced'],
      [5, 'Data, Marketing', ['Data', 'Marketing']],
    ];
    for (const [index, value, expected] of cases) {
      const definition = definitions[index] as (typeof definitions)[number];
      const selector = `[data-form="metadata_contact_${CONTACT}_${definition.id}"]`;
      const control = root.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
      control.value = value;
      control.dispatchEvent(new window.Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      click(root, `[data-act="live-metadata-field"][data-arg="contact|${CONTACT}|${definition.id}"]`);
      await settle();
      const patches = api.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('/metadata'));
      expect(patches.at(-1)?.body).toMatchObject({ fields: [{ fieldId: definition.id, value: expected }] });
    }
  });

  it('clears a typed value explicitly and refuses incomplete actions locally', async () => {
    const saved = contact({ version: 2, labels: [], customFields: [{ fieldId: FIELD, value: 'Old' }] });
    const api = metadataApi(saved).on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}/metadata`, {
      status: 200,
      body: { data: { version: 3, metadata: { labels: [], customFields: [] } } },
    });
    const { root, app } = await open(api);
    click(root, `[data-act="live-contact-open"][data-arg="${CONTACT}"]`);
    await settle();
    type(root, `[data-form="metadata_contact_${CONTACT}_${FIELD}"]`, '');
    click(root, `[data-act="live-metadata-field"][data-arg="contact|${CONTACT}|${FIELD}"]`);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH').at(-1)?.body).toMatchObject({
      fields: [{ fieldId: FIELD, value: null }],
    });

    const before = api.calls.length;
    for (const [action, arg] of [
      ['live-inbox-filter', 'unknown:value'],
      ['live-contact-filter', 'unknown:value'],
      ['live-metadata-label', 'invalid'],
      ['live-metadata-field', 'invalid'],
      ['live-metadata-label', `conversation|missing|${LABEL}|add`],
      ['live-metadata-field', `conversation|missing|${FIELD}`],
      ['live-metadata-label', `contact|missing|${LABEL}|add`],
      ['live-metadata-field', `contact|missing|${FIELD}`],
    ] as const) app.dispatch(action, arg);
    app.state.dialogForm = { fieldTarget: 'unsupported', fieldType: 'text' };
    app.dispatch('live-field-create');
    app.state.dialogForm = { fieldTarget: 'contact', fieldType: 'unsupported' };
    app.dispatch('live-field-create');
    await settle();
    expect(api.calls.length).toBe(before);
  });

  it('adds, removes and filters labels through the server', async () => {
    let assigned = false;
    const api = metadataApi().on(`GET /tenants/${TENANT}/contacts/${CONTACT}`, () => ({
      status: 200,
      body: { data: contact({ version: assigned ? 2 : 1, labels: assigned ? [labels[0]] : [] }) },
    })).on(`PATCH /tenants/${TENANT}/contacts/${CONTACT}/metadata`, () => {
      assigned = !assigned;
      return {
        status: 200,
        body: { data: { version: assigned ? 2 : 3, metadata: { labels: assigned ? [labels[0]] : [], customFields: [] } } },
      };
    }).on(`GET /tenants/${TENANT}/contacts?label=${LABEL}`, { status: 200, body: { data: [contact()] } });
    const { root } = await open(api);
    click(root, `[data-act="live-contact-open"][data-arg="${CONTACT}"]`);
    await settle();
    choose(root, `[data-form="contact|${CONTACT}"]`, LABEL);
    await settle();
    expect(api.calls.find((call) => call.method === 'PATCH' && call.path.endsWith('/metadata'))?.body).toMatchObject({ addLabels: [LABEL] });
    click(root, `[data-act="live-metadata-label"][data-arg="contact|${CONTACT}|${LABEL}|remove"]`);
    await settle();
    expect(api.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('/metadata')).at(-1)?.body).toMatchObject({ removeLabels: [LABEL] });
    choose(root, '[data-form="labelId"]', LABEL);
    await settle();
    expect(api.countOf(`GET /tenants/${TENANT}/contacts?label=${LABEL}`)).toBe(1);
  });

  it('builds and clears typed contact filters', async () => {
    const path = `/tenants/${TENANT}/contacts?fieldId=${FIELD}&fieldValue=Data+Analysis`;
    const api = metadataApi().on(`GET ${path}`, { status: 200, body: { data: [contact()] } });
    const { root } = await open(api);
    choose(root, '[data-form="fieldId"]', FIELD);
    type(root, '[data-form="contactFieldFilter"]', 'Data Analysis');
    click(root, '[data-act="live-contact-field-filter"]');
    await settle();
    expect(api.countOf(`GET ${path}`)).toBe(1);
    choose(root, '[data-form="fieldId"]', '');
    await settle();
  });
});
