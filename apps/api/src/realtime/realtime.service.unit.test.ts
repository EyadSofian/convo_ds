import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import { RealtimeService } from './realtime.service.js';

describe('realtime feed defensive scope boundary', () => {
  it('never delivers a non-notification row without a conversation scope', async () => {
    // Migration 0039 prevents this shape in PostgreSQL. The service still
    // fails closed if an imported/corrupted row ever bypasses that constraint.
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const client = { release: vi.fn(), query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('app_current_tenant()')) return { rows: [{ tenant: tenantId }] };
      if (sql.includes('min(seq)')) return { rows: [{ oldest: '1', next: '1' }] };
      if (sql.includes('count(*)')) return { rows: [{ waiting: '1' }] };
      if (sql.includes('FROM realtime_events') && sql.includes('ORDER BY')) return { rows: [{
        id: '22222222-2222-4222-8222-222222222222', seq: '1', schema_version: 1,
        type: 'message.inbound', entity_type: 'conversation', entity_id: '33333333-3333-4333-8333-333333333333',
        entity_version: 1, conversation_id: null, connection_id: null, recipient_membership_id: null,
        team_id: null, assignee_membership_id: null, payload: {}, occurred_at: new Date('2026-01-01'),
      }, {
        id: '66666666-6666-4666-8666-666666666666', seq: '2', schema_version: 1,
        type: 'message.inbound', entity_type: 'conversation', entity_id: '77777777-7777-4777-8777-777777777777',
        entity_version: 1, conversation_id: '77777777-7777-4777-8777-777777777777', connection_id: '88888888-8888-4888-8888-888888888888', recipient_membership_id: null,
        team_id: null, assignee_membership_id: null, payload: {}, occurred_at: new Date('2026-01-01'),
      }] };
      return { rows: [] };
    }) };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const authorization = {
      assertTenantId: vi.fn(),
      requirePrincipal: vi.fn().mockResolvedValue({ membershipId: '44444444-4444-4444-8444-444444444444',
        membershipStatus: 'active', tenantStatus: 'active', grants: {}, scopes: [], delegationCeiling: null }),
    } as unknown as AuthorizationService;
    const page = await new RealtimeService(pool, authorization).page({} as AuthenticatedSession, tenantId, null, 10, 100);
    expect(page).toMatchObject({ status: 'ok', events: [], backlog: 0 });
    if (page.status === 'ok') expect(Buffer.from(page.cursor, 'base64url').toString()).toContain('|2|');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('ORDER BY realtime_events.seq'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

describe('batched notification invalidation', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const service = () => new RealtimeService({} as unknown as Pool, {} as unknown as AuthorizationService);

  it('advances the counter once for the whole batch and numbers the rows in order', async () => {
    // The counter returns the highest number the batch owns, so three
    // recipients allocated against a counter now reading 12 hold 10, 11, 12.
    const query = vi.fn().mockResolvedValue({ rows: [{ next_seq: '12' }] });
    await service().emitNotifications({ query } as never, tenantId, [
      { membershipId: 'm1', notificationId: 'n1' },
      { membershipId: 'm2', notificationId: 'n2' },
      { membershipId: 'm3', notificationId: 'n3' },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    const [allocate, insert] = query.mock.calls as [[string, unknown[]], [string, unknown[]]];
    expect(allocate[0]).toContain('next_seq = tenant_event_sequences.next_seq + $2');
    expect(allocate[1]).toEqual([tenantId, 3]);
    // First seq is 12 - (3 - 1) = 10, and the insert walks upwards from it.
    expect(insert[1]?.[1]).toBe(10);
    expect(insert[0]).toContain('$2::bigint + entry.row_index - 1');
    expect(insert[0]).toContain("'notification.changed'");
    expect(insert[1]?.[3]).toEqual(['n1', 'n2', 'n3']);
    expect(insert[1]?.[4]).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps the arithmetic true for a single recipient', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ next_seq: '7' }] });
    await service().emitNotifications({ query } as never, tenantId, [{ membershipId: 'm', notificationId: 'n' }]);
    expect(query.mock.calls[1]?.[1]?.[1]).toBe(7);
  });

  it('touches nothing at all for an empty batch', async () => {
    const query = vi.fn();
    await service().emitNotifications({ query } as never, tenantId, []);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to invent a sequence when the counter returns no row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(service().emitNotifications({ query } as never, tenantId, [
      { membershipId: 'm', notificationId: 'n' },
    ])).rejects.toThrow(/event sequence returned no row/);
  });
});
