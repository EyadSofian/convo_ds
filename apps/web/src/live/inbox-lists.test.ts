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

/** A response the test releases by hand, to put answers in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const row = (id: string) => ({ id }) as unknown as Conversation;
type ListPage = { readonly items: readonly Conversation[]; readonly nextCursor: string | null };
const listOf = (...ids: string[]): ApiResult<ListPage> => ok({ items: ids.map(row), nextCursor: null });

describe('refreshInboxLists under load', () => {
  it('folds a burst of refreshes into the running read plus one more', async () => {
    const app = setup(null);
    const first = deferred<ApiResult<ListPage>>();
    (app.api.list as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(listOf('after'));
    const calls = Array.from({ length: 20 }, () => refreshInboxLists(app.context));
    first.resolve(listOf('before'));
    await Promise.all(calls);
    // Twenty realtime events used to be twenty pairs of requests.
    expect(app.api.list).toHaveBeenCalledTimes(2);
    expect(app.api.unassigned).toHaveBeenCalledTimes(2);
    // And every caller saw a read that started after it asked.
    expect(app.state.live.conversations).toMatchObject({ status: 'ready', value: [{ id: 'after' }] });
  });

  it('never lets an older answer overwrite a newer read', async () => {
    const app = setup(null);
    const stale = deferred<ApiResult<ListPage>>();
    (app.api.list as ReturnType<typeof vi.fn>).mockReturnValueOnce(stale.promise);
    const running = refreshInboxLists(app.context);
    // A newer read — a sort change, say — takes the lists and lands first.
    const { claimInboxRead } = await import('./inbox-lists.js');
    const newer = claimInboxRead(app.state.live);
    app.state.live.conversations = { status: 'ready', value: [row('newer')], loadedAt: 2 };
    expect(newer()).toBe(true);
    stale.resolve(listOf('stale'));
    await running;
    expect(app.state.live.conversations).toMatchObject({ value: [{ id: 'newer' }] });
  });

  it('turns placeholders into an error rather than leaving them up when the read fails', async () => {
    const app = setup(null);
    app.state.live.conversations = { status: 'loading' };
    app.state.live.unassigned = { status: 'loading' };
    const refusal = { ok: false as const, error: { code: 'network', message: 'down', requestId: null, status: null, details: [] } };
    (app.api.list as ReturnType<typeof vi.fn>).mockResolvedValue(refusal);
    (app.api.unassigned as ReturnType<typeof vi.fn>).mockResolvedValue(refusal);
    await refreshInboxLists(app.context);
    expect(app.state.live.conversations.status).toBe('error');
    expect(app.state.live.unassigned.status).toBe('error');
  });

  it('keeps rows already on screen when a background read fails', async () => {
    const app = setup(null);
    app.state.live.conversations = { status: 'ready', value: [row('kept')], loadedAt: 1 };
    (app.api.list as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { code: 'network', message: 'down', requestId: null, status: null, details: [] } });
    await refreshInboxLists(app.context);
    expect(app.state.live.conversations).toMatchObject({ status: 'ready', value: [{ id: 'kept' }] });
  });
});
