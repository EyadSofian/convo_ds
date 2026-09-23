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
