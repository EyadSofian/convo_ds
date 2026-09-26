import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/auth.service.js';
import type { ConversationService } from './conversation.service.js';
import type { OutboundService } from '../channels/outbound.service.js';
import type { LifecycleService } from './lifecycle.service.js';
import type { NoteService } from './note.service.js';
import type { RoutingService } from './routing.service.js';
import { ConversationController } from './conversation.controller.js';

const id = '11111111-1111-4111-8111-111111111111';
const request = { id: 'request-1', headers: { cookie: undefined } } as unknown as FastifyRequest;

function controller() {
  const auth = { authenticate: vi.fn(async () => ({ userId: 'user-1' })) } as unknown as AuthService;
  const conversations = {
    unassigned: vi.fn(async () => []),
    supervisorAgents: vi.fn(async () => []),
    supervisorList: vi.fn(async () => ({ items: [], nextCursor: null })),
    supervisorWorkload: vi.fn(async () => ({ assigned: 0 })),
  } as unknown as ConversationService;
  const outbound = { templates: vi.fn(async () => ({ items: [], nextCursor: null })) } as unknown as OutboundService;
  return { instance: new ConversationController(auth, conversations, outbound, {} as LifecycleService, {} as NoteService, {} as RoutingService), conversations, outbound };
}

describe('ConversationController query boundaries', () => {
  it('refuses an archive request that is not a restore or delete of named conversations', async () => {
    const auth = { authenticate: vi.fn(async () => ({ userId: 'user-1' })), requireCsrf: vi.fn() } as unknown as AuthService;
    const lifecycle = { archived: vi.fn(async () => ({ done: [id], refused: [] })) } as unknown as LifecycleService;
    const instance = new ConversationController(auth, {} as ConversationService, {} as OutboundService, lifecycle, {} as NoteService, {} as RoutingService);
    for (const body of [null, [id], { action: 'restore' }, { action: 'purge', conversationIds: [id] }, { action: 'delete', conversationIds: ['bad'] }]) {
      await expect(instance.archived(id, body, 'csrf', request)).rejects.toMatchObject({ status: 400 });
    }
    await expect(instance.archived(id, { action: 'delete', conversationIds: [id] }, 'csrf', request)).resolves.toMatchObject({ data: { done: [id] } });
    expect(lifecycle.archived).toHaveBeenCalledWith(expect.anything(), id, 'delete', [id]);
  });

  it('normalizes supported unassigned query values and de-duplicates labels', async () => {
    const { instance, conversations } = controller();
    const result = await instance.unassigned(id, id, 'urgent', 'instagram', [id, id], request);
    expect(result.data).toEqual([]);
    expect(conversations.unassigned).toHaveBeenCalledWith(expect.anything(), id, { connectionId: id, priority: 'urgent', channel: 'instagram', labelIds: [id] });
  });

  it('rejects invalid unassigned priority, channel, UUID and label lists', async () => {
    const { instance } = controller();
    await expect(instance.unassigned(id, id, 'critical', undefined, undefined, request)).rejects.toMatchObject({ status: 400 });
    await expect(instance.unassigned(id, id, undefined, 'telegram', undefined, request)).rejects.toMatchObject({ status: 400 });
    await expect(instance.unassigned(id, id, undefined, undefined, 'bad', request)).rejects.toMatchObject({ status: 400 });
    const labels = Array.from({ length: 21 }, () => id);
    await expect(instance.unassigned(id, id, undefined, undefined, labels, request)).rejects.toMatchObject({ status: 400 });
  });

  it('requires a valid supervisor agent UUID and preserves the query vocabulary', async () => {
    const { instance, conversations } = controller();
    await expect(instance.supervisorWorkload(id, undefined, request)).rejects.toMatchObject({ status: 400 });
    await expect(instance.supervisorList(id, undefined, {}, request)).rejects.toMatchObject({ status: 400 });
    await expect(instance.supervisorList(id, 'bad', {}, request)).rejects.toMatchObject({ status: 400 });
    await expect(instance.supervisorList(id, id, { queue: 'all', sort: 'activity_desc', limit: '1' }, request)).resolves.toMatchObject({ data: [] });
    expect(conversations.supervisorList).toHaveBeenCalledWith(expect.anything(), id, id, expect.objectContaining({ queue: 'all', limit: 1 }));
  });

  it('validates the WhatsApp template status filter and bounds the catalogue query before delegation', async () => {
    const { instance, outbound } = controller();
    await expect(instance.whatsappTemplates(id, id, { status: 'sending' }, request)).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    await expect(instance.whatsappTemplates(id, id, {
      search: '  hello  ', language: ' en_US ', category: ' UTILITY ', cursor: '50',
    }, request)).resolves.toMatchObject({ data: [], page: { next_cursor: null } });
    expect(outbound.templates).toHaveBeenCalledWith(expect.anything(), id, id, {
      search: 'hello', language: 'en_US', category: 'utility', status: 'approved', cursor: '50',
    });
  });
});
