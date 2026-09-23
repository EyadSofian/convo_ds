import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import type { NotificationsApi } from '../api/notifications.js';
import type { LiveContext } from './actions.js';
import { startRealtime, stopRealtime } from './inbox-actions.js';
import { subscribe } from './realtime.js';
import type { EventSourceLike, RealtimeEvent } from './realtime.js';

/**
 * The client's half of the realtime contract.
 *
 * The server decides what may be seen; these tests cover what a client has to
 * get right regardless — that a repeated event is applied once, that an event
 * older than what is on screen is dropped rather than rolling it backwards,
 * that a reset throws the view away instead of patching it, and that a
 * reconnect is spread out rather than synchronised across a fleet.
 */

class FakeSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

function event(overrides: Partial<RealtimeEvent> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'e1',
    seq: 5,
    type: 'message.inbound',
    entity: { type: 'conversation', id: 'c1', version: 2 },
    scope: { conversationId: 'c1', inboxId: 'i1', teamId: null, assigneeMembershipId: null },
    occurredAt: '2026-09-09T10:00:00.000Z',
    payload: { text: 'مرحبا' },
    cursor: 'cursor-5',
    ...overrides,
  };
}

function harness(): {
  source: FakeSource;
  connections: number[];
  events: RealtimeEvent[];
  resets: string[];
  disconnects: { reason: string; willRetry: boolean }[];
  subscription: ReturnType<typeof subscribe>;
} {
  let created: FakeSource | undefined;
  const connections: number[] = [];
  const events: RealtimeEvent[] = [];
  const resets: string[] = [];
  const disconnects: { reason: string; willRetry: boolean }[] = [];
  const subscription = subscribe({
    baseUrl: '/api/v1',
    tenantId: 't1',
    open: (url) => {
      created = new FakeSource(url);
      return created;
    },
    handlers: {
      onConnect: () => connections.push(connections.length + 1),
      onEvent: (value) => events.push(value),
      onReset: (reason) => resets.push(reason),
      onDisconnect: (reason, willRetry) => disconnects.push({ reason, willRetry }),
    },
  });
  return { source: created as FakeSource, connections, events, resets, disconnects, subscription };
}

describe('the realtime subscription', () => {
  it('subscribes to the tenant’s stream', () => {
    const { source } = harness();
    expect(source.url).toBe('/api/v1/tenants/t1/realtime/stream');
  });

  it('reports a successful initial connection and reconnect', () => {
    const { source, connections } = harness();
    source.emit('open', '');
    source.emit('error', '');
    source.emit('open', '');
    expect(connections).toEqual([1, 2]);
  });

  it('applies an event and remembers where it got to', () => {
    const { source, events, subscription } = harness();
    source.emit('message.inbound', event());
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['text']).toBe('مرحبا');
    // The cursor is what a catch-up after a dropped connection resumes from.
    expect(subscription.cursor()).toBe('cursor-5');
  });

  it('applies a repeated event exactly once', () => {
    const { source, events } = harness();
    source.emit('message.inbound', event());
    source.emit('message.inbound', event());
    // At-least-once delivery is the honest guarantee; this is what makes it
    // safe to build on.
    expect(events).toHaveLength(1);
  });

  it('drops an event older than what is already applied', () => {
    const { source, events } = harness();
    source.emit('message.inbound', event({ id: 'e2', seq: 9 }));
    source.emit('message.inbound', event({ id: 'e1', seq: 5 }));
    // Applying it would move the screen backwards, which is worse than missing
    // it: the newer event already carried the newer state.
    expect(events.map((entry) => entry.seq)).toEqual([9]);
  });

  it('carries each kind of change as its own event', () => {
    const { source, events } = harness();
    source.emit('message.inbound', event({ id: 'a', seq: 1 }));
    source.emit('message.delivery', event({ id: 'b', seq: 2, type: 'message.delivery' }));
    source.emit('conversation.assigned', event({ id: 'c', seq: 3, type: 'conversation.assigned' }));
    expect(events.map((entry) => entry.type)).toEqual([
      'message.inbound',
      'message.delivery',
      'conversation.assigned',
    ]);
  });

  it('ignores a frame it cannot read rather than dying on it', () => {
    const { source, events } = harness();
    source.emit('message.inbound', 'not json at all');
    source.emit('message.inbound', { id: 'missing-everything' });
    source.emit('message.inbound', event({ id: 'good', seq: 7 }));
    // One malformed frame must not stop the ones after it.
    expect(events.map((entry) => entry.id)).toEqual(['good']);
  });

  it('fills in what a frame leaves out', () => {
    const { source, events, subscription } = harness();
    const sparse = event({ id: 'sparse', seq: 3, entity: { type: 'x' } as never });
    delete sparse['payload'];
    delete sparse['cursor'];
    source.emit('message.inbound', sparse);

    const applied = events[0];
    expect(applied?.entity.version).toBe(0);
    expect(applied?.payload).toEqual({});
    expect(applied?.cursor).toBeUndefined();
    // A frame with no cursor leaves the last known position alone, rather than
    // making a client resume from an empty string.
    expect(subscription.cursor()).toBeNull();
  });

  it('fills in each field a frame gets wrong, one at a time', () => {
    const { source, events } = harness();
    source.emit('message.inbound', {
      ...event({ id: 'wrong-types', seq: 2 }),
      schemaVersion: 'one',
      entity: { type: 9, id: 7, version: 'three' },
      scope: { conversationId: 1, inboxId: 2, teamId: 3, assigneeMembershipId: 4 },
      occurredAt: 5,
      payload: 'not an object',
    });
    // A field of the wrong type is a newer server or a bug, not a reason to
    // stop applying events. Each one degrades to a defined value.
    expect(events[0]).toMatchObject({
      schemaVersion: 0,
      entity: { type: 'conversation', id: '', version: 0 },
      scope: { conversationId: '', inboxId: '', teamId: null, assigneeMembershipId: null },
      occurredAt: '',
      payload: {},
    });
  });

  it('carries a routed conversation’s team through', () => {
    const { source, events } = harness();
    source.emit(
      'message.inbound',
      event({
        id: 'routed',
        seq: 3,
        scope: {
          conversationId: 'c1',
          inboxId: 'i1',
          teamId: 'team-1',
          assigneeMembershipId: 'agent-1',
        },
      }),
    );
    // The team and the assignee are the terms the server authorized on; a
    // client that dropped them could not explain why an event arrived.
    expect(events[0]?.scope).toEqual({
      conversationId: 'c1',
      inboxId: 'i1',
      teamId: 'team-1',
      assigneeMembershipId: 'agent-1',
    });
  });

  it('throws the view away when the server says to reset', () => {
    const { source, events, resets } = harness();
    source.emit('message.inbound', event({ id: 'before', seq: 4 }));
    source.emit('reset_required', { reason: 'permissions_changed' });
    expect(resets).toEqual(['permissions_changed']);

    // And the dedupe memory goes with it: after a reset the same event may
    // legitimately be delivered again, because the caller's reach changed.
    source.emit('message.inbound', event({ id: 'before', seq: 4 }));
    expect(events.map((entry) => entry.id)).toEqual(['before', 'before']);
  });

  it('reports a planned cycle as one the browser will come back from', () => {
    const { source, disconnects } = harness();
    source.emit('stream_cycled', { reason: 'max_stream_age' });
    // `EventSource` retries on its own, on the floor the server sent. Opening a
    // second one beside it is how one restart becomes a request storm.
    expect(disconnects).toEqual([{ reason: 'max_stream_age', willRetry: true }]);
  });

  it('closes for good when access is revoked', () => {
    const { source, disconnects } = harness();
    source.emit('stream_closed', { reason: 'access_revoked' });
    expect(disconnects).toEqual([{ reason: 'access_revoked', willRetry: false }]);
    // The one case the browser cannot work out for itself: retrying would ask
    // the same question and get the same answer forever.
    expect(source.closed).toBe(true);

    source.emit('message.inbound', event());
    expect(disconnects).toHaveLength(1);
  });

  it('reports a server failure as worth waiting through', () => {
    const { source, disconnects } = harness();
    source.emit('stream_closed', { reason: 'server_error' });
    expect(disconnects[0]?.willRetry).toBe(true);
  });

  it('reports a dropped connection', () => {
    const { source, disconnects } = harness();
    source.emit('error', '');
    expect(disconnects).toEqual([{ reason: 'connection_lost', willRetry: true }]);
  });

  it('reads an unreadable ending frame as an unknown reason', () => {
    const { source, disconnects } = harness();
    source.emit('stream_closed', 'not json');
    expect(disconnects[0]?.reason).toBe('unknown');
  });

  it('goes quiet once it is closed', () => {
    const { source, events, resets, disconnects, subscription } = harness();
    subscription.close();
    expect(source.closed).toBe(true);
    source.emit('message.inbound', event());
    source.emit('reset_required', { reason: 'expired' });
    source.emit('stream_cycled', { reason: 'max_stream_age' });
    source.emit('error', '');
    // A closed subscription that still pushed into the screen would repopulate
    // an inbox the operator has navigated away from.
    expect([events.length, resets.length, disconnects.length]).toEqual([0, 0, 0]);
  });
});

describe('the stream an open workspace holds', () => {
  it('refreshes only recipient notification state on the existing SSE feed', async () => {
    const state = createState(new Date('2026-09-09T10:00:00.000Z'));
    state.live.session = { status: 'signed_in', email: 'agent@example.test', memberships: [], tenantId: 't-1' };
    const list = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
    const unreadCount = vi.fn().mockResolvedValue({ ok: true, data: { count: 1 } });
    Object.assign(state.live, { notificationsApi: { list, unreadCount } as unknown as NotificationsApi });
    let source: FakeSource | null = null;
    const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 0,
      newKey: () => 'k', endSession: vi.fn(), switchWorkspace: vi.fn() };
    startRealtime(context, { baseUrl: '/api/v1', open: (url) => { source = new FakeSource(url); return source; } });
    source!.emit('notification.changed', event({ id: 'n1', seq: 1, type: 'notification.changed',
      entity: { type: 'notification', id: 'notice', version: 1 },
      scope: { conversationId: '', inboxId: '', teamId: null, assigneeMembershipId: null }, payload: {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unreadCount).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    state.openMenu = 'notifications';
    source!.emit('notification.changed', event({ id: 'n2', seq: 2, type: 'notification.changed',
      entity: { type: 'notification', id: 'notice', version: 1 },
      scope: { conversationId: '', inboxId: '', teamId: null, assigneeMembershipId: null }, payload: {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(list).toHaveBeenCalledTimes(1);
    expect(unreadCount).toHaveBeenCalledTimes(2);
    stopRealtime(context);
  });

  it('opens exactly one per workspace, and none without a company', () => {
    const state = createState(new Date('2026-09-09T10:00:00.000Z'));
    const opened: string[] = [];
    const wiring = {
      baseUrl: '/api/v1',
      open: (url: string): EventSourceLike => {
        opened.push(url);
        return { addEventListener: () => undefined, close: () => undefined };
      },
    };
    const context: LiveContext = {
      state,
      live: state.live,
      refresh: () => undefined,
      now: () => 0,
      newKey: () => 'k',
      endSession: () => undefined,
      switchWorkspace: () => undefined,
    };
    startRealtime(context, wiring);
    expect(opened).toEqual([]);

    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't-1' };
    startRealtime(context, wiring);
    // A second start while one is open would be a second socket for the same events.
    startRealtime(context, wiring);
    expect(opened).toHaveLength(1);
    stopRealtime(context);
    expect(state.live.subscription).toBeNull();
  });

  it('returns the workspace from reconnecting to live after EventSource reopens', () => {
    const state = createState(new Date('2026-09-09T10:00:00.000Z'));
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't-1' };
    let source: FakeSource | null = null;
    const context: LiveContext = {
      state,
      live: state.live,
      refresh: vi.fn(),
      now: () => 42,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    };
    startRealtime(context, {
      baseUrl: '/api/v1',
      open: (url) => { source = new FakeSource(url); return source; },
    });
    source!.emit('error', '');
    expect(state.live.realtime.status).toBe('stale');
    source!.emit('open', '');
    expect(state.live.realtime).toEqual({ status: 'live', since: 42 });
    stopRealtime(context);
  });
});
