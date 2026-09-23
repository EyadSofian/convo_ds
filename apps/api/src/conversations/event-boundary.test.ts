import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import { conversationEventBoundary, latestConversationInbound } from './event-boundary.js';

describe('conversation event boundaries', () => {
  it('uses a half-open temporal interval and excludes events from later archived identity threads', () => {
    const sql = conversationEventBoundary('c', 'inbound', 'inbound.occurred_at', { inboundOpeningEvent: true });
    expect(sql).toContain('inbound.conversation_id=c.id');
    expect(sql).toContain('inbound.occurred_at >= LEAST(c.created_at');
    expect(sql).toContain('inbound.occurred_at < c.archived_at');
    expect(sql).toContain('other.connection_id=c.connection_id');
    expect(sql).toContain('other.peer_identity=c.peer_identity');
    expect(sql).toContain('other.id > c.id');
  });

  it('queries the newest inbound and database time through the canonical boundary', async () => {
    const lastInboundAt = new Date('2026-09-20T09:00:00Z');
    const serverNow = new Date('2026-09-20T10:00:00Z');
    const calls: Array<[string, readonly unknown[] | undefined]> = [];
    const query: SqlExecutor['query'] = async <T>(text: string, values?: readonly unknown[]) => {
      calls.push([text, values]);
      return { rows: [{ last_inbound_at: lastInboundAt, server_now: serverNow }] as T[], rowCount: 1 };
    };
    const evidence = await latestConversationInbound({ query } as unknown as SqlExecutor, 'conversation-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain('inbound.occurred_at < other.archived_at');
    expect(calls[0]?.[1]).toEqual(['conversation-1']);
    expect(evidence).toEqual({ lastInboundAt, serverNow });
  });
});
