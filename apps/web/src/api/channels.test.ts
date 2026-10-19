import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { ChannelsApi } from './channels.js';

describe('channel API routes', () => {
  it('subscribes the selected WhatsApp connection to the WABA webhook', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, data: { updated_connections: 2 } });
    const api = new ChannelsApi({ post } as unknown as ApiClient);
    await api.subscribeWhatsAppWebhook('tenant-1', 'channel-1');
    expect(post).toHaveBeenCalledWith('/tenants/tenant-1/channels/channel-1/webhook/subscribe');
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
