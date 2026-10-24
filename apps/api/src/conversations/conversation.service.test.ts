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
  const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, metadata, {} as never);
  return { service, sql };
}

describe('ConversationService Inbox boundaries', () => {
  it('reports the WhatsApp service window as not applicable, closed, or unknown from its evidence', async () => {
    const readHarness = (kind: string, inbound: Date | null, serverNow = new Date('2026-09-23T12:00:00Z')) => {
      const sql = { query: vi.fn(async <T>(text: string) => {
        if (text.includes('JOIN channel_connections')) return { rows: [{ ...raw(idA, '2026-09-23T11:00:00Z'), display_name: 'Inbox', kind }] as T[], rowCount: 1 };
        if (text.includes('FROM conversation_participants')) return { rows: [] as T[], rowCount: 0 };
        if (text.includes('SELECT max(inbound.occurred_at)')) return { rows: [{ last_inbound_at: inbound, server_now: serverNow }] as T[], rowCount: 1 };
        return { rows: [] as T[], rowCount: 0 };
      }) } as unknown as SqlExecutor;
      const authorization = { assertTenantId: vi.fn(), withPrincipal: vi.fn(async (_session, _tenant, work) => work({ sql, principal, tenantId })) } as unknown as AuthorizationService;
      const metadata = { conversationMetadata: vi.fn(async () => ({})) } as unknown as MetadataService;
      const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, metadata, {} as never);
      return service;
    };

    await expect(readHarness('messenger', null).read({ userId: 'user' } as never, tenantId, idA))
      .resolves.toMatchObject({ serviceWindow: { status: 'not_applicable' } });
    await expect(readHarness('whatsapp', null).read({ userId: 'user' } as never, tenantId, idA))
      .resolves.toMatchObject({ serviceWindow: { status: 'closed', lastCustomerInboundAt: null, serviceWindowExpiresAt: null } });
    await expect(readHarness('whatsapp', new Date(Number.NaN), new Date(Number.NaN)).read({ userId: 'user' } as never, tenantId, idA))
      .resolves.toMatchObject({ serviceWindow: { status: 'unknown', lastCustomerInboundAt: null, serviceWindowExpiresAt: null } });
    await expect(readHarness('whatsapp', new Date('2026-09-22T12:00:00Z')).read({ userId: 'user' } as never, tenantId, idA))
      .resolves.toMatchObject({ serviceWindow: { status: 'closed', lastCustomerInboundAt: '2026-09-22T12:00:00.000Z', serviceWindowExpiresAt: '2026-09-23T12:00:00.000Z' } });
  });

  it('denies readers with no conversation reach and handles an empty page', async () => {
    const denied = harness([], { ...principal, grants: {} });
    await expect(denied.service.list({ userId: 'user' } as never, tenantId, base)).rejects.toMatchObject({ status: 403 });
    const empty = harness([]);
    await expect(empty.service.list({ userId: 'user' } as never, tenantId, base)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('returns a bounded last-message preview only in readable Inbox rows', async () => {
    const { service, sql } = harness([{ ...raw(idA, '2026-09-22T10:00:00.000Z'), last_message_preview: `  ${'A'.repeat(170)}  ` }]);
    const page = await service.list({ userId: 'user' } as never, tenantId, base);
    expect(page.items[0]?.lastMessagePreview).toBe('A'.repeat(160));
    expect(sql.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN LATERAL'), expect.any(Array));
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

  it('rejects a malformed keyset cursor before querying the Inbox', async () => {
    const { service, sql } = harness([]);
    await expect(service.list({ userId: 'user' } as never, tenantId, { ...base, cursor: 'invalid.cursor' }))
      .rejects.toMatchObject({ status: 400 });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('fails closed if returned Inbox rows disagree with the caller scope', async () => {
    const scoped: Principal = {
      ...principal,
      grants: { 'conversation.read': 'scoped' },
      scopes: [{ type: 'team', id: '66666666-6666-4666-8666-666666666666' }],
    };
    const { service } = harness([raw(idA, '2026-09-22T10:00:00.000Z')], scoped);
    await expect(service.list({ userId: 'user' } as never, tenantId, base)).rejects.toThrow('Inbox SQL authorization scope disagreed');
  });

  it('fails closed when the supervisor workload query unexpectedly returns no row', async () => {
    const agent = { membership_id: member, name: 'Agent', email: 'agent@example.test', teams: [] };
    const sql = { query: vi.fn(async <T>(text: string) => text.includes('FROM memberships m')
      ? { rows: [agent] as T[], rowCount: 1 }
      : { rows: [], rowCount: 0 }) } as unknown as SqlExecutor;
    const authorization = { withPrincipal: vi.fn(async (_session, _tenant, work) => work({ sql, principal, tenantId })) } as unknown as AuthorizationService;
    const metadata = { conversationMetadataBatch: vi.fn(async () => new Map()) } as unknown as MetadataService;
    const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, metadata, {} as never);
    await expect(service.supervisorWorkload({ userId: 'user' } as never, tenantId, member)).rejects.toThrow('supervisor workload returned no row');
  });
});

describe('the queue and the claim, at their guards', () => {
  const inboxOnly: Principal = {
    ...principal,
    grants: { 'conversation.unassigned.preview': 'scoped', 'conversation.claim': 'scoped' },
    scopes: [{ type: 'inbox', id: connection }],
  };

  it('still skips a card the domain refuses, even when SQL let it through', async () => {
    const elsewhere = '66666666-6666-4666-8666-666666666666';
    const sql = { query: vi.fn(async <T>() => ({
      rows: [{ ...raw(idA, ''), assignee_membership_id: null }, { ...raw(idB, ''), connection_id: elsewhere, assignee_membership_id: null }] as T[],
      rowCount: 2,
    })) } as unknown as SqlExecutor;
    const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, principal: inboxOnly, tenantId })) } as unknown as AuthorizationService;
    const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, {} as never, {} as never);
    const cards = await service.unassigned({ userId: 'user' } as never, tenantId, { connectionId: null, priority: null, channel: null, labelIds: [] });
    expect(cards.map((card) => card.id)).toEqual([idA]);
    // The scope is in the query, so the 200-row cap counts visible cards only.
    const [text, params] = (sql.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(text).toContain('c.connection_id = ANY($6::uuid[])');
    expect(params[5]).toEqual([connection]);
  });

  it('refuses to claim an archived conversation', async () => {
    const sql = { query: vi.fn(async <T>(text: string) => text.includes('FROM conversations WHERE id')
      ? { rows: [{ ...raw(idA, ''), status: 'archived', assignee_membership_id: null }] as T[], rowCount: 1 }
      : { rows: [] as T[], rowCount: 0 }) } as unknown as SqlExecutor;
    const authorization = { assertTenantId: vi.fn(), withPrincipal: vi.fn(async (_session, _tenant, work) => work({ sql, principal: inboxOnly, tenantId })) } as unknown as AuthorizationService;
    const service = new ConversationService({} as never, config, authorization, {} as never, {} as never, {} as never, {} as never);
    await expect(service.claim({ userId: 'user' } as never, tenantId, idA, 1)).rejects.toMatchObject({ status: 409, code: 'archived_conversation_is_immutable' });
    expect((sql.query as ReturnType<typeof vi.fn>).mock.calls.some(([text]) => String(text).includes('UPDATE conversations'))).toBe(false);
  });
});
