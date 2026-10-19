/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../api/contacts.js';
import type { ChannelsApi } from '../api/channels.js';
import type { AutomationsApi, WhatsAppTemplate } from '../api/automations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { openContactTemplate, sendContactTemplate } from './contact-actions.js';
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
});
