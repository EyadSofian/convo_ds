import { describe, expect, it } from 'vitest';
import { QUEUE_CARD_FIELDS } from '../iam/authorize.js';
import type { Principal, ScopeGrant } from '../iam/authorize.js';
import type { PermissionKey } from '../iam/permissions.js';
import type { ScopeLevel } from '../iam/roles.js';
import { canonicalAuthority } from './authority.js';
import { checkCursor, decodeCursor, encodeCursor } from './cursor.js';
import { isRealtimeEventType, REALTIME_EVENT_TYPES, REALTIME_SCHEMA_VERSION } from './events.js';
import type { RealtimeEnvelope } from './events.js';
import { maskIdentity, projectQueueCard, visibilityOf } from './visibility.js';

/**
 * The realtime contract, decided without a socket.
 *
 * Everything a subscription needs to get right — who sees what, in which shape,
 * and whether a reconnect may resume — is a pure function over a principal and
 * an envelope. Proving it here means the transport is left with nothing to
 * decide, which is the point: a bug in an SSE loop must not be able to become a
 * disclosure.
 */

const INBOX = '11111111-1111-4111-8111-111111111111';
const OTHER_INBOX = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555';

function principal(
  grants: Partial<Record<PermissionKey, ScopeLevel>>,
  scopes: readonly ScopeGrant[] = [{ type: 'tenant', id: null }],
  overrides: Partial<Principal> = {},
): Principal {
  return {
    membershipId: AGENT,
    membershipStatus: 'active',
    tenantStatus: 'active',
    grants,
    scopes,
    delegationCeiling: null,
    ...overrides,
  };
}

function event(overrides: Partial<RealtimeEnvelope> = {}): RealtimeEnvelope {
  return {
    schemaVersion: REALTIME_SCHEMA_VERSION,
    id: '66666666-6666-4666-8666-666666666666',
    seq: 7,
    type: 'message.inbound',
    entity: { type: 'conversation', id: '77777777-7777-4777-8777-777777777777', version: 3 },
    scope: {
      conversationId: '77777777-7777-4777-8777-777777777777',
      inboxId: INBOX,
      teamId: null,
      assigneeMembershipId: null,
    },
    occurredAt: '2026-09-09T10:00:00.000Z',
    payload: {
      inboxLabel: 'خط التسجيل',
      channel: 'whatsapp',
      peerIdentity: '15559998888',
      priority: 'high',
      status: 'open',
      waitingSinceAt: '2026-09-09T09:58:00.000Z',
      // Everything below is exactly what a queue card may not carry.
      text: 'رقم بطاقتي ١٢٣٤',
      attachments: ['passport.pdf'],
      contact: { name: 'سارة', phone: '15559998888' },
      note: 'internal',
    },
    ...overrides,
  };
}

describe('the event contract', () => {
  it('names each kind of change separately', () => {
    // One "changed" event with a discriminator inside the payload would force
    // every subscriber to receive everything and filter on the client.
    expect([...REALTIME_EVENT_TYPES]).toEqual([
      'message.inbound',
      'message.delivery',
      'conversation.assigned',
      'conversation.state',
      'conversation.note',
    ]);
  });

  it('recognises its own types and nothing else', () => {
    expect(isRealtimeEventType('message.inbound')).toBe(true);
    expect(isRealtimeEventType('conversation.everything')).toBe(false);
    expect(isRealtimeEventType(7)).toBe(false);
  });
});

describe('visibility', () => {
  it('gives a tenant-wide reader the event as written', () => {
    expect(visibilityOf(principal({ 'conversation.read': 'tenant' }), event())).toBe('full');
  });

  it('gives a scoped reader their own inbox and not another', () => {
    const supervisor = principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }]);
    expect(visibilityOf(supervisor, event())).toBe('full');
    expect(
      visibilityOf(supervisor, event({ scope: { ...event().scope, inboxId: OTHER_INBOX } })),
    ).toBe('hidden');
  });

  it('reaches a conversation through its team as well as its inbox', () => {
    const lead = principal({ 'conversation.read': 'scoped' }, [{ type: 'team', id: TEAM }]);
    // Granted the team but not the inbox: still their work.
    expect(visibilityOf(lead, event({ scope: { ...event().scope, teamId: TEAM } }))).toBe('full');
  });

  it('projects an unassigned conversation for an agent who may only preview it', () => {
    const agent = principal({ 'conversation.unassigned.preview': 'scoped' }, [
      { type: 'inbox', id: INBOX },
    ]);
    expect(visibilityOf(agent, event())).toBe('projected');
  });

  it('previews an unassigned conversation through its team as well as its inbox', () => {
    const agent = principal({ 'conversation.unassigned.preview': 'scoped' }, [
      { type: 'team', id: TEAM },
    ]);
    // Routed to their team, on an inbox they were never granted directly: the
    // card is still theirs to pick up.
    expect(visibilityOf(agent, event({ scope: { ...event().scope, teamId: TEAM } }))).toBe(
      'projected',
    );
    // And a conversation routed to a team they are not on stays hidden.
    expect(visibilityOf(agent, event())).toBe('hidden');
  });

  it('hides an assigned conversation from an agent who may only preview', () => {
    const agent = principal({ 'conversation.unassigned.preview': 'scoped' }, [
      { type: 'inbox', id: INBOX },
    ]);
    const assigned = event({
      scope: { ...event().scope, assigneeMembershipId: OTHER_AGENT },
    });
    // Somebody else's work. Not a card, not an id, nothing.
    expect(visibilityOf(agent, assigned)).toBe('hidden');
  });

  it('gives an agent the full event once it is theirs', () => {
    const agent = principal({ 'conversation.read': 'own' }, [{ type: 'inbox', id: INBOX }]);
    const mine = event({ scope: { ...event().scope, assigneeMembershipId: AGENT } });
    expect(visibilityOf(agent, mine)).toBe('full');
    // And not once it is somebody else's.
    expect(
      visibilityOf(agent, event({ scope: { ...event().scope, assigneeMembershipId: OTHER_AGENT } })),
    ).toBe('hidden');
  });

  it('keeps a former assignee reading what they took part in', () => {
    const agent = principal({ 'conversation.read': 'own' }, [{ type: 'inbox', id: INBOX }]);
    const reassigned = event({
      type: 'conversation.assigned',
      scope: { ...event().scope, assigneeMembershipId: OTHER_AGENT },
    });
    // The event that reassigned them is exactly the one they must still get.
    expect(visibilityOf(agent, reassigned, [AGENT])).toBe('full');
  });

  it('stops the stream the moment inbox access is taken away', () => {
    const before = principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }]);
    const after = principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: OTHER_INBOX }]);
    expect(visibilityOf(before, event())).toBe('full');
    // Losing inbox access overrides assignment and participation.
    expect(visibilityOf(after, event({ scope: { ...event().scope, assigneeMembershipId: AGENT } }), [AGENT])).toBe(
      'hidden',
    );
  });

  it.each([
    ['a revoked membership', { membershipStatus: 'revoked' as const }],
    ['a suspended membership', { membershipStatus: 'suspended' as const }],
    ['a suspended company', { tenantStatus: 'suspended' as const }],
  ])('hides everything from %s', (_label, overrides) => {
    const revoked = principal({ 'conversation.read': 'tenant' }, [{ type: 'tenant', id: null }], overrides);
    expect(visibilityOf(revoked, event())).toBe('hidden');
  });

  it('hides everything from someone with no conversation grant at all', () => {
    expect(visibilityOf(principal({ 'report.read': 'tenant' }), event())).toBe('hidden');
  });
});

describe('the queue card', () => {
  it('carries the eight permitted fields and nothing else', () => {
    const card = projectQueueCard(event());
    // The same list the field-policy term uses, so the two cannot drift.
    expect(Object.keys(card).sort()).toEqual([...QUEUE_CARD_FIELDS].sort());
  });

  it('never carries a transcript, an attachment, a note or contact PII', () => {
    const serialized = JSON.stringify(projectQueueCard(event()));
    for (const forbidden of ['رقم بطاقتي', 'passport.pdf', 'سارة', 'internal']) {
      expect(serialized).not.toContain(forbidden);
    }
    // And not the raw identity either: a phone number is contact PII.
    expect(serialized).not.toContain('15559998888');
  });

  it('keeps enough of the identity to tell two waiting cards apart', () => {
    expect(maskIdentity('15559998888')).toBe('••••888');
    expect(maskIdentity('15559998889')).toBe('••••889');
  });

  it('masks a short identity entirely rather than mostly', () => {
    // Keeping three of five characters would be a disclosure dressed as a mask.
    expect(maskIdentity('12345')).toBe('••••');
    expect(maskIdentity('')).toBe('');
    expect(maskIdentity('   ')).toBe('');
  });

  it('answers a payload that is missing everything', () => {
    const card = projectQueueCard(event({ payload: {} }));
    expect(card).toEqual({
      id: '77777777-7777-4777-8777-777777777777',
      inboxLabel: '',
      channel: 'unknown',
      maskedLabel: '',
      priority: 'normal',
      status: 'open',
      waitingSinceAt: null,
      claimable: true,
      version: 3,
    });
  });

  it('reports a claimed conversation as not claimable', () => {
    const card = projectQueueCard(
      event({ scope: { ...event().scope, assigneeMembershipId: OTHER_AGENT } }),
    );
    expect(card.claimable).toBe(false);
  });

  it('ignores a payload whose fields are the wrong type', () => {
    const card = projectQueueCard(
      event({ payload: { priority: 9, status: null, waitingSinceAt: 1_700_000_000 } }),
    );
    expect(card.priority).toBe('normal');
    expect(card.status).toBe('open');
    expect(card.waitingSinceAt).toBeNull();
  });
});

describe('the authority digest', () => {
  it('distinguishes a tenant-wide reach from a scoped one', () => {
    const everywhere = principal({ 'conversation.read': 'scoped' }, [{ type: 'tenant', id: null }]);
    const oneInbox = principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }]);
    // The same grants with a different reach are different authorities, so a
    // cursor issued under one cannot be resumed under the other.
    expect(canonicalAuthority(everywhere)).not.toBe(canonicalAuthority(oneInbox));
    expect(canonicalAuthority(everywhere)).toContain('tenant:*');
  });

  it('is stable across the order rows came back in', () => {
    const one = principal({ 'conversation.read': 'scoped', 'conversation.claim': 'scoped' }, [
      { type: 'inbox', id: INBOX },
      { type: 'team', id: TEAM },
    ]);
    const other = principal({ 'conversation.claim': 'scoped', 'conversation.read': 'scoped' }, [
      { type: 'team', id: TEAM },
      { type: 'inbox', id: INBOX },
    ]);
    // Otherwise every reconnect would reset the client for no reason.
    expect(canonicalAuthority(one)).toBe(canonicalAuthority(other));
  });

  it.each([
    ['a new inbox', principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: OTHER_INBOX }])],
    ['a widened grant', principal({ 'conversation.read': 'tenant' }, [{ type: 'inbox', id: INBOX }])],
    ['a new permission', principal({ 'conversation.read': 'scoped', 'conversation.claim': 'own' }, [{ type: 'inbox', id: INBOX }])],
    [
      'a suspended membership',
      principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }], {
        membershipStatus: 'suspended',
      }),
    ],
    [
      'a delegation ceiling',
      principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }], {
        delegationCeiling: ['conversation.read'],
      }),
    ],
  ])('changes when %s appears', (_label, changed) => {
    const base = principal({ 'conversation.read': 'scoped' }, [{ type: 'inbox', id: INBOX }]);
    expect(canonicalAuthority(changed)).not.toBe(canonicalAuthority(base));
  });
});

describe('cursors', () => {
  const context = { tenantId: 'tenant-1', authority: 'digest-1', oldestRetainedSeq: 1 };

  it('round-trips a position', () => {
    const cursor = { tenantId: 'tenant-1', seq: 42, authority: 'digest-1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('starts a first connection at the beginning of what is retained', () => {
    expect(checkCursor(null, { ...context, oldestRetainedSeq: 5 })).toEqual({ status: 'ok', seq: 4 });
  });

  it('resumes from a cursor issued under the same authority', () => {
    const cursor = encodeCursor({ tenantId: 'tenant-1', seq: 9, authority: 'digest-1' });
    expect(checkCursor(cursor, context)).toEqual({ status: 'ok', seq: 9 });
  });

  it.each([
    ['nonsense', 'not-a-cursor', 'malformed'],
    ['an empty string', '', 'malformed'],
    ['a cursor from an older build', Buffer.from('v0|tenant-1|9|digest-1').toString('base64url'), 'malformed'],
    ['a truncated cursor', Buffer.from('v1|tenant-1|9').toString('base64url'), 'malformed'],
    ['a non-numeric position', Buffer.from('v1|tenant-1|nine|digest-1').toString('base64url'), 'malformed'],
    ['an empty tenant', Buffer.from('v1||9|digest-1').toString('base64url'), 'malformed'],
    ['an empty authority', Buffer.from('v1|tenant-1|9|').toString('base64url'), 'malformed'],
  ])('refuses %s', (_label, value, reason) => {
    expect(checkCursor(value, context)).toEqual({ status: 'reset_required', reason });
  });

  it('refuses another company’s cursor', () => {
    const foreign = encodeCursor({ tenantId: 'tenant-2', seq: 9, authority: 'digest-1' });
    expect(checkCursor(foreign, context)).toEqual({
      status: 'reset_required',
      reason: 'other_tenant',
    });
  });

  it('refuses a cursor issued before the caller’s permissions changed', () => {
    const stale = encodeCursor({ tenantId: 'tenant-1', seq: 9, authority: 'digest-0' });
    // Both halves are wrong after a permission change: events already sent may
    // no longer be permitted, and events skipped may now be.
    expect(checkCursor(stale, context)).toEqual({
      status: 'reset_required',
      reason: 'permissions_changed',
    });
  });

  it('refuses a cursor older than the feed still holds', () => {
    const ancient = encodeCursor({ tenantId: 'tenant-1', seq: 3, authority: 'digest-1' });
    expect(checkCursor(ancient, { ...context, oldestRetainedSeq: 100 })).toEqual({
      status: 'reset_required',
      reason: 'expired',
    });
  });

  it('accepts the cursor sitting exactly at the edge of the window', () => {
    // The client holds the last event before the pruned window: it has missed
    // nothing, and resetting it would be a reset for no reason.
    const edge = encodeCursor({ tenantId: 'tenant-1', seq: 99, authority: 'digest-1' });
    expect(checkCursor(edge, { ...context, oldestRetainedSeq: 100 })).toEqual({
      status: 'ok',
      seq: 99,
    });
  });
});
