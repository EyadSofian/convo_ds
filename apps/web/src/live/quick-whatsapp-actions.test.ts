import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import { openQuickWhatsApp, sendQuickWhatsApp } from './quick-whatsapp-actions.js';
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
  const send = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'conversation-1', message: { id: 'message-1' } } });
  Object.assign(state.live, { channels: { quickWhatsAppOptions, sendQuickWhatsApp: send } });
  const refresh = vi.fn();
  let keys = 0;
  const context = { state, live: state.live, refresh, now: () => 7, newKey: () => `quick-${++keys}` } as unknown as LiveContext;
  return { state, context, refresh, quickWhatsAppOptions, send };
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

  it('validates number, opt-in and template values before a server mutation', async () => {
    const ctx = setup();
    ctx.state.dialog = { kind: 'quick-whatsapp', arg: '' };
    ctx.state.live.quickWhatsAppOptions = ready(options, 7);
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialogForm = { quickTemplateId: 'template-1', quickPeerIdentity: '+201001234567', quickConsentReference: 'form-123' };
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    ctx.state.dialogForm.quickParam_body_name = 'Mona';
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('tenant-1', 'connection-1', {
      peerIdentity: '+201001234567', consentReference: 'form-123',
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
    ctx.state.dialogForm = { quickConnectionId: 'connection-1', quickTemplateId: 'template-1', quickParam_body_name: 'Mona', quickPeerIdentity: '+201001234567', quickConsentReference: 'form-123' };
    ctx.send.mockResolvedValueOnce({ ok: false, error });
    expect(await sendQuickWhatsApp(ctx.context)).toBe(false);
    expect(ctx.state.live.error).toEqual(error);
    expect(ctx.state.dialogForm.quickMessageId).toBe('quick-1');
    expect(await sendQuickWhatsApp(ctx.context)).toBe(true);
    expect(ctx.send.mock.calls[1]?.[2].clientMessageId).toBe('quick-1');
  });
});
