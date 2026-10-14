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

describe('who an inbound message notifies', () => {
  const team = '66666666-6666-4666-8666-666666666666';
  const conversationId = '77777777-7777-4777-8777-777777777777';
  const inboundEventId = '88888888-8888-4888-8888-888888888888';

  function inboundHarness(assigneeMembershipId: string | null, teamId: string | null = null) {
    const sql = { query: vi.fn(async (text: string) => text.includes('FROM channel_connections')
      ? { rows: [{ display_name: 'Admissions', kind: 'whatsapp' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }) } as unknown as SqlExecutor;
    const realtime = { emit: vi.fn(async () => 1) } as never;
    const lifecycle = { noteCustomerInbound: vi.fn(async () => ({
      version: 2, status: 'open', outcome: { from: 'open', effects: [] }, waitingSince: null,
    })) } as never;
    type Notify = (sql: unknown, tenantId: string, input: Record<string, unknown>) => Promise<void>;
    const notifications = {
      create: vi.fn<Notify>(async () => undefined),
      notifyClaimants: vi.fn<Notify>(async () => undefined),
    };
    const service = new ConversationService(
      {} as never, config, {} as never, realtime, lifecycle, {} as never, notifications as never,
    );
    const conversation = {
      id: conversationId, connectionId: connection, peerIdentity: '15550000000',
      teamId, assigneeMembershipId, priority: 'normal',
    } as never;
    const note = () => service.noteInbound(sql, tenantId, conversation, {
      inboundEventId, occurredAt: new Date('2026-10-14T09:00:00Z'), payload: {}, contactId: idB,
    });
    return { note, notifications };
  }

  it('tells the assignee alone when somebody already owns the thread', async () => {
    const { note, notifications } = inboundHarness(member);
    await note();
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create.mock.calls[0]?.[2]).toEqual({
      recipientMembershipId: member, kind: 'new_message', targetType: 'conversation',
      targetId: conversationId, dedupeKey: `inbound:${inboundEventId}`,
    });
    // Announcing a claimed conversation to the rest of the queue is how a
    // shared inbox teaches its agents to ignore notifications.
    expect(notifications.notifyClaimants).not.toHaveBeenCalled();
  });

  /**
   * The case that used to notify nobody.
   *
   * A customer writing in for the first time produced no notification for any
   * member, because the only recipient the code knew how to name was an
   * assignee that an unclaimed conversation does not have.
   */
  it('tells everyone who could claim it when nobody owns the thread yet', async () => {
    const { note, notifications } = inboundHarness(null, team);
    await note();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notifyClaimants).toHaveBeenCalledTimes(1);
    expect(notifications.notifyClaimants.mock.calls[0]?.[2]).toEqual({
      conversationId, connectionId: connection, teamId: team,
      kind: 'new_message', dedupeKey: `inbound:${inboundEventId}`,
    });
  });

  it('passes a null team through, so an unrouted conversation still reaches its inbox', async () => {
    const { note, notifications } = inboundHarness(null, null);
    await note();
    expect(notifications.notifyClaimants.mock.calls[0]?.[2]).toMatchObject({ teamId: null });
  });

  it('keys both audiences on the inbound event, so a redelivery cannot notify twice', async () => {
    const assigned = inboundHarness(member);
    await assigned.note();
    const unassigned = inboundHarness(null);
    await unassigned.note();
    expect(assigned.notifications.create.mock.calls[0]?.[2]).toMatchObject({ dedupeKey: `inbound:${inboundEventId}` });
    expect(unassigned.notifications.notifyClaimants.mock.calls[0]?.[2]).toMatchObject({ dedupeKey: `inbound:${inboundEventId}` });
  });
});
