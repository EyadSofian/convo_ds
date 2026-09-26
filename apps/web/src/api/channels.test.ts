import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { ChannelsApi } from './channels.js';

describe('channel API routes', () => {
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
});
