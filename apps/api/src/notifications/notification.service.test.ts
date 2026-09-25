import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { Principal } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationService } from './notification.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const session = {} as AuthenticatedSession;

const principal: Principal = { membershipId: MEMBER, membershipStatus: 'active', tenantStatus: 'active',
  grants: { 'conversation.read': 'tenant' }, scopes: [], delegationCeiling: null };
function harness(rows: Record<string, unknown>[][] = [], viewer: Principal = principal) {
  const query = vi.fn().mockImplementation(async () => ({ rows: rows.shift() ?? [] }));
  const authorization = { withPrincipal: async (_session: unknown, _tenant: string,
    action: (scope: unknown) => Promise<unknown>) => action({ sql: { query }, principal: viewer }),
  } as unknown as AuthorizationService;
  const realtime = { emitNotification: vi.fn() } as unknown as RealtimeService;
  return { service: new NotificationService(authorization, realtime), query, realtime };
}

describe('durable notification service', () => {
  it('rejects malformed, oversized and invalid cursor/limit inputs before database access', async () => {
    const { service, query } = harness();
    for (const cursor of ['not-base64-json', 'x'.repeat(513), Buffer.from('null').toString('base64url'),
      Buffer.from(JSON.stringify({ at: 'not-a-date', id: ID })).toString('base64url'),
      Buffer.from(JSON.stringify({ at: new Date().toISOString(), id: 'bad' })).toString('base64url')]) {
      await expect(service.list(session, TENANT, cursor, undefined)).rejects.toMatchObject({ status: 400 });
    }
    for (const limit of ['0', '51', '1.5', 'NaN']) {
      await expect(service.list(session, TENANT, undefined, limit)).rejects.toMatchObject({ status: 400 });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('paginates by the opaque timestamp/id pair and maps durable read state', async () => {
    const row = { id: ID, kind: 'assignment', target_type: 'automation', target_id: ID,
      created_at: new Date('2026-01-02T00:00:00Z'), read_at: null, dedupe_key: 'test' };
    const { service, query } = harness([[row, { ...row, id: MEMBER }], [row], [{ count: '2' }]]);
    const first = await service.list(session, TENANT, undefined, '1');
    expect(first.items).toEqual([{ id: ID, kind: 'assignment', targetType: 'automation', targetId: ID,
      createdAt: '2026-01-02T00:00:00.000Z', readAt: null, senderName: null, messagePreview: null }]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(session, TENANT, first.nextCursor!, '1');
    expect(second.nextCursor).toBeNull();
    expect(query.mock.calls[1]?.[1]).toEqual([MEMBER, '2026-01-02T00:00:00.000Z', ID, 2]);
    expect(await service.unreadCount(session, TENANT)).toBe(2);
  });

  it('returns the exact inbound text and sender only while conversation.read still permits it', async () => {
    const row = { id: ID, kind: 'new_message', target_type: 'conversation', target_id: ID,
      created_at: new Date('2026-01-02T00:00:00Z'), read_at: null, dedupe_key: `inbound:${MEMBER}` };
    const detail = { id: ID, connection_id: TENANT, peer_identity: 'opaque-peer', team_id: null,
      assignee_membership_id: MEMBER, status: 'open', priority: 'normal', version: 1,
      waiting_since: null, contact_id: TENANT, pending_reason: null, snoozed_until: null,
      snooze_timezone: null, resolution: null, resolved_at: null,
      last_activity_at: new Date('2026-01-02T00:00:00Z'), owner_state: 'human_active', owner_version: 1,
      display_name: 'Instagram', contact_display_name: 'Eyad', kind: 'instagram' };
    const visible = harness([[row], [detail], [], [{ text_body: 'Hello from test account' }]]);
    expect((await visible.service.list(session, TENANT, undefined, undefined)).items[0]).toMatchObject({
      senderName: 'Eyad', messagePreview: 'Hello from test account',
    });
    expect(visible.query.mock.calls.at(-1)?.[1]).toEqual([MEMBER, ID]);

    const revoked = harness([[row], [detail], []], { ...principal, grants: {} });
    expect((await revoked.service.list(session, TENANT, undefined, undefined)).items[0]).toMatchObject({
      senderName: null, messagePreview: null,
    });
    expect(revoked.query).toHaveBeenCalledTimes(3);

    const invalidPrincipal = harness([[row], [detail], []], { ...principal, grants: null as never });
    await expect(invalidPrincipal.service.list(session, TENANT, undefined, undefined)).rejects.toThrow();

    const removed = harness([[row], []]);
    expect((await removed.service.list(session, TENANT, undefined, undefined)).items[0]).toMatchObject({
      senderName: null, messagePreview: null,
    });
    const noEvent = harness([[{ ...row, dedupe_key: 'assignment:unrelated' }], [{ ...detail, contact_display_name: null }], []]);
    expect((await noEvent.service.list(session, TENANT, undefined, undefined)).items[0]).toMatchObject({
      senderName: null, messagePreview: null,
    });
    const emptyText = harness([[row], [detail], [], [{ text_body: null }]]);
    expect((await emptyText.service.list(session, TENANT, undefined, undefined)).items[0]?.messagePreview).toBeNull();
  });

  it('uses the bounded default page size and zero for an empty unread result', async () => {
    const { service, query } = harness([[], []]);
    expect(await service.list(session, TENANT, undefined, undefined)).toEqual({ items: [], nextCursor: null });
    expect(query.mock.calls[0]?.[1]).toEqual([MEMBER, null, null, 26]);
    expect(await service.unreadCount(session, TENANT)).toBe(0);
  });

  it('does not emit on duplicate creation, but enqueues and invalidates once on insertion', async () => {
    const { service, query, realtime } = harness([[], [{ id: ID }], []]);
    const input = { recipientMembershipId: MEMBER, kind: 'new_message' as const,
      targetType: 'conversation' as const, targetId: ID, dedupeKey: 'event-id' };
    await service.create({ query } as never, TENANT, input);
    expect(realtime.emitNotification).not.toHaveBeenCalled();
    await service.create({ query } as never, TENANT, input);
    expect(realtime.emitNotification).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter((call) => String(call[0]).includes('notification_push_queue'))).toHaveLength(1);
  });

  it('returns generic not-found for another member and emits only changed read state', async () => {
    const { service, realtime } = harness([[], [], [{ id: ID }], [{ id: ID }], []]);
    await expect(service.markRead(session, TENANT, 'bad')).rejects.toMatchObject({ status: 400 });
    await expect(service.markRead(session, TENANT, ID)).rejects.toMatchObject({ status: 404 });
    await service.markRead(session, TENANT, ID);
    await service.markAllRead(session, TENANT);
    expect(realtime.emitNotification).toHaveBeenCalledTimes(2);
  });
});
