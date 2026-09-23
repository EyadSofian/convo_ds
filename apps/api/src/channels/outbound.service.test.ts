import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { LifecycleService } from '../conversations/lifecycle.service.js';
import type { Principal } from '@convo/domain';
import { OutboundService, requireLiveConnection } from './outbound.service.js';

const id = '11111111-1111-4111-8111-111111111111';
const rawConversation = {
  id, connection_id: id, peer_identity: '15550000000', team_id: null, assignee_membership_id: null,
  status: 'open', priority: 'normal', version: 1, waiting_since: null, contact_id: null,
  pending_reason: null, snoozed_until: null, snooze_timezone: null, resolution: null, resolved_at: null,
  last_activity_at: new Date(), owner_state: 'human_active', owner_version: 0,
};

function catalogueHarness(options: { conversation?: Record<string, unknown> | null; kind?: string; grants?: Principal['grants']; templates?: readonly Record<string, unknown>[] } = {}) {
  const principal: Principal = { membershipId: id, membershipStatus: 'active', tenantStatus: 'active', grants: options.grants ?? { 'conversation.reply': 'tenant' }, scopes: [], delegationCeiling: null };
  const query = vi.fn(async <T>(text: string, _values?: readonly unknown[]) => {
    void _values;
    if (text.includes('FROM conversations c')) return { rows: (options.conversation === null ? [] : [{ ...rawConversation, display_name: 'WhatsApp', kind: options.kind ?? 'whatsapp', ...(options.conversation ?? {}) }]) as T[], rowCount: 1 };
    if (text.includes('FROM conversation_participants')) return { rows: [] as T[], rowCount: 0 };
    if (text.includes('FROM channel_connections')) return { rows: [{ id, kind: options.kind ?? 'whatsapp', capabilities: null, disconnected_at: null }] as T[], rowCount: 1 };
    if (text.includes('FROM whatsapp_templates')) return { rows: (options.templates ?? []) as T[], rowCount: (options.templates ?? []).length };
    return { rows: [] as T[], rowCount: 0 };
  });
  const sql = { query } as unknown as SqlExecutor;
  const authorization = { withPrincipal: vi.fn(async (_session, _tenant, work) => work({ sql, principal })) } as unknown as AuthorizationService;
  const service = new OutboundService(authorization, { noteResponse: vi.fn() } as unknown as LifecycleService);
  return { service, sql, query };
}

describe('OutboundService defensive boundaries', () => {
  it('rejects an idempotency key already owned by another author', async () => {
    const principal: Principal = { membershipId: id, membershipStatus: 'active', tenantStatus: 'active', grants: { 'conversation.reply': 'tenant' }, scopes: [], delegationCeiling: null };
    const sql = { query: vi.fn(async <T>(text: string) => text.includes('FROM outbound_messages WHERE tenant_id')
      ? { rows: [{ id: 'existing-message', author_membership: 'different-membership' }] as T[], rowCount: 1 }
      : { rows: [] as T[], rowCount: 0 }) } as unknown as SqlExecutor;
    const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, tenantId: id, principal, decision: {}, scope: 'tenant' })) } as unknown as AuthorizationService;
    const service = new OutboundService(authorization, { noteResponse: vi.fn() } as unknown as LifecycleService);
    await expect(service.queue({ userId: 'user' } as never, id, id, {
      peerIdentity: 'synthetic-visitor', messageType: 'text', text: 'hello', clientMessageId: 'same-key-123',
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_key_conflict' });
    expect(sql.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a WhatsApp template send on a different live channel', async () => {
    const principal: Principal = { membershipId: id, membershipStatus: 'active', tenantStatus: 'active', grants: { 'conversation.reply': 'tenant' }, scopes: [], delegationCeiling: null };
    const sql = { query: vi.fn(async <T>(text: string) => {
      if (text.includes('FROM outbound_messages WHERE tenant_id')) return { rows: [] as T[], rowCount: 0 };
      if (text.includes('FROM channel_connections')) return { rows: [{ id, kind: 'messenger', capabilities: null, disconnected_at: null }] as T[], rowCount: 1 };
      return { rows: [] as T[], rowCount: 0 };
    }) } as unknown as SqlExecutor;
    const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, tenantId: id, principal, decision: {}, scope: 'tenant' })) } as unknown as AuthorizationService;
    const service = new OutboundService(authorization, { noteResponse: vi.fn() } as unknown as LifecycleService);
    await expect(service.queue({ userId: 'user' } as never, id, id, {
      peerIdentity: 'synthetic-visitor', messageType: 'template', text: '', clientMessageId: 'template-key-123',
      template: { id, parameters: {} },
    })).rejects.toMatchObject({ status: 422, code: 'template_not_sendable' });
    expect(sql.query).toHaveBeenCalledTimes(2);
  });

  it('authorizes and filters the bounded WhatsApp catalogue, escaping LIKE metacharacters and returning a next cursor', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: `template-${index}`, provider_template_id: `provider-${index}`, template_name: `order_${index}`, language: 'ar', category: 'utility',
      status: 'approved', components: [{ type: 'BODY', text: 'Order {{1}}' }], last_synced_at: new Date('2026-09-20T00:00:00Z'),
    }));
    const { service, query } = catalogueHarness({ conversation: { team_id: 'team-1' }, templates: rows });
    const page = await service.templates({ userId: 'user' } as never, id, id, { search: 'order_%', language: 'ar', category: 'UTILITY', status: 'approved', cursor: '0' });
    expect(page.items).toHaveLength(50);
    expect(page.items[0]).toMatchObject({ id: 'template-0', name: 'order_0', sendSupported: true });
    expect(page.nextCursor).toBe('50');
    const catalogueCall = query.mock.calls.find(([text]) => text.includes('FROM whatsapp_templates'));
    expect(catalogueCall?.[0]).toContain('lower(template_name) LIKE');
    expect(catalogueCall?.[0]).toContain('language=');
    expect(catalogueCall?.[0]).toContain('category=');
    expect(catalogueCall?.[0]).toContain('status=');
    expect(catalogueCall?.[1]).toContain('%order\\_\\%%');
  });

  it('conceals missing, archived, unauthorized, and non-WhatsApp template catalogues', async () => {
    const missing = catalogueHarness({ conversation: null });
    await expect(missing.service.templates({ userId: 'user' } as never, id, id, { search: '', language: '', category: '', status: 'approved', cursor: null })).rejects.toMatchObject({ status: 404 });
    const archived = catalogueHarness({ conversation: { status: 'archived' } });
    await expect(archived.service.templates({ userId: 'user' } as never, id, id, { search: '', language: '', category: '', status: 'approved', cursor: null })).rejects.toMatchObject({ status: 404 });
    const forbidden = catalogueHarness({ grants: {} });
    await expect(forbidden.service.templates({ userId: 'user' } as never, id, id, { search: '', language: '', category: '', status: 'approved', cursor: null })).rejects.toMatchObject({ status: 403 });
    const otherChannel = catalogueHarness({ kind: 'messenger' });
    await expect(otherChannel.service.templates({ userId: 'user' } as never, id, id, { search: '', language: '', category: '', status: 'approved', cursor: null })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects malformed and excessive catalogue offsets before querying templates', async () => {
    const { service, query } = catalogueHarness();
    for (const cursor of ['-1', '1.5', '2001', 'oops']) {
      await expect(service.templates({ userId: 'user' } as never, id, id, { search: '', language: '', category: '', status: 'approved', cursor })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('FROM whatsapp_templates'), expect.anything());
  });

  it('maps missing and disconnected connections to typed errors', async () => {
    const missing = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as SqlExecutor;
    await expect(requireLiveConnection(missing, id)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    const disconnected = { query: vi.fn(async () => ({ rows: [{ id, kind: 'whatsapp', capabilities: null, disconnected_at: new Date() }], rowCount: 1 })) } as unknown as SqlExecutor;
    await expect(requireLiveConnection(disconnected, id)).rejects.toMatchObject({ status: 409, code: 'channel_disconnected' });
  });

  it('refuses a reply whose conversation no longer matches the requested channel and peer', async () => {
    const sql = { query: vi.fn(async <T>(text: string) => {
      if (text.includes('channel_connections')) return { rows: [{ id, kind: 'whatsapp', capabilities: null, disconnected_at: null }] as T[], rowCount: 1 };
      if (text.includes('peer_identity=$4')) return { rows: [] as T[], rowCount: 0 };
      if (text.includes('FROM conversations WHERE id = $1')) return { rows: [rawConversation] as T[], rowCount: 1 };
      if (text.includes('FROM outbound_messages WHERE client_message_id')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM conversations')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }) } as unknown as SqlExecutor;
    const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, tenantId: id, principal: { membershipId: id }, decision: {}, scope: 'tenant' })) } as unknown as AuthorizationService;
    const lifecycle = { noteResponse: vi.fn() } as unknown as LifecycleService;
    const service = new OutboundService(authorization, lifecycle);
    await expect(service.queue({ userId: 'user' } as never, id, id, {
      peerIdentity: '15550000001', messageType: 'text', text: 'hello', clientMessageId: 'reply-1234',
    }, {}, id)).rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
  });

  it('rejects WhatsApp free-form replies when this conversation has no inbound in its active window', async () => {
    const query = vi.fn(async <T>(text: string, _values?: readonly unknown[]) => {
      void _values;
      if (text.includes('channel_connections')) return { rows: [{ id, kind: 'whatsapp', capabilities: null, disconnected_at: null }] as T[], rowCount: 1 };
      if (text.includes('peer_identity=$4')) return { rows: [{ id }] as T[], rowCount: 1 };
      if (text.includes('FROM conversations WHERE id = $1')) return { rows: [rawConversation] as T[], rowCount: 1 };
      if (text.includes('FROM conversations WHERE id=$1')) return { rows: [{ id }] as T[], rowCount: 1 };
      if (text.includes('max(inbound.occurred_at)')) return { rows: [{ last_inbound_at: new Date('2026-09-18T09:00:00Z'), server_now: new Date('2026-09-20T09:00:00Z') }] as T[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const sql = { query } as unknown as SqlExecutor;
    const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, tenantId: id, principal: { membershipId: id }, decision: {}, scope: 'tenant' })) } as unknown as AuthorizationService;
    const service = new OutboundService(authorization, { noteResponse: vi.fn() } as unknown as LifecycleService);
    await expect(service.queue({ userId: 'user' } as never, id, id, {
      peerIdentity: '15550000000', messageType: 'text', text: 'still there?', clientMessageId: 'reply-closed-1',
    }, {}, id)).rejects.toMatchObject({ status: 422, code: 'outside_service_window' });
    expect(query.mock.calls.map(([text]) => text).find((text) => text.includes('max(inbound.occurred_at)'))).toContain('other.archived_at');
  });
});
