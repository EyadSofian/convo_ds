import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERACTIVE_RESERVATION,
  interactiveFloor,
  planRound,
} from './fairness.js';
import type { Offer } from './fairness.js';

/**
 * Fair dispatch, asserted as properties rather than as one worked example.
 *
 * The claim these tests defend is CMP-T06's: one company offering most of the
 * traffic must not starve another company or an interactive reply. Checking
 * that with a single fixture would prove it for one arrangement of offers; the
 * generated cases below check it across many.
 */

const CONFIG = { capacity: 10, interactiveReservation: DEFAULT_INTERACTIVE_RESERVATION };

function offer(tenantId: string, trafficClass: 'interactive' | 'bulk', ready: number): Offer {
  return { tenantId, trafficClass, ready };
}

describe('planRound', () => {
  it('hands the whole round to interactive work when that is all there is', () => {
    const plan = planRound([offer('a', 'interactive', 25)], CONFIG);
    expect(plan.achieved).toEqual({ interactive: 10, bulk: 0 });
    expect(plan.offered).toEqual({ interactive: 25, bulk: 0 });
  });

  it('lets bulk borrow the whole round while no interactive work is queued', () => {
    // Reserving capacity that then sits unused is not fairness, it is waste.
    const plan = planRound([offer('a', 'bulk', 40)], CONFIG);
    expect(plan.achieved).toEqual({ interactive: 0, bulk: 10 });
  });

  it('takes the reservation back the moment interactive work appears', () => {
    const plan = planRound([offer('a', 'bulk', 40), offer('b', 'interactive', 3)], CONFIG);
    // The three replies go first, in the same round, not the next one.
    expect(plan.achieved.interactive).toBe(3);
    expect(plan.achieved.bulk).toBe(7);
  });

  it('never leaves a customer reply behind a campaign', () => {
    // The property CMP-T06 asks for, over a range of shapes rather than one.
    for (const campaign of [1, 10, 100, 10_000]) {
      for (const replies of [1, 2, 5]) {
        const plan = planRound(
          [offer('loud', 'bulk', campaign), offer('quiet', 'interactive', replies)],
          CONFIG,
        );
        expect(plan.achieved.interactive).toBe(Math.min(replies, CONFIG.capacity));
      }
    }
  });

  it('deals round-robin so a loud company cannot starve a quiet one', () => {
    const plan = planRound(
      [offer('loud', 'interactive', 10_000), offer('quiet', 'interactive', 1)],
      CONFIG,
    );
    const byTenant = new Map(plan.grants.map((grant) => [grant.tenantId, grant.granted]));
    // The quiet company's single message goes out in the first pass, not after
    // ten thousand of somebody else's.
    expect(byTenant.get('quiet')).toBe(1);
    expect(byTenant.get('loud')).toBe(9);
  });

  it('shares evenly between equal offers', () => {
    const plan = planRound(
      [
        offer('a', 'interactive', 100),
        offer('b', 'interactive', 100),
        offer('c', 'interactive', 100),
      ],
      { capacity: 9, interactiveReservation: 0.2 },
    );
    expect(plan.grants.map((grant) => grant.granted)).toEqual([3, 3, 3]);
  });

  it('never grants a company more than it offered', () => {
    for (const capacity of [1, 3, 7, 50]) {
      const plan = planRound(
        [offer('a', 'interactive', 2), offer('b', 'bulk', 3), offer('c', 'bulk', 1)],
        { capacity, interactiveReservation: 0.2 },
      );
      for (const grant of plan.grants) {
        const source = [
          offer('a', 'interactive', 2),
          offer('b', 'bulk', 3),
          offer('c', 'bulk', 1),
        ].find((entry) => entry.tenantId === grant.tenantId);
        expect(grant.granted).toBeLessThanOrEqual(source?.ready ?? 0);
      }
    }
  });

  it('never grants more than the capacity', () => {
    for (const capacity of [0, 1, 4, 11, 100]) {
      const plan = planRound(
        [
          offer('a', 'interactive', 50),
          offer('b', 'interactive', 50),
          offer('c', 'bulk', 50),
          offer('d', 'bulk', 50),
        ],
        { capacity, interactiveReservation: 0.2 },
      );
      expect(plan.achieved.interactive + plan.achieved.bulk).toBeLessThanOrEqual(
        Math.max(0, capacity),
      );
    }
  });

  it('grants everything offered when capacity is not the constraint', () => {
    const plan = planRound(
      [offer('a', 'interactive', 2), offer('b', 'bulk', 3)],
      { capacity: 100, interactiveReservation: 0.2 },
    );
    expect(plan.achieved).toEqual({ interactive: 2, bulk: 3 });
  });

  it('answers an empty round, and a round with nothing ready', () => {
    expect(planRound([], CONFIG)).toEqual({
      grants: [],
      offered: { interactive: 0, bulk: 0 },
      achieved: { interactive: 0, bulk: 0 },
    });
    // An offer of zero is not an offer.
    expect(planRound([offer('a', 'interactive', 0)], CONFIG).grants).toEqual([]);
  });

  it('leaves a company out of the plan entirely when capacity ran out first', () => {
    const plan = planRound(
      [offer('a', 'interactive', 5), offer('b', 'interactive', 5), offer('c', 'interactive', 5)],
      { capacity: 1, interactiveReservation: 0.2 },
    );
    // Absent rather than present with zero: a grant of nothing is not a grant.
    expect(plan.grants).toEqual([{ tenantId: 'a', trafficClass: 'interactive', granted: 1 }]);
  });

  it('answers a round with no capacity at all', () => {
    const plan = planRound([offer('a', 'interactive', 5)], { capacity: 0, interactiveReservation: 0.2 });
    expect(plan.grants).toEqual([]);
    // Offered is still reported: what was asked for is the denominator of every
    // fairness claim, and it does not stop existing because nothing was served.
    expect(plan.offered.interactive).toBe(5);
  });

  it('rounds a fractional capacity down rather than over-granting', () => {
    const plan = planRound([offer('a', 'bulk', 9)], { capacity: 4.9, interactiveReservation: 0.2 });
    expect(plan.achieved.bulk).toBe(4);
  });
});

describe('interactiveFloor', () => {
  it('reports the reserved share as whole slots', () => {
    expect(interactiveFloor({ capacity: 10, interactiveReservation: 0.2 })).toBe(2);
    expect(interactiveFloor({ capacity: 100, interactiveReservation: 0.35 })).toBe(35);
  });

  it('clamps a nonsensical reservation instead of trusting it', () => {
    // Configuration, so it can be wrong. A negative or absurd share must not
    // produce a negative floor that then over-grants.
    expect(interactiveFloor({ capacity: 10, interactiveReservation: -1 })).toBe(0);
    expect(interactiveFloor({ capacity: 10, interactiveReservation: 5 })).toBe(10);
    expect(interactiveFloor({ capacity: 10, interactiveReservation: Number.NaN })).toBe(0);
  });
});
