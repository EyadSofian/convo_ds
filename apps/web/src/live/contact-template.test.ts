/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../api/contacts.js';
import type { ChannelsApi } from '../api/channels.js';
import type { AutomationsApi, WhatsAppTemplate } from '../api/automations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { openContactTemplate, sendContactTemplate } from './contact-actions.js';
import { LIVE_ACTIONS } from './dispatch.js';
import { ready } from './store.js';

const contact: Contact = {
  id: 'contact-1', displayName: 'Mona', attributes: {}, version: 1, labels: [], customFields: [], createdAt: '2026-10-19T00:00:00Z',
  identities: [{ id: 'identity-1', kind: 'whatsapp', scopeId: 'connection-1', externalId: '201500000000', validFrom: '2026-10-19T00:00:00Z', validTo: null }],
  consent: [], suppressed: [],
};
const template: WhatsAppTemplate = {
  id: 'template-1', connectionId: 'connection-1', providerTemplateId: 'meta-1', templateName: 'course_inquiry_update_ar',
  language: 'ar', category: 'UTILITY', status: 'approved', components: [{ type: 'BODY', text: 'مرحبًا {{1}}، حالة طلبك {{2}}.' }],
  variables: [], lastSyncedAt: '2026-10-19T00:00:00Z',
};

function setup(suppressed: readonly string[] = []) {
  const state = createState(new Date('2026-10-19T12:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'admin@example.com', tenantId: 'tenant-1', memberships: [] };
  state.live.selectedContact = ready({ ...contact, suppressed }, 1);
  const send = vi.fn().mockResolvedValue({ ok: true, data: { id: 'message-1', command_state: 'queued' } });
  const channels = { sendContactTemplate: send, connections: vi.fn().mockResolvedValue({ ok: true, data: [] }) } as unknown as ChannelsApi;
  const automationsApi = { whatsappTemplates: vi.fn().mockResolvedValue({ ok: true, data: [template] }) } as unknown as AutomationsApi;
  Object.defineProperty(state.live, 'channels', { value: channels });
  Object.defineProperty(state.live, 'automationsApi', { value: automationsApi });
  state.live.connections = ready([{ id: 'connection-1', kind: 'whatsapp', status: 'healthy' }] as never, 1);
  state.live.whatsappTemplates = ready([template], 1);
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'message-key-123', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, send };
}

describe('contact WhatsApp template send', () => {
  it('opens the contact picker and queues an approved text template on the matching number', async () => {
    const { state, context, send } = setup();
    expect(await openContactTemplate(context, contact.id)).toBe(true);
    expect(state.dialog).toEqual({ kind: 'contact-template', arg: contact.id });
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await sendContactTemplate(context)).toBe(true);
    expect(send).toHaveBeenCalledWith('tenant-1', 'connection-1', '201500000000', template.id, { 'body:1': 'منى', 'body:2': 'مفتوح' }, 'message-key-123');
    expect(state.dialog).toBeNull();
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

  it('refuses stale contact selection and loads channel and template catalogues when needed', async () => {
    const { state, context } = setup();
    state.live.selectedContact = { status: 'idle' };
    expect(await openContactTemplate(context, contact.id)).toBe(false);
    state.live.selectedContact = ready(contact, 1);
    expect(await openContactTemplate(context, 'somebody-else')).toBe(false);
    state.live.connections = { status: 'idle' };
    state.live.whatsappTemplates = { status: 'idle' };
    expect(await LIVE_ACTIONS['live-contact-template-open']?.(context, contact.id)).toBe(true);
    expect(state.live.connections.status).toBe('ready');
    expect(state.live.whatsappTemplates.status).toBe('ready');
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

  it('keeps the idempotency key on a failed send and lets the operator retry', async () => {
    const { state, context, send } = setup();
    const error = { code: 'provider_unavailable', message: 'Try again', status: 503, requestId: 'req', details: [] };
    send.mockResolvedValueOnce({ ok: false, error });
    await openContactTemplate(context, contact.id);
    state.dialogForm = { contactTemplateId: template.id, contactTemplateParam_body_1: 'منى', contactTemplateParam_body_2: 'مفتوح' };
    expect(await LIVE_ACTIONS['live-contact-template-send']?.(context, '')).toBe(false);
    expect(state.live.error).toEqual(error);
    expect(await sendContactTemplate(context)).toBe(true);
    expect(send.mock.calls[0]?.at(-1)).toBe(send.mock.calls[1]?.at(-1));
  });
});
