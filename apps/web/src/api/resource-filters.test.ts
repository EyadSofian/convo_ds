import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { ContactsApi } from './contacts.js';
import { ConversationsApi } from './conversations.js';
import { MetadataApi } from './metadata.js';

function client() {
  const get = vi.fn().mockResolvedValue({ ok: true, data: [] });
  const post = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const patch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  return {
    value: { get, post, patch } as unknown as ApiClient,
    get,
    post,
    patch,
  };
}

describe('resource query clients', () => {
  it('puts only complete contact filters on the wire', async () => {
    const fake = client();
    const api = new ContactsApi(fake.value);
    await api.list('tenant', ' Sara ');
    await api.list('tenant', { query: '', labelId: '', fieldId: 'field', fieldValue: '' });
    await api.list('tenant', { query: '', labelId: '', fieldId: '', fieldValue: 'orphan' });
    expect(fake.get).toHaveBeenNthCalledWith(1, '/tenants/tenant/contacts?q=Sara');
    expect(fake.get).toHaveBeenNthCalledWith(2, '/tenants/tenant/contacts');
    expect(fake.get).toHaveBeenNthCalledWith(3, '/tenants/tenant/contacts');
  });

  it('encodes every inbox filter and omits every empty one', async () => {
    const fake = client();
    const api = new ConversationsApi(fake.value);
    await api.list('tenant', 'all', {
      unread: 'true', priority: 'urgent', channel: 'whatsapp', labelId: 'label',
    });
    await api.list('tenant', 'mine');
    await api.unassigned('tenant', {
      priority: 'high', channel: 'instagram', labelId: 'label',
    });
    await api.unassigned('tenant');
    expect(fake.get.mock.calls.map(([path]) => path)).toEqual([
      '/tenants/tenant/conversations?queue=all&unread=true&priority=urgent&channel=whatsapp&label=label',
      '/tenants/tenant/conversations?queue=mine',
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
});
