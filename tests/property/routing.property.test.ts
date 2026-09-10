import { describe, expect, it } from 'vitest';
import {
  checkHandoffAction,
  checkHandoffExpiry,
  HANDOFF_ACTIONS,
  HANDOFF_MAX_TTL_MS,
  HANDOFF_MIN_TTL_MS,
  HANDOFF_STATES,
  OWNER_STATES,
  ownershipPermits,
  settledStateOf,
} from '../../packages/domain/src/conversations/routing.js';
import type {
  HandoffActor,
  HandoffOffer,
  HandoffState,
  SendActor,
} from '../../packages/domain/src/conversations/routing.js';

const NOW_MS = Date.parse('2026-09-10T12:00:00.000Z');
const REQUESTER = 'membership-requester';
const RECIPIENT = 'membership-recipient';
const OTHER = 'membership-other';

const ACTORS: readonly HandoffActor[] = [
  { membershipId: REQUESTER, mayAssign: false },
  { membershipId: RECIPIENT, mayAssign: false },
  { membershipId: OTHER, mayAssign: false },
  { membershipId: OTHER, mayAssign: true },
];

function offer(
  state: HandoffState,
  expiresAt: number,
  currentAssigneeMembershipId: string | null = REQUESTER,
): HandoffOffer {
  return {
    state,
    fromMembershipId: REQUESTER,
    toMembershipId: RECIPIENT,
    expiresAt: new Date(expiresAt),
    basedOnAssigneeMembershipId: REQUESTER,
    currentAssigneeMembershipId,
  };
}

describe('routing properties over the complete finite state space', () => {
  it('makes every settled handoff terminal for every action and actor', () => {
    for (const state of HANDOFF_STATES.filter((value) => value !== 'pending')) {
      for (const action of HANDOFF_ACTIONS) {
        for (const actor of ACTORS) {
          expect(
            checkHandoffAction(offer(state, NOW_MS + 60_000), action, actor, new Date(NOW_MS)),
          ).toBe('handoff_not_pending');
        }
      }
    }
  });

  it('makes expiry independent of identity and assignment', () => {
    for (const actor of ACTORS) {
      for (const current of [REQUESTER, RECIPIENT, OTHER, null]) {
        const expired = offer('pending', NOW_MS, current);
        for (const action of HANDOFF_ACTIONS) {
          expect(checkHandoffAction(expired, action, actor, new Date(NOW_MS))).toBe(
            action === 'expire' ? null : 'handoff_expired',
          );
        }
      }
    }
  });

  it('lets no actor answer for the named recipient before expiry', () => {
    const live = offer('pending', NOW_MS + 60_000);
    for (const actor of ACTORS) {
      for (const action of ['accept', 'decline'] as const) {
        const result = checkHandoffAction(live, action, actor, new Date(NOW_MS));
        expect(result).toBe(actor.membershipId === RECIPIENT ? null : 'not_the_recipient');
      }
    }
  });

  it('classifies a TTL by duration, unchanged when both instants move together', () => {
    const spans = [
      -1,
      0,
      HANDOFF_MIN_TTL_MS - 1,
      HANDOFF_MIN_TTL_MS,
      HANDOFF_MAX_TTL_MS,
      HANDOFF_MAX_TTL_MS + 1,
    ];
    const shifts = [-365 * 86_400_000, -1, 0, 1, 365 * 86_400_000];
    for (const span of spans) {
      const baseline = checkHandoffExpiry(new Date(NOW_MS + span), new Date(NOW_MS));
      for (const shift of shifts) {
        expect(
          checkHandoffExpiry(new Date(NOW_MS + shift + span), new Date(NOW_MS + shift)),
        ).toBe(baseline);
      }
    }
  });

  it('never returns a terminal offer to pending and permits sends only by the ownership table', () => {
    for (const action of HANDOFF_ACTIONS) {
      expect(settledStateOf(action)).not.toBe('pending');
    }

    const actors: readonly SendActor[] = ['human', 'bot'];
    for (const state of OWNER_STATES) {
      for (const actor of actors) {
        const result = ownershipPermits(state, actor);
        if (state === 'handoff_pending') {
          expect(result).toBe('handoff_barrier_pending');
        } else if (actor === 'human' || state === 'bot_active') {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
        }
      }
    }
  });
});
