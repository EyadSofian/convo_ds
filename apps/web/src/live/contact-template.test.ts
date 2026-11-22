/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../api/contacts.js';
import type { ChannelsApi } from '../api/channels.js';
import type { WhatsAppTemplate } from '../api/automations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { openContactTemplate, sendContactTemplate } from './contact-actions.js';
import { LIVE_ACTIONS } from './dispatch.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import type * as InboxActions from './inbox-actions.js';
import { ready } from './store.js';

vi.mock('./inbox-actions.js', async (importOriginal) => ({
  ...await importOriginal<typeof InboxActions>(),
  loadInboxScreen: vi.fn(), openConversation: vi.fn(),
}));

const contact: Contact = {
  id: 'contact-1', displayName: 'Mona', attributes: {}, version: 1, labels: [], customFields: [], createdAt: '2026-10-19T00:00:00Z',
  identities: [{ id: 'identity-1', kind: 'whatsapp', scopeId: 'connection-1', externalId: '201500000000', validFrom: '2026-10-19T00:00:00Z', validTo: null }],
  consent: [], suppressed: [],
};
const template: WhatsAppTemplate = {
  id: 'template-1', connectionId: 'operations', providerTemplateId: 'meta-1', templateName: 'course_inquiry_update_ar',
  language: 'ar', category: 'UTILITY', status: 'approved', components: [{ type: 'BODY', text: 'مرحبًا {{1}}، حالة طلبك {{2}}.' }],
  variables: [], lastSyncedAt: '2026-10-19T00:00:00Z',
};

function setup(suppressed: readonly string[] = []) {
  const state = createState(new Date('2026-10-19T12:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'admin@example.com', tenantId: 'tenant-1', memberships: [] };
  state.route = { screen: 'contacts', conversationId: null, params: {} };
  state.live.selectedContact = ready({ ...contact, suppressed }, 1);
  const send = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'operations-thread' } });
  const quickWhatsAppOptions = vi.fn().mockResolvedValue({ ok: true, data: {
    connections: [{ id: 'operations', displayName: 'Operations' }],
    templates: [template],
  } });
  const channels = { sendQuickWhatsApp: send, quickWhatsAppOptions } as unknown as ChannelsApi;
  Object.defineProperty(state.live, 'channels', { value: channels });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'message-key-123', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, send, quickWhatsAppOptions };
}

describe('contact WhatsApp template send', () => {
  it('opens the contact picker and queues an approved text template on the matching number', async () => {
    const { state, context, send } = setup();
    expect(await openContactTemplate(context, contact.id)).toBe(true);
    expect(state.dialog).toEqual({ kind: 'contact-template', arg: contact.id });
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await sendContactTemplate(context)).toBe(true);
    expect(send).toHaveBeenCalledWith('tenant-1', 'operations', {
      contactId: contact.id, peerIdentity: '201500000000',
      template: { id: template.id, parameters: { 'body:1': 'منى', 'body:2': 'مفتوح' } },
      clientMessageId: 'message-key-123',
    });
    expect(state.route).toMatchObject({ screen: 'inbox', conversationId: 'operations-thread' });
    expect(loadInboxScreen).toHaveBeenCalledWith(context);
    expect(openConversation).toHaveBeenCalledWith(context, 'operations-thread');
    expect(state.dialog).toBeNull();
  });

  it('requires a choice between inboxes and rejects templates from a different inbox', async () => {
    const { state, context, send, quickWhatsAppOptions } = setup();
    quickWhatsAppOptions.mockResolvedValue({ ok: true, data: {
      connections: [{ id: 'sales', displayName: 'Sales' }, { id: 'operations', displayName: 'Operations' }],
      templates: [template],
    } });
    state.route = { screen: 'inbox', conversationId: 'sales-thread', params: {} };
    state.live.openContact = state.live.selectedContact;
    state.live.selectedContact = { status: 'idle' };
    await openContactTemplate(context, contact.id);
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await sendContactTemplate(context)).toBe(false);
    state.dialogForm['contactTemplateConnection'] = 'sales';
    expect(await sendContactTemplate(context)).toBe(false);
    state.dialogForm['contactTemplateConnection'] = 'unauthorized';
    expect(await sendContactTemplate(context)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    state.dialogForm['contactTemplateConnection'] = 'operations';
    expect(await sendContactTemplate(context)).toBe(true);
  });

  it('does not queue a contact who opted out or a template with missing values', async () => {
    const blocked = setup(['whatsapp']);
    await openContactTemplate(blocked.context, contact.id);
    blocked.state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await sendContactTemplate(blocked.context)).toBe(false);
    expect(blocked.send).not.toHaveBeenCalled();
    const missing = setup();
    await openContactTemplate(missing.context, contact.id);
    missing.state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى' };
    expect(await sendContactTemplate(missing.context)).toBe(false);
    expect(missing.send).not.toHaveBeenCalled();
  });

  it('refuses stale contact selection and loads the scoped sending options', async () => {
    const { state, context } = setup();
    state.live.selectedContact = { status: 'idle' };
    expect(await openContactTemplate(context, contact.id)).toBe(false);
    state.live.selectedContact = ready(contact, 1);
    expect(await openContactTemplate(context, 'somebody-else')).toBe(false);
    state.live.quickWhatsAppOptions = { status: 'idle' };
    expect(await LIVE_ACTIONS['live-contact-template-open']?.(context, contact.id)).toBe(true);
    expect(state.live.quickWhatsAppOptions.status).toBe('ready');
  });

  it('refuses missing dialog, identity or approved template', async () => {
    const { state, context, send } = setup();
    expect(await sendContactTemplate(context)).toBe(false);
    await openContactTemplate(context, contact.id);
    state.live.selectedContact = { status: 'idle' };
    expect(await sendContactTemplate(context)).toBe(false);
    state.live.selectedContact = ready(contact, 1);
    state.dialog = { kind: 'contact-template', arg: 'wrong-contact' };
    expect(await sendContactTemplate(context)).toBe(false);
    state.dialog = { kind: 'contact-template', arg: contact.id };
    state.live.selectedContact = ready({ ...contact, identities: [] }, 1);
    expect(await sendContactTemplate(context)).toBe(false);
    state.live.selectedContact = ready(contact, 1);
    state.dialogForm = { contactTemplateIdentity: 'missing-identity', contactTemplateId: template.id };
    expect(await sendContactTemplate(context)).toBe(false);
    state.dialogForm = { contactTemplateId: 'missing-template' };
    expect(await sendContactTemplate(context)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores results when the operator closes the contact picker during a request', async () => {
    const { state, context, send, quickWhatsAppOptions } = setup();
    const opening = openContactTemplate(context, contact.id);
    state.dialog = null;
    expect(await opening).toBe(false);
    expect(quickWhatsAppOptions).toHaveBeenCalledOnce();
    await openContactTemplate(context, contact.id);
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    send.mockImplementationOnce(async () => {
      state.dialog = null;
      return { ok: true, data: { conversationId: 'operations-thread' } };
    });
    expect(await sendContactTemplate(context)).toBe(true);
    expect(state.route.screen).toBe('contacts');
    expect(state.live.busy).toBeNull();
  });

  it('keeps the idempotency key on a failed send and lets the operator retry', async () => {
    const { state, context, send } = setup();
    const error = { code: 'provider_unavailable', message: 'Try again', status: 503, requestId: 'req', details: [] };
    send.mockResolvedValueOnce({ ok: false, error });
    await openContactTemplate(context, contact.id);
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await LIVE_ACTIONS['live-contact-template-send']?.(context, '')).toBe(false);
    expect(state.live.error).toEqual(error);
    expect(await sendContactTemplate(context)).toBe(true);
    expect(send.mock.calls[0]?.[2].clientMessageId).toBe(send.mock.calls[1]?.[2].clientMessageId);
  });
});
