import { describe, expect, it, vi } from 'vitest';
import type { Conversation, WhatsAppTemplateCatalogueItem } from '../api/conversations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadMoreWhatsAppTemplates, openWhatsAppTemplates, refreshWhatsAppTemplates, searchWhatsAppTemplates, sendReply, sendWhatsAppTemplate, templateParameterKey } from './inbox-actions.js';
import { failed, ready } from './store.js';

const error = { status: 503, code: 'unavailable', message: 'Try again.', requestId: null, details: [] } as const;
const template: WhatsAppTemplateCatalogueItem = {
  id: 'template-id', providerTemplateId: 'meta-template', name: 'hello', language: 'en_US', category: 'utility', status: 'approved',
  components: [{ type: 'body', text: 'Hello {{1}}', format: null, buttons: [] }],
  parameters: [{ key: 'body:1', component: 'body', index: null, position: 1, example: null }],
  sendSupported: true, unsupportedReason: null, lastSyncedAt: '2026-09-23T00:00:00Z',
};
const conversation = (channel = 'whatsapp'): Conversation => ({
  id: 'conversation-id', connectionId: 'connection-id', peerIdentity: 'visitor', teamId: null, assigneeMembershipId: null,
  status: 'open', priority: 'normal', version: 1, waitingSince: null, inboxLabel: 'WhatsApp', channel,
  participantMembershipIds: [], contactId: null, pendingReason: null, snoozedUntil: null, snoozeTimezone: null,
  resolution: null, resolvedAt: null, lastActivityAt: '2026-09-23T00:00:00Z', ownerState: 'human_active', ownerVersion: 0, labels: [], customFields: [],
  serviceWindow: { status: 'closed', lastCustomerInboundAt: null, serviceWindowExpiresAt: null },
} as Conversation);

function setup() {
  const state = createState(new Date('2026-09-23T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@example.test', memberships: [], tenantId: 'tenant-id' };
  state.live.openConversationId = 'conversation-id';
  state.live.openConversation = ready(conversation(), 1);
  const whatsappTemplates = vi.fn().mockResolvedValue({ ok: true, data: { items: [template], nextCursor: null } });
  const replyTemplate = vi.fn().mockResolvedValue({ ok: true, data: { id: 'message-id' } });
  const reply = vi.fn().mockResolvedValue({ ok: false, error: { ...error, code: 'outside_service_window', message: 'The 24-hour window closed.' } });
  const timeline = vi.fn().mockResolvedValue({ ok: true, data: { messages: [], nextCursor: null } });
  const syncWhatsAppTemplates = vi.fn().mockResolvedValue({ ok: true, data: { synced: 1 } });
  Object.assign(state.live, {
    conversationsApi: { whatsappTemplates, replyTemplate, reply, timeline },
    channels: { syncWhatsAppTemplates },
  });
  const refresh = vi.fn();
  let key = 0;
  const context = { state, live: state.live, refresh, now: () => 2, newKey: () => `message-${++key}`, endSession: vi.fn(), switchWorkspace: vi.fn() } as unknown as LiveContext;
  return { state, context, whatsappTemplates, replyTemplate, reply, timeline, syncWhatsAppTemplates };
}

describe('WhatsApp template inbox actions', () => {
  it('opens the local picker and loads its bounded catalogue; failures remain visible', async () => {
    const ctx = setup();
    expect(await openWhatsAppTemplates(ctx.context)).toBe(true);
    expect(ctx.state.dialog).toEqual({ kind: 'whatsapp-template', arg: 'conversation-id' });
    expect(ctx.state.live.conversationTemplates).toEqual(ready([template], 2));
    ctx.whatsappTemplates.mockResolvedValueOnce({ ok: false, error });
    expect(await openWhatsAppTemplates(ctx.context)).toBe(false);
    expect(ctx.state.live.conversationTemplates).toEqual(failed(error));
    expect(ctx.state.live.error).toEqual(error);
  });

  it('refuses opening for non-WhatsApp, supervisor, missing conversation, or missing tenant', async () => {
    const ctx = setup();
    ctx.state.live.openConversation = ready(conversation('messenger'), 1);
    expect(await openWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.live.openConversation = ready(conversation(), 1);
    ctx.state.live.supervisorAgentId = 'agent-id';
    expect(await openWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.live.supervisorAgentId = null;
    ctx.state.live.openConversation = { status: 'idle' } as never;
    expect(await openWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.live.openConversation = ready(conversation(), 1);
    ctx.state.live.session = { status: 'signed_in', email: 'owner@example.test', memberships: [], tenantId: null };
    expect(await openWhatsAppTemplates(ctx.context)).toBe(false);
  });

  it('applies server-side search filters and cursor pagination while preserving loaded rows', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'whatsapp-template', arg: 'conversation-id' };
    ctx.state.dialogForm = { whatsappTemplateSearch: ' hello ', whatsappTemplateLanguage: 'en_US', whatsappTemplateCategory: 'utility', whatsappTemplateStatus: 'approved' };
    expect(await searchWhatsAppTemplates(ctx.context)).toBe(true);
    expect(ctx.whatsappTemplates).toHaveBeenCalledWith('tenant-id', 'conversation-id', { search: 'hello', language: 'en_US', category: 'utility', status: 'approved' });
    ctx.state.live.conversationTemplateCursor = '50';
    ctx.whatsappTemplates.mockResolvedValueOnce({ ok: true, data: { items: [{ ...template, id: 'template-2' }], nextCursor: null } });
    expect(await loadMoreWhatsAppTemplates(ctx.context)).toBe(true);
    expect(ctx.state.live.conversationTemplates).toEqual(ready([template, { ...template, id: 'template-2' }], 2));
    expect(ctx.whatsappTemplates).toHaveBeenLastCalledWith('tenant-id', 'conversation-id', expect.objectContaining({ cursor: '50' }));
    ctx.state.live.conversationTemplateCursor = null;
    expect(await loadMoreWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.dialog = null;
    expect(await searchWhatsAppTemplates(ctx.context)).toBe(false);
    expect(await loadMoreWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.dialog = { kind: 'whatsapp-template', arg: 'conversation-id' };
    ctx.state.live.conversationTemplateCursor = '100';
    ctx.whatsappTemplates.mockResolvedValueOnce({ ok: false, error });
    expect(await loadMoreWhatsAppTemplates(ctx.context)).toBe(false);
    expect(ctx.state.live.error).toEqual(error);
    ctx.whatsappTemplates.mockResolvedValueOnce({ ok: false, error });
    expect(await searchWhatsAppTemplates(ctx.context)).toBe(false);
  });

  it('refreshes only on explicit request and reports provider failure', async () => {
    const ctx = setup();
    ctx.state.dialog = null;
    expect(await refreshWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.dialog = { kind: 'whatsapp-template', arg: 'conversation-id' };
    ctx.state.live.openConversation = { status: 'loading' } as never;
    expect(await refreshWhatsAppTemplates(ctx.context)).toBe(false);
    ctx.state.live.openConversation = ready(conversation(), 1);
    ctx.syncWhatsAppTemplates.mockResolvedValueOnce({ ok: false, error });
    expect(await refreshWhatsAppTemplates(ctx.context)).toBe(false);
    expect(ctx.state.live.error).toEqual(error);
    ctx.syncWhatsAppTemplates.mockResolvedValueOnce({ ok: true, data: { synced: 1 } });
    expect(await refreshWhatsAppTemplates(ctx.context)).toBe(true);
    expect(ctx.syncWhatsAppTemplates).toHaveBeenCalledTimes(2);
    expect(ctx.whatsappTemplates).toHaveBeenCalledTimes(1);
  });

  it('requires a supported approved template and all values before sending', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'whatsapp-template', arg: 'conversation-id' };
    ctx.state.live.conversationTemplates = ready([template], 1);
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    ctx.state.dialogForm.whatsappTemplateId = template.id;
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    expect(ctx.state.live.error?.code).toBe('template_parameters_invalid');
    ctx.state.dialogForm.whatsappTemplateParameter_body_1 = 'مرحبا <&>';
    ctx.replyTemplate.mockResolvedValueOnce({ ok: false, error });
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    expect(ctx.state.dialogForm.whatsappTemplateClientMessageId).toBe('message-1');
    expect(ctx.state.live.error).toEqual(error);
    expect(ctx.state.dialog?.kind).toBe('whatsapp-template');
    ctx.replyTemplate.mockResolvedValueOnce({ ok: true, data: { id: 'message-id' } });
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(true);
    expect(ctx.state.dialog).toBeNull();
    expect(ctx.state.dialogForm).toEqual({});
    expect(ctx.replyTemplate).toHaveBeenLastCalledWith('tenant-id', 'conversation-id', {
      templateId: template.id, parameters: { 'body:1': 'مرحبا <&>' }, clientMessageId: 'message-1',
    });
    expect(ctx.timeline).toHaveBeenCalledWith('tenant-id', 'conversation-id', null);
  });

  it('keeps invalid state and maps colon-delimited provider keys to form-safe keys', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'whatsapp-template', arg: 'conversation-id' };
    ctx.state.live.conversationTemplates = ready([{ ...template, sendSupported: false }, { ...template, id: 'pending', status: 'pending' }], 1);
    ctx.state.dialogForm.whatsappTemplateId = template.id;
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    ctx.state.dialogForm.whatsappTemplateId = 'pending';
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    ctx.state.dialog = null;
    expect(await sendWhatsAppTemplate(ctx.context)).toBe(false);
    expect(templateParameterKey('button:0:1')).toBe('whatsappTemplateParameter_button_0_1');
  });

  it('preserves typed free-form text and switches to the closed-window state after server expiry rejection', async () => {
    const ctx = setup();
    ctx.state.live.composer = 'A careful reply that must not be lost';
    expect(await sendReply(ctx.context)).toBe(false);
    expect(ctx.state.live.composer).toBe('A careful reply that must not be lost');
    expect(ctx.state.live.openConversation.status).toBe('ready');
    if (ctx.state.live.openConversation.status === 'ready') expect(ctx.state.live.openConversation.value.serviceWindow?.status).toBe('closed');
    expect(ctx.state.live.error?.code).toBe('outside_service_window');
  });
});
