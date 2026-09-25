import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { ChannelsApi } from './channels.js';
import { ContactsApi } from './contacts.js';
import { ConversationsApi } from './conversations.js';
import { MetadataApi } from './metadata.js';

function client() {
  const get = vi.fn().mockResolvedValue({ ok: true, data: [] });
  const page = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
  const post = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const patch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const del = vi.fn().mockResolvedValue({ ok: true, data: {} });
  return {
    value: { get, page, post, patch, delete: del } as unknown as ApiClient,
    get,
    page,
    post,
    patch,
    del,
  };
}

describe('resource query clients', () => {
  it('uses the channel sync route and catalogue-backed conversation template contracts', async () => {
    const fake = client();
    const channels = new ChannelsApi(fake.value);
    const conversations = new ConversationsApi(fake.value);
    await channels.syncWhatsAppTemplates('tenant', 'connection');
    await conversations.whatsappTemplates('tenant', 'conversation');
    await conversations.whatsappTemplates('tenant', 'conversation', {
      search: 'hello world', language: 'en_US', category: 'UTILITY', status: 'approved', cursor: '50',
    });
    await conversations.replyTemplate('tenant', 'conversation', {
      templateId: 'template', parameters: { 'body:1': 'Hello' }, clientMessageId: 'message-key',
    });
    expect(fake.post).toHaveBeenNthCalledWith(1, '/tenants/tenant/channels/connection/templates/sync');
    expect(fake.page).toHaveBeenNthCalledWith(1, '/tenants/tenant/conversations/conversation/whatsapp-templates');
    expect(fake.page).toHaveBeenNthCalledWith(2, '/tenants/tenant/conversations/conversation/whatsapp-templates?search=hello+world&language=en_US&category=UTILITY&status=approved&cursor=50');
    expect(fake.post).toHaveBeenNthCalledWith(2, '/tenants/tenant/conversations/conversation/messages', {
      body: { messageType: 'template', text: '', template: { id: 'template', parameters: { 'body:1': 'Hello' } }, clientMessageId: 'message-key' },
    });
    const failure = { ok: false as const, error: { code: 'unavailable', message: 'Try again.', requestId: null, status: 503, details: [] } };
    fake.page.mockResolvedValueOnce(failure);
    expect(await conversations.whatsappTemplates('tenant', 'conversation')).toEqual(failure);
  });

  it('puts only complete contact filters on the wire', async () => {
    const fake = client();
    const api = new ContactsApi(fake.value);
    await api.list('tenant', ' Sara ');
    await api.list('tenant', { query: '', labelId: '', fieldId: 'field', fieldValue: '' });
    await api.list('tenant', { query: '', labelId: '', fieldId: '', fieldValue: 'orphan' });
    await api.list('tenant', { query: '', labelId: 'label', fieldId: 'field', fieldValue: 'value with spaces' });
    expect(fake.get).toHaveBeenNthCalledWith(1, '/tenants/tenant/contacts?q=Sara');
    expect(fake.get).toHaveBeenNthCalledWith(2, '/tenants/tenant/contacts');
    expect(fake.get).toHaveBeenNthCalledWith(3, '/tenants/tenant/contacts');
    expect(fake.get).toHaveBeenNthCalledWith(4, '/tenants/tenant/contacts?label=label&fieldId=field&fieldValue=value+with+spaces');
  });

  it('sends contact export through the authenticated API client', async () => {
    const fake = client();
    const api = new ContactsApi(fake.value);
    await api.export('tenant');
    expect(fake.get).toHaveBeenCalledWith('/tenants/tenant/contacts/export');
  });

  it('encodes every inbox filter and omits every empty one', async () => {
    const fake = client();
    const api = new ConversationsApi(fake.value);
    await api.list('tenant', {
      queue: 'all', sort: 'activity_desc', limit: 50, cursor: null, search: null,
      filters: [
        { key: 'unread', operator: 'eq', value: true },
        { key: 'priority', operator: 'eq', value: 'urgent' },
        { key: 'channel', operator: 'eq', value: 'whatsapp' },
        { key: 'label_id', operator: 'eq', value: 'label' },
      ],
    });
    await api.list('tenant', { queue: 'mine', sort: 'activity_desc', limit: 50, cursor: null, search: null, filters: [] });
    await api.unassigned('tenant', {
      priority: 'high', channel: 'instagram', labelId: 'label',
    });
    await api.unassigned('tenant');
    expect(fake.page.mock.calls.map(([path]) => path)).toEqual([
      '/tenants/tenant/conversations?queue=all&filter=%7B%22key%22%3A%22unread%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3Atrue%7D&filter=%7B%22key%22%3A%22priority%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22urgent%22%7D&filter=%7B%22key%22%3A%22channel%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22whatsapp%22%7D&filter=%7B%22key%22%3A%22label_id%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22label%22%7D',
      '/tenants/tenant/conversations?queue=mine',
    ]);
    expect(fake.get.mock.calls.map(([path]) => path)).toEqual([
      '/tenants/tenant/conversations/unassigned?priority=high&channel=instagram&label=label',
      '/tenants/tenant/conversations/unassigned',
    ]);
  });

  it('addresses metadata mutations to the selected record type', async () => {
    const fake = client();
    const api = new MetadataApi(fake.value);
    await api.conversation('tenant', 'conversation', { version: 2, addLabels: ['label'] });
    await api.contact('tenant', 'contact', { version: 3, fields: [] });
    expect(fake.patch).toHaveBeenNthCalledWith(
      1,
      '/tenants/tenant/conversations/conversation/metadata',
      { body: { version: 2, addLabels: ['label'] } },
    );
    expect(fake.patch).toHaveBeenNthCalledWith(
      2,
      '/tenants/tenant/contacts/contact/metadata',
      { body: { version: 3, fields: [] } },
    );
  });

  it('covers metadata label mutations and include-retired loading', async () => {
    const fake = client();
    const api = new MetadataApi(fake.value);
    await api.labels('tenant');
    await api.labels('tenant', true);
    await api.updateLabel('tenant', 'label', { version: 2, name: 'VIP', color: '#123456' });
    await api.retireLabel('tenant', 'label', 3);
    expect(fake.get).toHaveBeenLastCalledWith('/tenants/tenant/labels?includeRetired=true');
    expect(fake.patch).toHaveBeenLastCalledWith('/tenants/tenant/labels/label', { body: { version: 2, name: 'VIP', color: '#123456' } });
    expect(fake.del).toHaveBeenCalledWith('/tenants/tenant/labels/label', { body: { version: 3 } });
  });
});
