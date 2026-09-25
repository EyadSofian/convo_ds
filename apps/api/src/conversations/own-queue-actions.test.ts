import { describe, expect, it, vi } from 'vitest';
import type { Principal, SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { NotificationService } from '../notifications/notification.service.js';
import { RoutingService } from './routing.service.js';
import { NoteService } from './note.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CONNECTION = '55555555-5555-4555-8555-555555555555';
const session = {} as AuthenticatedSession;
const principal: Principal = { membershipId: MEMBER, membershipStatus: 'active', tenantStatus: 'active',
  grants: { 'conversation.claim': 'tenant', 'conversation.read': 'tenant' }, scopes: [], delegationCeiling: null };

function harness(assignee: string, actor: Principal = principal) {
  const query = vi.fn(async (statement: string, ..._params: readonly unknown[]) => {
    void _params;
    if (statement.includes('JOIN channel_connections')) return { rows: [{
      id: CONVERSATION, connection_id: CONNECTION, peer_identity: 'opaque', team_id: null,
      assignee_membership_id: assignee, status: 'open', priority: 'normal', version: 4,
      waiting_since: null, contact_id: null, pending_reason: null, snoozed_until: null,
      snooze_timezone: null, resolution: null, resolved_at: null,
      last_activity_at: new Date(), owner_state: 'human_active', owner_version: 1,
      display_name: 'Page', kind: 'messenger', contact_display_name: 'Test sender',
    }] };
    if (statement.includes('FROM conversation_participants')) return { rows: [] };
    if (statement.includes('UPDATE conversations')) return { rows: [{ version: 5, owner_version: 2 }] };
    return { rows: [], rowCount: 1 };
  });
  const authorization = { assertTenantId: vi.fn(), withPrincipal: async (_session: unknown, _tenant: string,
    action: (scope: unknown) => Promise<unknown>) => action({ sql: { query } as SqlExecutor, principal: actor }),
  } as unknown as AuthorizationService;
  const realtime = { emit: vi.fn() } as unknown as RealtimeService;
  return { query, realtime,
    routing: new RoutingService(authorization, realtime, {} as NotificationService, {} as never),
    notes: new NoteService(authorization, realtime),
  };
}

describe('own-only queue actions', () => {
  it('refuses releasing somebody else’s conversation even with a broad claim grant', async () => {
    const { routing, query } = harness(OTHER);
    await expect(routing.releaseOwn(session, TENANT, CONVERSATION, 4)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE conversations'))).toBe(false);
  });

  it('refuses releasing own work without a claim grant', async () => {
    const { routing, query } = harness(MEMBER, { ...principal, grants: { 'conversation.read': 'tenant' } });
    await expect(routing.releaseOwn(session, TENANT, CONVERSATION, 4)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE conversations'))).toBe(false);
  });

  it('deletes only this member’s read cursor after checking read access', async () => {
    const { notes, query } = harness(MEMBER);
    await expect(notes.markUnread(session, TENANT, CONVERSATION)).resolves.toEqual({ unread: true });
    expect(query.mock.calls.find(([sql]) => sql.includes('DELETE FROM conversation_reads'))?.[1])
      .toEqual([CONVERSATION, MEMBER]);
    const denied = harness(MEMBER, { ...principal, grants: {} });
    await expect(denied.notes.markUnread(session, TENANT, CONVERSATION)).rejects.toMatchObject({ status: 403 });
    expect(denied.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM conversation_reads'))).toBe(false);
  });
});
