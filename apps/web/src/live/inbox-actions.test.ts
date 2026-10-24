import { describe, expect, it, vi } from 'vitest';
import type { Conversation, WhatsAppTemplateCatalogueItem } from '../api/conversations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { applyRealtimeEvent, claimConversation, loadMoreWhatsAppTemplates, openConversation, openWhatsAppTemplates, refreshWhatsAppTemplates, searchWhatsAppTemplates, sendReply, sendWhatsAppTemplate, templateParameterKey } from './inbox-actions.js';
import type { RealtimeEvent } from './realtime.js';
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

describe('a thread switched while it was loading', () => {
  function thread(id: string, contactId: string | null = null): Conversation {
    return { ...conversation(), id, contactId };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function threadsSetup() {
    const ctx = setup();
    const empty = { ok: true, data: [] };
    const api = {
      read: vi.fn(),
      timeline: vi.fn().mockResolvedValue({ ok: true, data: { messages: [], nextCursor: null } }),
      notes: vi.fn().mockResolvedValue(empty),
      episodes: vi.fn().mockResolvedValue(empty),
      handoffs: vi.fn().mockResolvedValue(empty),
      collaborators: vi.fn().mockResolvedValue(empty),
      markRead: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      unassigned: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      list: vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } }),
      claim: vi.fn(),
    };
    Object.assign(ctx.state.live, { conversationsApi: api });
    return { ...ctx, api };
  }

  it("does not let the first thread's answer land on the second one", async () => {
    const ctx = threadsSetup();
    const slow = deferred<unknown>();
    ctx.api.read.mockImplementation(async (_tenant: string, id: string) => (id === 'a' ? slow.promise : { ok: true, data: thread('b') }));
    const first = openConversation(ctx.context, 'a');
    await openConversation(ctx.context, 'b');
    slow.resolve({ ok: true, data: thread('a') });
    await first;
    expect(ctx.state.live.openConversationId).toBe('b');
    expect(ctx.state.live.openConversation).toMatchObject({ status: 'ready', value: { id: 'b' } });
    // Only the thread that is open was marked read.
    expect(ctx.api.markRead).toHaveBeenCalledTimes(1);
    expect(ctx.api.markRead).toHaveBeenCalledWith('tenant-id', 'b');
  });

  it('drops a realtime timeline read for a thread that is no longer open', async () => {
    const ctx = threadsSetup();
    ctx.state.live.openConversationId = 'a';
    ctx.api.read.mockResolvedValue({ ok: true, data: thread('a') });
    const slow = deferred<unknown>();
    ctx.api.timeline.mockReturnValueOnce(slow.promise);
    const event = { type: 'message.inbound', scope: { conversationId: 'a' } } as unknown as RealtimeEvent;
    const applying = applyRealtimeEvent(ctx.context, event);
    ctx.state.live.openConversationId = 'b';
    ctx.state.live.timeline = ready([], 1);
    slow.resolve({ ok: true, data: { messages: [{ id: 'from-a' }], nextCursor: null } });
    await applying;
    expect(ctx.state.live.timeline).toEqual(ready([], 1));
  });

  it('keeps the WhatsApp window known after a claim whose answer omits it', async () => {
    const ctx = threadsSetup();
    const open = { ...conversation(), serviceWindow: { status: 'open' as const, lastCustomerInboundAt: null, serviceWindowExpiresAt: null } };
    ctx.state.live.openConversation = ready(open, 1);
    const { serviceWindow: _dropped, ...claimed } = { ...open, assigneeMembershipId: 'me', version: 2 };
    void _dropped;
    ctx.api.claim.mockResolvedValue({ ok: true, data: claimed });
    expect(await claimConversation(ctx.context, 'conversation-id', 1)).toBe(true);
    expect(ctx.state.live.openConversation).toMatchObject({ status: 'ready', value: { assigneeMembershipId: 'me', serviceWindow: { status: 'open' } } });
  });

  it('reads the window when a claim from the queue answers without it', async () => {
    const ctx = threadsSetup();
    ctx.state.live.composer = 'typed for another customer';
    const { serviceWindow: _dropped, ...claimed } = { ...thread('queued'), assigneeMembershipId: 'me' };
    void _dropped;
    ctx.api.claim.mockResolvedValue({ ok: true, data: claimed });
    ctx.api.read.mockResolvedValue({ ok: true, data: { ...thread('queued'), assigneeMembershipId: 'me', serviceWindow: { status: 'open', lastCustomerInboundAt: null, serviceWindowExpiresAt: null } } });
    expect(await claimConversation(ctx.context, 'queued', 1)).toBe(true);
    expect(ctx.api.read).toHaveBeenCalledWith('tenant-id', 'queued');
    expect(ctx.state.live.openConversation).toMatchObject({ value: { id: 'queued', serviceWindow: { status: 'open' } } });
    // What was typed for the previous customer does not follow the agent.
    expect(ctx.state.live.composer).toBe('');
  });
});
