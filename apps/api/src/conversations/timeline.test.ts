import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import { readTimeline } from './timeline.js';

describe('conversation timeline reactions', () => {
  it('reads customer emoji messages and only reactions targeting this conversation’s outbound message', async () => {
    let statement = '';
    const query: SqlExecutor['query'] = async <T>(text: string) => {
      statement = text;
      return { rows: [
        { id: 'reaction-1', direction: 'reaction', at: new Date('2026-09-25T10:02:00Z'), content_type: 'reaction', text_body: '❤️', attachments: [], author_membership_id: null, command_state: null, delivery_state: null, delivery_anomaly: null, provider_message_id: 'mid-1', template_name: null, template_language: null, template_preview: null, reaction_action: 'react' },
        { id: 'in-1', direction: 'in', at: new Date('2026-09-25T10:01:00Z'), content_type: 'text', text_body: '😀', attachments: [], author_membership_id: null, command_state: null, delivery_state: null, delivery_anomaly: null, provider_message_id: 'mid-2', template_name: null, template_language: null, template_preview: null, reaction_action: null },
      ] as T[], rowCount: 2 };
    };
    const page = await readTimeline({ query } as unknown as SqlExecutor, 'conversation-1', 'connection-1', 'peer-1', null, 50);
    expect(page.rows.map((row) => [row.direction, row.text, row.reaction_action])).toEqual([
      ['in', '😀', null], ['reaction', '❤️', 'react'],
    ]);
    expect(statement).toContain("r.kind='reaction'");
    expect(statement).toContain('target.provider_message_id=r.provider_message_id');
    expect(statement).toContain('target.conversation_id=$1');
    expect(statement).toContain('target.created_at < COALESCE((SELECT c.archived_at');
  });
});
