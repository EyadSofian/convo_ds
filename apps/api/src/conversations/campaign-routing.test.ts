import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import { RoutingService } from './routing.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';

describe('campaign lead routing guards', () => {
  it.each(['archived', 'member_missing', 'member_outside_inbox'])('keeps %s work out of automatic assignment', async (mode) => {
    const query = vi.fn(async <T>(statement: string) => {
      let rows: readonly unknown[] = [];
      if (statement.includes('FROM campaign_conversation_attributions')) rows = [{ assigned_membership_id: MEMBER, actor_id: null }];
      if (statement.includes('JOIN channel_connections')) rows = [{
        id: CONVERSATION, connection_id: '44444444-4444-4444-8444-444444444444', peer_identity: '201000000000',
        team_id: null, assignee_membership_id: null, status: mode === 'archived' ? 'archived' : 'open', priority: 'normal',
        version: 1, owner_state: 'human_active', owner_version: 1, last_activity_at: new Date(), waiting_since: null,
        contact_id: null, pending_reason: null, snoozed_until: null, snooze_timezone: null, resolution: null, resolved_at: null,
        display_name: 'Line', kind: 'whatsapp', contact_display_name: null, assignee_name: null,
      }];
      if (statement.includes('FROM memberships m') && mode === 'member_outside_inbox') rows = [{
        membership_id: MEMBER, role_id: 'role', membership_status: 'active', tenant_status: 'active',
      }];
      if (statement.includes('FROM role_permissions')) rows = [{ permission_key: 'conversation.reply', scope_level: 'own' }];
      return { rows: rows as T[], rowCount: rows.length };
    });
    const service = new RoutingService({} as never, {} as never, {} as never, {} as never);
    await service.assignCampaignLead({ query } as SqlExecutor, TENANT, CONVERSATION);
    expect(query.mock.calls.some(([statement]) => statement.includes('UPDATE conversations'))).toBe(false);
  });
});
