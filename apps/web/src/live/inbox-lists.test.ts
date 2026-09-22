import { describe, expect, it, vi } from 'vitest';
import type { ConversationsApi, QueueCard, Conversation } from '../api/conversations.js';
import type { PagedData, ApiResult } from '../api/client.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { refreshInboxLists } from './inbox-lists.js';

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const page = <T>(items: readonly T[]): PagedData<T> => ({ data: items, nextCursor: 'next', hasMore: true });

function setup(supervisorAgentId: string | null) {
  const state = createState(new Date('2026-09-17T00:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
  state.live.supervisorAgentId = supervisorAgentId;
  const api = {
    unassigned: vi.fn().mockResolvedValue(ok([] as readonly QueueCard[])),
    list: vi.fn().mockResolvedValue(ok(page([] as readonly Conversation[]))),
    supervisorList: vi.fn().mockResolvedValue(ok(page([] as readonly Conversation[]))),
  } as unknown as ConversationsApi;
  Object.defineProperty(state.live, 'conversationsApi', { value: api });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, api };
}

describe('refreshInboxLists', () => {
  it('refreshes the normal queue and mine list with the current query', async () => {
    const app = setup(null);
    await refreshInboxLists(app.context);
    expect(app.api.unassigned).toHaveBeenCalledWith('tenant-1', { priority: '', channel: '', labelId: '' });
    expect(app.api.list).toHaveBeenCalledWith('tenant-1', app.state.live.inboxQuery);
    expect(app.api.supervisorList).not.toHaveBeenCalled();
    expect(app.state.live.inboxNextCursor).toBe('next');
  });

  it('uses the supervisor list and does not overwrite unassigned cards', async () => {
    const app = setup('agent-1');
    await refreshInboxLists(app.context);
    expect(app.api.supervisorList).toHaveBeenCalledWith('tenant-1', 'agent-1', app.state.live.inboxQuery);
    expect(app.api.unassigned).toHaveBeenCalled();
    expect(app.api.list).not.toHaveBeenCalled();
  });
});
