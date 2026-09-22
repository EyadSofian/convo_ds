import { describe, expect, it, vi } from 'vitest';
import type { Principal, SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import type { MetadataService } from '../metadata/metadata.service.js';
import { ConversationService } from './conversation.service.js';

const member = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const idA = '33333333-3333-4333-8333-333333333333';
const idB = '44444444-4444-4444-8444-444444444444';
const tenantId = '55555555-5555-4555-8555-555555555555';
const principal: Principal = { membershipId: member, membershipStatus: 'active', tenantStatus: 'active', grants: { 'conversation.read': 'tenant' }, scopes: [], delegationCeiling: null };
const base = { queue: 'all' as const, filters: [], search: null, sort: 'activity_desc' as const, cursor: null, limit: 1 };
const raw = (id: string, cursorValue: string) => ({
  id, connection_id: connection, peer_identity: '15550000000', team_id: null, assignee_membership_id: member,
  status: 'open', priority: 'normal', version: 1, waiting_since: null, contact_id: null,
  pending_reason: null, snoozed_until: null, snooze_timezone: null, resolution: null, resolved_at: null,
  last_activity_at: new Date('2026-09-22T10:00:00Z'), owner_state: 'human_active', owner_version: 0,
  display_name: 'Inbox', kind: 'whatsapp', read_through: null, cursor_value: cursorValue, participant_membership_ids: [],
});
const config = { secrets: { idempotencyHash: 'conversation-test-secret-value-with-at-least-32-bytes' } } as unknown as ApiConfig;

function harness(rows: readonly Record<string, unknown>[], currentPrincipal: Principal = principal) {
  const sql = { query: vi.fn(async <T>(text: string) => text.includes('FROM conversations c') ? { rows: rows as T[], rowCount: rows.length } : { rows: [], rowCount: 0 }) } as unknown as SqlExecutor;
  const authorization = { withPrincipal: vi.fn(async (_session, _tenant, work) => work({ sql, principal: currentPrincipal, tenantId })) } as unknown as AuthorizationService;
  const metadata = { conversationMetadataBatch: vi.fn(async () => new Map()) } as unknown as MetadataService;
  const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, metadata);
  return { service, sql };
}

describe('ConversationService Inbox boundaries', () => {
  it('denies readers with no conversation reach and handles an empty page', async () => {
    const denied = harness([], { ...principal, grants: {} });
    await expect(denied.service.list({ userId: 'user' } as never, tenantId, base)).rejects.toMatchObject({ status: 403 });
    const empty = harness([]);
    await expect(empty.service.list({ userId: 'user' } as never, tenantId, base)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('round-trips keyset cursors for every Inbox sort', async () => {
    const sorts = ['activity_desc', 'activity_asc', 'created_desc', 'created_asc', 'waiting_desc', 'priority_desc'] as const;
    for (const sort of sorts) {
      const { service } = harness([raw(idA, '2026-09-22T10:00:00.000Z'), raw(idB, '2026-09-21T10:00:00.000Z')]);
      const first = await service.list({ userId: 'user' } as never, tenantId, { ...base, sort });
      expect(first.nextCursor).toBeTruthy();
      const second = await service.list({ userId: 'user' } as never, tenantId, { ...base, sort, cursor: first.nextCursor });
      expect(second.items).toHaveLength(1);
    }
  });
});
