import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_ACTS,
  checkHandoffAction,
  checkHandoffExpiry,
  HANDOFF_ACTIONS,
  HANDOFF_DEFAULT_TTL_MS,
  HANDOFF_MAX_TTL_MS,
  HANDOFF_MIN_TTL_MS,
  HANDOFF_STATES,
  isLiveHandoff,
  isOwnerState,
  OWNER_STATES,
  ownershipPermits,
  settledStateOf,
} from './routing.js';
import type { HandoffAction, HandoffOffer, HandoffState, OwnerState, SendActor } from './routing.js';

/**
 * The routing rules, decided without a database.
 *
 * Two things are worth proving here rather than through HTTP: that the handoff
 * decision is total and orders its refusals the way an operator needs to read
 * them, and that the ownership predicate is exhaustive over every state a
 * conversation can hold — including the three no route can reach today, which
 * is exactly why they need a test rather than an integration.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');
const HANA = 'm-hana';
const LAYLA = 'm-layla';
const OMAR = 'm-omar';

function offer(overrides: Partial<HandoffOffer> = {}): HandoffOffer {
  return {
    state: 'pending',
    fromMembershipId: HANA,
    toMembershipId: LAYLA,
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    basedOnAssigneeMembershipId: HANA,
    currentAssigneeMembershipId: HANA,
    ...overrides,
  };
}

describe('the handoff decision', () => {
  it('lets the person who was asked accept', () => {
    expect(
      checkHandoffAction(offer(), 'accept', { membershipId: LAYLA, mayAssign: false }, NOW),
    ).toBeNull();
  });

  it('refuses everybody but the recipient an answer', () => {
    for (const actor of [
      { membershipId: HANA, mayAssign: false },
      // Not even somebody with the authority to have assigned it outright:
      // answering on a colleague's behalf is not an answer.
      { membershipId: OMAR, mayAssign: true },
    ]) {
      expect(checkHandoffAction(offer(), 'accept', actor, NOW)).toBe('not_the_recipient');
      expect(checkHandoffAction(offer(), 'decline', actor, NOW)).toBe('not_the_recipient');
    }
  });

  it('lets the requester or an assigner withdraw, and nobody else', () => {
    expect(
      checkHandoffAction(offer(), 'cancel', { membershipId: HANA, mayAssign: false }, NOW),
    ).toBeNull();
    expect(
      checkHandoffAction(offer(), 'cancel', { membershipId: OMAR, mayAssign: true }, NOW),
    ).toBeNull();
    expect(
      checkHandoffAction(offer(), 'cancel', { membershipId: LAYLA, mayAssign: false }, NOW),
    ).toBe('not_the_requester');
  });

  it('refuses a settled offer before it looks at who is asking', () => {
    // The honest answer to the recipient who simply arrived second is "already
    // answered", not "you are not the recipient" — which they are.
    for (const state of ['accepted', 'declined', 'cancelled', 'expired'] as const) {
      expect(
        checkHandoffAction(offer({ state }), 'accept', { membershipId: LAYLA, mayAssign: false }, NOW),
      ).toBe('handoff_not_pending');
    }
  });

  it('treats an offer past its instant as expired before anybody has swept it', () => {
    const stale = offer({ expiresAt: new Date(NOW.getTime() - 1) });
    // Otherwise the answer to "may I accept this" would depend on how busy the
    // cluster is.
    expect(checkHandoffAction(stale, 'accept', { membershipId: LAYLA, mayAssign: false }, NOW)).toBe(
      'handoff_expired',
    );
    expect(checkHandoffAction(stale, 'cancel', { membershipId: HANA, mayAssign: false }, NOW)).toBe(
      'handoff_expired',
    );
    // The sweep is the one action that may settle it.
    expect(checkHandoffAction(stale, 'expire', { membershipId: HANA, mayAssign: false }, NOW)).toBeNull();
  });

  it('never expires an offer that is still standing', () => {
    expect(checkHandoffAction(offer(), 'expire', { membershipId: HANA, mayAssign: true }, NOW)).toBe(
      'handoff_not_pending',
    );
  });

  it('refuses acceptance once somebody else holds the conversation', () => {
    const moved = offer({ currentAssigneeMembershipId: OMAR });
    // Accepting would take it from Omar, who never agreed to anything, on the
    // word of Hana, who no longer has it to give.
    expect(
      checkHandoffAction(moved, 'accept', { membershipId: LAYLA, mayAssign: false }, NOW),
    ).toBe('handoff_superseded');
    // Declining stays possible: saying no to a request that has been overtaken
    // is still an answer, and leaving it pending forever helps nobody.
    expect(
      checkHandoffAction(moved, 'decline', { membershipId: LAYLA, mayAssign: false }, NOW),
    ).toBeNull();
  });

  it('is total over every state and action', () => {
    for (const state of HANDOFF_STATES) {
      for (const action of HANDOFF_ACTIONS) {
        const result = checkHandoffAction(
          offer({ state }),
          action,
          { membershipId: LAYLA, mayAssign: true },
          NOW,
        );
        expect(result === null || typeof result === 'string').toBe(true);
      }
    }
  });

  it('names the state each action settles into', () => {
    const settled: Record<HandoffAction, HandoffState> = {
      accept: 'accepted',
      decline: 'declined',
      cancel: 'cancelled',
      expire: 'expired',
    };
    for (const action of HANDOFF_ACTIONS) {
      expect(settledStateOf(action)).toBe(settled[action]);
      expect(isLiveHandoff(settledStateOf(action))).toBe(false);
    }
    expect(isLiveHandoff('pending')).toBe(true);
  });
});

describe('how long an offer may stand', () => {
  it('refuses a window too short to be a request', () => {
    // An offer that expires in ten seconds is not a request; it is a way to
    // produce an audit row saying somebody was asked.
    expect(checkHandoffExpiry(new Date(NOW.getTime() + 60_000), NOW)).toBe(
      'handoff_expiry_too_soon',
    );
    expect(checkHandoffExpiry(new Date(NOW.getTime() - 1), NOW)).toBe('handoff_expiry_too_soon');
  });

  it('refuses a window nobody would answer within', () => {
    expect(checkHandoffExpiry(new Date(NOW.getTime() + HANDOFF_MAX_TTL_MS + 1), NOW)).toBe(
      'handoff_expiry_too_far',
    );
  });

  it('accepts the bounds themselves and the default', () => {
    expect(checkHandoffExpiry(new Date(NOW.getTime() + HANDOFF_MIN_TTL_MS), NOW)).toBeNull();
    expect(checkHandoffExpiry(new Date(NOW.getTime() + HANDOFF_MAX_TTL_MS), NOW)).toBeNull();
    expect(checkHandoffExpiry(new Date(NOW.getTime() + HANDOFF_DEFAULT_TTL_MS), NOW)).toBeNull();
  });
});

describe('the ownership predicate', () => {
  /**
   * The whole table, stated. Three of these four states are unreachable through
   * any route in this build, which is precisely why they are proved here: the
   * day an AI path exists, the barrier is already the thing the send permit
   * consults, rather than a rule somebody has to remember to add.
   */
  const EXPECTED: Readonly<Record<OwnerState, Record<SendActor, string | null>>> = {
    human_active: { human: null, bot: 'ownership_is_human' },
    bot_active: { human: null, bot: null },
    bot_paused: { human: null, bot: 'bot_is_paused' },
    handoff_pending: { human: 'handoff_barrier_pending', bot: 'handoff_barrier_pending' },
  };

  it.each(OWNER_STATES)('decides %s for both actors', (state) => {
    expect(ownershipPermits(state, 'human')).toBe(EXPECTED[state].human);
    expect(ownershipPermits(state, 'bot')).toBe(EXPECTED[state].bot);
  });

  it('lets a human take over from a bot rather than refusing them', () => {
    // A person replying while the bot is answering IS the takeover. Refusing it
    // would make taking over impossible without a separate button nobody presses
    // in a hurry.
    expect(ownershipPermits('bot_active', 'human')).toBeNull();
  });

  it('stops everybody, human included, while a bot send may be in flight', () => {
    // ADR-0008 exists because nobody can recall a request Meta has accepted. A
    // human reply into that window is the double-reply the barrier prevents.
    expect(ownershipPermits('handoff_pending', 'human')).toBe('handoff_barrier_pending');
    expect(ownershipPermits('handoff_pending', 'bot')).toBe('handoff_barrier_pending');
  });

  it('never lets a paused bot resume by itself', () => {
    expect(ownershipPermits('bot_paused', 'bot')).toBe('bot_is_paused');
  });

  it('narrows an untrusted string to the four states', () => {
    for (const state of OWNER_STATES) {
      expect(isOwnerState(state)).toBe(true);
    }
    expect(isOwnerState('human')).toBe(false);
    expect(isOwnerState('')).toBe(false);
    expect(isOwnerState(null)).toBe(false);
    expect(isOwnerState(42)).toBe(false);
  });
});

describe('the assignment vocabulary', () => {
  it('names the four ways the assignee column changes', () => {
    expect([...ASSIGNMENT_ACTS]).toEqual(['claim', 'assign', 'unassign', 'handoff']);
  });

  it('keeps the assignment act distinct from the offer’s own settlement', () => {
    // `handoff` and `handoff_accepted` answer different questions — what
    // happened to the conversation, and what happened to the request — and two
    // acts one letter apart meaning two different things is a reader's trap.
    expect(ASSIGNMENT_ACTS).not.toContain('handoff_accept');
    expect(ASSIGNMENT_ACTS).not.toContain('handoff_accepted');
  });
});
