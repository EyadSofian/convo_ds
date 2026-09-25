/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationsApi } from '../api/conversations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { markConversationUnread } from './lifecycle-actions.js';
import { releaseOwnConversation } from './routing-actions.js';
import { ready } from './store.js';

const ERROR = { code: 'network', message: 'unavailable', requestId: null, status: null, details: [] };

function context(): LiveContext {
  const state = createState(new Date('2026-09-25T10:00:00Z'));
  state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 'tenant-1' };
  return { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key',
    endSession: vi.fn(), switchWorkspace: vi.fn() } as LiveContext;
}

describe('own Inbox actions fail closed', () => {
  it('cannot mark an unopened conversation unread or release it', async () => {
    const ctx = context();
    expect(await markConversationUnread(ctx)).toBe(false);
    expect(await releaseOwnConversation(ctx)).toBe(false);
  });

  it('preserves the open conversation when mark-unread is refused by the server', async () => {
    const ctx = context();
    ctx.live.openConversationId = 'conversation-1';
    ctx.live.openConversation = ready({ id: 'conversation-1' } as never, ctx.now());
    const markUnread = vi.fn().mockResolvedValue({ ok: false, error: ERROR });
    Object.assign(ctx.live, { conversationsApi: { markUnread } as unknown as ConversationsApi });
    expect(await markConversationUnread(ctx)).toBe(false);
    expect(markUnread).toHaveBeenCalledWith('tenant-1', 'conversation-1');
    expect(ctx.live.error).toEqual(ERROR);
    expect(ctx.live.openConversation.status).toBe('ready');
  });
});
