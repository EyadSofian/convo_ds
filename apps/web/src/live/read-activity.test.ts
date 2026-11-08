import { afterEach, describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { markConversationRead } from './lifecycle-actions.js';
import { applyRealtimeEvent, catchUpInbox, claimConversation, loadTimeline } from './inbox-actions.js';
import type { RealtimeEvent } from './realtime.js';
import { ready } from './store.js';
import type { TimelineMessage } from '../api/conversations.js';

const reader = { membershipId: 'member', name: 'Ahmed', seenAt: '2026-11-08T19:00:00Z' };
const message = (id: string, seen_by: TimelineMessage['seen_by'] = []): TimelineMessage => ({
  id, seen_by, direction: 'in', at: '2026-11-08T18:00:00Z', content_type: 'text', text: 'Test',
  attachments: [], author_membership_id: null, command_state: null, delivery_state: null,
  delivery_anomaly: null, provider_message_id: id,
});

function setup() {
  const state = createState(new Date('2026-11-08T19:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'a@test', memberships: [], tenantId: 'tenant' };
  state.live.openConversationId = 'thread';
  state.live.timeline = ready([message('old'), message('new')], 1);
  state.live.timelineCursor = 'older-page';
  const api = {
    markRead: vi.fn().mockResolvedValue({ ok: true, data: { readThrough: reader.seenAt } }),
    timeline: vi.fn().mockResolvedValue({ ok: true, data: { messages: [message('new', [reader])], nextCursor: null } }),
    list: vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } }),
    supervisorList: vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } }),
    unassigned: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    read: vi.fn().mockResolvedValue({ ok: true, data: { id: 'thread' } }),
    claim: vi.fn().mockResolvedValue({ ok: true, data: { id: 'thread', contactId: null, serviceWindow: {} } }),
    notes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    episodes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    handoffs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    collaborators: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  };
  Object.assign(state.live, { conversationsApi: api });
  const refresh = vi.fn();
  const context = { state, live: state.live, refresh, now: () => 2 } as unknown as LiveContext;
  return { state, api, context };
}

afterEach(() => vi.unstubAllGlobals());

describe('team read activity without a realtime connection', () => {
  it('shows the acknowledged reader immediately and preserves older loaded messages', async () => {
    const { state, api, context } = setup();
    await markConversationRead(context, 'thread');
    expect(api.timeline).toHaveBeenCalledWith('tenant', 'thread', null);
    expect(state.live.timeline).toMatchObject({ status: 'ready', value: [
      { id: 'old', seen_by: [] }, { id: 'new', seen_by: [reader] },
    ] });
    expect(state.live.timelineCursor).toBe('older-page');
  });

  it('does not claim a read if the write is refused', async () => {
    const { state, api, context } = setup();
    api.markRead.mockResolvedValueOnce({ ok: false, error: { code: 'denied' } });
    await markConversationRead(context, 'thread');
    expect(api.timeline).not.toHaveBeenCalled();
    expect(state.live.timeline).toMatchObject({ value: [{ seen_by: [] }, { seen_by: [] }] });
  });

  it.each(['hidden', 'switched', 'loading'] as const)('does not manufacture reads while %s', async (condition) => {
    const { state, api, context } = setup();
    if (condition === 'hidden') vi.stubGlobal('document', { visibilityState: 'hidden' });
    if (condition === 'switched') state.live.openConversationId = 'other';
    if (condition === 'loading') state.live.timeline = { status: 'loading' };
    await markConversationRead(context, 'thread');
    expect(api.markRead).not.toHaveBeenCalled();
  });

  it('records the signed-in supervisor, never the agent whose inbox is being inspected', async () => {
    const { state, api, context } = setup();
    state.live.supervisorAgentId = 'other-agent';
    await markConversationRead(context, 'thread');
    expect(api.markRead).toHaveBeenCalledOnce();
    expect(api.markRead).toHaveBeenCalledWith('tenant', 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'old' }, { seen_by: [reader] }] });
  });

  it('drops the acknowledgement when another thread opens before it arrives', async () => {
    const { state, api, context } = setup();
    api.timeline.mockImplementationOnce(async () => {
      state.live.openConversationId = 'other';
      state.live.timeline = ready([message('other')], 3);
      return { ok: true, data: { messages: [message('new', [reader])] } };
    });
    await markConversationRead(context, 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'other', seen_by: [] }] });
  });

  it('keeps the last known readers when the receipt refresh fails', async () => {
    const { state, api, context } = setup();
    api.timeline.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable' } });
    await markConversationRead(context, 'thread');
    expect(state.live.timeline).toMatchObject({ status: 'ready', value: [{ seen_by: [] }, { seen_by: [] }] });
  });

  it('records a read after opening a claimed thread', async () => {
    const { state, api, context } = setup();
    state.live.openConversationId = 'other';
    expect(await claimConversation(context, 'thread', 1)).toBe(true);
    expect(api.markRead).toHaveBeenCalledWith('tenant', 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'new', seen_by: [reader] }] });
  });

  it('records messages shown when the visible tab catches up', async () => {
    const { state, api, context } = setup();
    await catchUpInbox(context);
    expect(api.markRead).toHaveBeenCalledWith('tenant', 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'new', seen_by: [reader] }] });
  });

  it.each(['message.inbound', 'message.external', 'message.delivery'])('records actual views after %s', async (type) => {
    const { api, context } = setup();
    await applyRealtimeEvent(context, { type, scope: { conversationId: 'thread' } } as RealtimeEvent);
    expect(api.markRead).toHaveBeenCalledOnce();
  });

  it('does not create a read-event feedback loop', async () => {
    const { api, context } = setup();
    await applyRealtimeEvent(context, { type: 'conversation.read', scope: { conversationId: 'thread' } } as RealtimeEvent);
    expect(api.markRead).not.toHaveBeenCalled();
  });

  it('records nothing when the visible timeline failed to load', async () => {
    const { api, context } = setup();
    api.timeline.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable' } });
    await catchUpInbox(context);
    expect(api.markRead).not.toHaveBeenCalled();
  });

  it('preserves reader evidence returned by an older page when the next response omits it', async () => {
    const { state, api, context } = setup();
    state.live.timeline = ready([message('new', [reader])], 1);
    const oldServerMessage = message('new');
    delete (oldServerMessage as { seen_by?: TimelineMessage['seen_by'] }).seen_by;
    api.timeline.mockResolvedValueOnce({ ok: true, data: { messages: [oldServerMessage], nextCursor: null } });
    await markConversationRead(context, 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ seen_by: [reader] }] });
  });

  it('does not let an older timeline request erase a confirmed team read', async () => {
    const { state, api, context } = setup();
    let resolve!: (value: unknown) => void;
    api.timeline.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const earlier = loadTimeline(context, 'thread');
    await markConversationRead(context, 'thread');
    resolve({ ok: true, data: { messages: [message('new')], nextCursor: null } });
    await earlier;
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'old' }, { id: 'new', seen_by: [reader] }] });
  });

  it('keeps a newer timeline when it overtakes a receipt refresh', async () => {
    const { state, api, context } = setup();
    api.timeline.mockImplementationOnce(async () => {
      await loadTimeline(context, 'thread');
      return { ok: true, data: { messages: [message('new')], nextCursor: null } };
    });
    await markConversationRead(context, 'thread');
    expect(state.live.timeline).toMatchObject({ value: [{ id: 'new', seen_by: [reader] }] });
  });

  it('does not apply receipts to a thread that is loading again', async () => {
    const { state, api, context } = setup();
    api.timeline.mockImplementationOnce(async () => {
      state.live.timeline = { status: 'loading' };
      return { ok: true, data: { messages: [message('new', [reader])], nextCursor: null } };
    });
    await markConversationRead(context, 'thread');
    expect(state.live.timeline).toEqual({ status: 'loading' });
  });
});
