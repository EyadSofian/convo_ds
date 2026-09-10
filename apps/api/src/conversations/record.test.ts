import { describe, expect, it } from 'vitest';
import { CONVERSATION_STATES } from '@convo/domain';
import type { RawConversation } from './record.js';
import { rowOf } from './record.js';

/**
 * The one place the database's vocabulary meets the domain's.
 *
 * `conversations.status` carries a CHECK constraint naming exactly the states
 * the lifecycle table knows. That makes the two agree *today*; this asserts
 * that a future migration which widened one without the other fails loudly
 * rather than handing the lifecycle a status it has no row for — which would
 * surface as a conversation that silently refuses every transition.
 */

function raw(status: string, ownerState = 'human_active'): RawConversation {
  const now = new Date('2026-09-10T09:30:00.000Z');
  return {
    id: '22222222-2222-4222-8222-222222222222',
    connection_id: 'cn-1',
    peer_identity: '15559998888',
    team_id: null,
    assignee_membership_id: null,
    status,
    priority: 'normal',
    version: 1,
    waiting_since: null,
    contact_id: null,
    pending_reason: null,
    snoozed_until: null,
    snooze_timezone: null,
    resolution: null,
    resolved_at: null,
    last_activity_at: now,
    owner_state: ownerState,
    owner_version: 1,
  };
}

describe('rowOf', () => {
  it.each(CONVERSATION_STATES)('accepts %s, which the CHECK constraint allows', (status) => {
    expect(rowOf(raw(status)).status).toBe(status);
  });

  it('refuses an ownership state ADR-0008 has no rule for', () => {
    // The send permit's ownership term is total over the four states. A silent
    // cast here would hand it a fifth and there would be no rule to apply.
    expect(() => rowOf(raw('open', 'daydreaming'))).toThrow(
      /unknown ownership state daydreaming/,
    );
    expect(rowOf(raw('open', 'bot_paused')).ownerState).toBe('bot_paused');
  });

  it('refuses a status the lifecycle table has no row for', () => {
    // A silent cast here would produce a conversation that is refused every
    // transition with no explanation, in production, long after the migration
    // that caused it.
    expect(() => rowOf(raw('quarantined'))).toThrow(/unknown status quarantined/);
  });
});
