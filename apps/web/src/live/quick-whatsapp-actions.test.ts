import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import { changeQuickWhatsApp, checkQuickWhatsApp, openQuickWhatsAppCustomer, openQuickWhatsApp, sendQuickWhatsApp } from './quick-whatsapp-actions.js';
import { failed, ready } from './store.js';

vi.mock('./inbox-actions.js', () => ({ loadInboxScreen: vi.fn(), openConversation: vi.fn() }));

const error = { status: 503, code: 'unavailable', message: 'Try again.', requestId: null, details: [] } as const;
const options = {
  connections: [{ id: 'connection-1', displayName: 'Admissions' }],
  templates: [{
    id: 'template-1', connectionId: 'connection-1', providerTemplateId: 'meta-1', templateName: 'follow_up',
    language: 'ar_EG', category: 'marketing', status: 'approved' as const,
    components: [{ type: 'BODY', text: 'مرحبًا {{name}}' }], variables: ['name'], lastSyncedAt: '2026-10-20T00:00:00Z',
  }],
};

function setup() {
  const state = createState(new Date('2026-10-20T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'tenant-1' };
  const quickWhatsAppOptions = vi.fn().mockResolvedValue({ ok: true, data: options });
  const lookup = vi.fn().mockResolvedValue({ ok: true, data: { customer: null } });
  const send = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'conversation-1', message: { id: 'message-1' } } });
  Object.assign(state.live, { channels: { quickWhatsAppOptions, lookupQuickWhatsApp: lookup, sendQuickWhatsApp: send } });
  const refresh = vi.fn();
  let keys = 0;
  const context = { state, live: state.live, refresh, now: () => 7, newKey: () => `quick-${++keys}` } as unknown as LiveContext;
  return { state, context, refresh, quickWhatsAppOptions, lookup, send };
}

describe('quick WhatsApp actions', () => {
  it('opens only outside supervision and busy work, and loads scoped assets', async () => {
    const ctx = setup();
    ctx.state.live.supervisorAgentId = 'other-agent';
    expect(await openQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.live.supervisorAgentId = null;
    ctx.state.live.busy = 'another-action';
    expect(await openQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.live.busy = null;
    expect(await openQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.state.dialog).toEqual({ kind: 'quick-whatsapp', arg: '' });
    expect(ctx.state.dialogForm.quickCountry).toBe('EG');
    expect(ctx.state.live.quickWhatsAppOptions).toEqual(ready(options, 7));
    expect(ctx.quickWhatsAppOptions).toHaveBeenCalledWith('tenant-1');
    ctx.quickWhatsAppOptions.mockResolvedValueOnce({ ok: false, error });
    expect(await openQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.state.live.quickWhatsAppOptions).toEqual(failed(error));
  });

  it('does not fetch without a workspace or send without a quick-message dialog', async () => {
    const ctx = setup();
    ctx.state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: null };
    expect(await openQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.quickWhatsAppOptions).not.toHaveBeenCalled();
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.busy = 'other-action';
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.live.busy = null;
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('validates number and template values, then sends without a manual consent reference', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialogForm = { quickTemplateId: 'template-1', quickPeerIdentity: '+201001234567' };
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialogForm.quickParam_body_name = 'Mona';
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('tenant-1', 'connection-1', {
      peerIdentity: '+201001234567',
      template: { id: 'template-1', parameters: { 'body:name': 'Mona' } }, clientMessageId: 'quick-1',
    });
    expect(ctx.state.dialog).toBeNull();
    expect(ctx.state.inboxQueue).toBe('mine');
    expect(loadInboxScreen).toHaveBeenCalledWith(ctx.context);
    expect(openConversation).toHaveBeenCalledWith(ctx.context, 'conversation-1');
  });

  it('keeps the same idempotency key on a failed retry and reports the provider error', async () => {
    const ctx = setup();
    ctx.state.lang = 'ar';
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    ctx.state.dialogForm = { quickConnectionId: 'connection-1', quickTemplateId: 'template-1', quickParam_body_name: 'Mona', quickPeerIdentity: '+201001234567' };
    ctx.send.mockResolvedValueOnce({ ok: false, error });
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    expect(ctx.state.live.error).toEqual(error);
    expect(ctx.state.dialogForm.quickMessageId).toBe('quick-1');
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.send.mock.calls[1]?.[2].clientMessageId).toBe('quick-1');
  });
  it('normalizes a local Egyptian number, checks it, and queues without a country prefix entered by the agent', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    ctx.state.dialogForm = { quickTemplateId: 'template-1', quickPeerIdentity: '01012345678', quickParam_body_name: 'Mona' };
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.lookup).toHaveBeenCalledWith('tenant-1', 'connection-1', '+201012345678');
    expect(ctx.send.mock.calls[0]?.[2].peerIdentity).toBe('+201012345678');
  });

  it('never sends or claims a number assigned to a colleague', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    ctx.state.dialogForm = { quickPeerIdentity: '01012345678' };
    ctx.lookup.mockResolvedValue({ ok: true, data: { customer: { state: 'other', assigneeName: 'Ahmed', conversationId: null } } });
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    expect(await openQuickWhatsAppCustomer(ctx.context)).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('opens the current agent’s existing conversation without selecting or sending a template', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    ctx.state.dialogForm = { quickPeerIdentity: '01012345678' };
    ctx.lookup.mockResolvedValue({ ok: true, data: { customer: { state: 'mine', conversationId: 'my-existing-thread' } } });
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(openConversation).toHaveBeenCalledWith(ctx.context, 'my-existing-thread');
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('fails closed when lookup fails, when a thread cannot be opened, or when the recipient is invalid', async () => {
    const ctx = setup();
    expect(await checkQuickWhatsApp(ctx.context)).toBe(false);
    expect(await openQuickWhatsAppCustomer(ctx.context)).toBe(false);
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    expect(await checkQuickWhatsApp(ctx.context)).toBe(false);
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialogForm = { quickPeerIdentity: '01012345678' };
    ctx.lookup.mockResolvedValueOnce({ ok: false, error });
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.lookup.mockResolvedValueOnce({ ok: false, error });
    expect(await openQuickWhatsAppCustomer(ctx.context)).toBe(false);
    ctx.lookup.mockResolvedValueOnce({ ok: true, data: { customer: { state: 'mine', conversationId: null } } });
    expect(await openQuickWhatsAppCustomer(ctx.context)).toBe(false);
    ctx.state.live.busy = 'other';
    expect(await openQuickWhatsAppCustomer(ctx.context)).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('discards late checks after the number, line, dialog or pending lookup changes', async () => {
    for (const change of ['number', 'line', 'close', 'pending']) {
      const ctx = setup();
      ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
      ctx.state.live.quickWhatsAppOptions = ready(options, 7);
      ctx.state.dialogForm = { quickPeerIdentity: '01012345678' };
      let resolve!: (value: unknown) => void;
      ctx.lookup.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
      const checking = checkQuickWhatsApp(ctx.context);
      if (change === 'number') ctx.state.dialogForm.quickPeerIdentity = '01112345678';
      if (change === 'line') ctx.state.dialogForm.quickConnectionId = 'another-line';
      if (change === 'close') ctx.state.dialog = null;
      if (change === 'pending') ctx.state.live.quickWhatsAppLookup = null;
      resolve({ ok: true, data: { customer: null } });
      expect(await checking).toBe(false);
    }
  });

  it('debounces edited numbers and never looks up incomplete, replaced or closed drafts', async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      expect(changeQuickWhatsApp(ctx.context, 'quickPeerIdentity:01012345678')).toBe(false);
      ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
      expect(changeQuickWhatsApp(ctx.context, 'invalid')).toBe(false);
      expect(changeQuickWhatsApp(ctx.context, 'unknown:value')).toBe(false);
      expect(changeQuickWhatsApp(ctx.context, 'quickPeerIdentity:01012345678')).toBe(true);
      await vi.advanceTimersByTimeAsync(350);
      expect(ctx.lookup).not.toHaveBeenCalled();
      ctx.state.live.quickWhatsAppOptions = ready(options, 7);
      changeQuickWhatsApp(ctx.context, 'quickCountry:EG');
      changeQuickWhatsApp(ctx.context, 'quickPeerIdentity:01112345678');
      await vi.advanceTimersByTimeAsync(350);
      expect(ctx.lookup).toHaveBeenCalledTimes(1);
      changeQuickWhatsApp(ctx.context, 'quickPeerIdentity:01212345678');
      ctx.state.dialog = null;
      await vi.advanceTimersByTimeAsync(350);
      expect(ctx.lookup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not send or navigate when lookup is invalidated immediately after completing', async () => {
    for (const operation of [sendQuickWhatsApp, openQuickWhatsAppCustomer]) {
      const ctx = setup();
      ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
      ctx.state.live.quickWhatsAppOptions = ready(options, 7);
      ctx.state.dialogForm = { quickPeerIdentity: '01012345678' };
      ctx.refresh.mockImplementation(() => {
        if (ctx.state.live.quickWhatsAppLookup?.result.status === 'ready') ctx.state.live.quickWhatsAppLookup = null;
      });
      expect(await operation(ctx.context)).toBe(false);
      expect(ctx.send).not.toHaveBeenCalled();
    }
    const empty = setup();
    empty.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    empty.state.live.quickWhatsAppOptions = ready({ connections: [], templates: [] }, 7);
    empty.state.dialogForm = { quickPeerIdentity: '01012345678' };
    expect(await checkQuickWhatsApp(empty.context)).toBe(false);
  });

});
