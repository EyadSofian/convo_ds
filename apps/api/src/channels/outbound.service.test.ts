import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { LifecycleService } from '../conversations/lifecycle.service.js';
import { OutboundService, requireLiveConnection } from './outbound.service.js';

const id = '11111111-1111-4111-8111-111111111111';
const rawConversation = {
  id, connection_id: id, peer_identity: '15550000000', team_id: null, assignee_membership_id: null,
  status: 'open', priority: 'normal', version: 1, waiting_since: null, contact_id: null,
  pending_reason: null, snoozed_until: null, snooze_timezone: null, resolution: null, resolved_at: null,
  last_activity_at: new Date(), owner_state: 'human_active', owner_version: 0,
};

describe('OutboundService defensive boundaries', () => {
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
