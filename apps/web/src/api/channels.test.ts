import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { ChannelsApi } from './channels.js';

describe('channel API routes', () => {
  it('fetches sendable quick WhatsApp options and queues the selected template', async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, data: { connections: [], templates: [] } });
    const post = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'conversation-1' } });
    const api = new ChannelsApi({ get, post } as unknown as ApiClient);
    await api.quickWhatsAppOptions('tenant-1');
    expect(get).toHaveBeenCalledWith('/tenants/tenant-1/quick-whatsapp/options');
    const input = { peerIdentity: '+201001234567', consentReference: 'form-123', template: { id: 'template-1', parameters: { 'body:1': 'Mona' } }, clientMessageId: 'quick-key-1' };
    await api.sendQuickWhatsApp('tenant-1', 'channel-1', input);
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/quick-messages', { body: input });
  });
  it('subscribes the selected WhatsApp connection to the WABA webhook', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { updated_connections: 2 } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await api.subscribeWhatsAppWebhook('tenant-1', 'channel-1');
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/webhook/subscribe');
  });
  it('requeues unresolved Meta sender names on the selected connection', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { queued: 2 } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await expect(api.retrySenderProfiles('tenant-1', 'channel-1')).resolves.toEqual({ ok: true, data: { queued: 2 } });
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/sender-profiles/retry');
  });
  it('sends a linked Instagram Page only to the DS backend', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { id: 'channel-1' } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await api.setInstagramPage('tenant-1', 'channel-1', '483612954841071');
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/instagram-page', {
      body: { facebookPageId: '483612954841071' },
    });
  });

  it('changes our own channels’ settings on their own route', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { id: 'channel-1' } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await api.updateSettings('tenant-1', 'channel-1', { origins: [], outboundUrl: null });
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/settings', { body: { origins: [], outboundUrl: null } });
  });

  it('queues a contact template through the channel API with an idempotency key', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { id: 'message-1' } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await api.sendContactTemplate('tenant-1', 'channel-1', '201500000000', 'template-1', { 'body:1': 'Mona' }, 'message-key-123');
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/messages', {
      body: { peerIdentity: '201500000000', messageType: 'template', text: '', template: { id: 'template-1', parameters: { 'body:1': 'Mona' } }, clientMessageId: 'message-key-123', trafficClass: 'interactive' },
    });
  });
});
