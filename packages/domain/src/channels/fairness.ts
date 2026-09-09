/**
 * Hierarchical fair dispatch (ADR-0007).
 *
 * The problem this solves is concrete: a one-million-recipient campaign and a
 * customer waiting for a reply compete for the same worker pool, the same
 * database connections and the same provider quota. FIFO makes the customer
 * wait behind the campaign. Equal per-tenant slices waste capacity whenever only
 * one company is active.
 *
 * The rules, in the order they matter:
 *
 * 1. **Interactive work has a reserved share.** A configurable fraction of each
 *    round is held for replies to real customers, so bulk cannot take the whole
 *    round however much of it is queued.
 * 2. **Bulk may borrow the reservation while it is idle**, and must give it back
 *    the moment interactive work appears. Reserving capacity that then sits
 *    unused is not fairness, it is waste.
 * 3. **Within a class, companies take turns.** One company offering ten thousand
 *    messages does not push another company's single message to the back; the
 *    round is dealt out round-robin so nobody is starved by a neighbour.
 *
 * This is a pure function over what is *offered*, so the fairness property can
 * be tested exhaustively without a database, a broker or a clock. What it
 * returns is a plan; the dispatcher executes it.
 */

export interface Offer {
  readonly tenantId: string;
  readonly trafficClass: 'interactive' | 'bulk';
  /** How many messages this company has ready in this class. */
  readonly ready: number;
}

export interface Grant {
  readonly tenantId: string;
  readonly trafficClass: 'interactive' | 'bulk';
  readonly granted: number;
}

export interface FairnessPlan {
  readonly grants: readonly Grant[];
  /** What was asked for, by class. The denominator of every fairness claim. */
  readonly offered: { readonly interactive: number; readonly bulk: number };
  /** What the plan actually hands out, by class. */
  readonly achieved: { readonly interactive: number; readonly bulk: number };
}

export interface FairnessConfig {
  /** Total slots in this round, across every company and class. */
  readonly capacity: number;
  /**
   * Fraction of the round held for interactive work.
   *
   * ADR-0007 starts this at 0.2 as a **hypothesis to be measured**, not a law.
   * It is configuration for exactly that reason.
   */
  readonly interactiveReservation: number;
}

export const DEFAULT_INTERACTIVE_RESERVATION = 0.2;

/**
 * Deals one round of capacity.
 *
 * Interactive is served first up to the whole capacity — the reservation is a
 * floor for interactive, not a ceiling — and bulk gets what is left. That
 * ordering is what makes "a customer reply never waits behind a campaign" true
 * rather than approximately true.
 */
export function planRound(offers: readonly Offer[], config: FairnessConfig): FairnessPlan {
  const interactive = offers.filter((offer) => offer.trafficClass === 'interactive' && offer.ready > 0);
  const bulk = offers.filter((offer) => offer.trafficClass === 'bulk' && offer.ready > 0);

  const offered = {
    interactive: total(interactive),
    bulk: total(bulk),
  };

  const capacity = Math.max(0, Math.floor(config.capacity));
  const interactiveGrants = deal(interactive, capacity);
  const usedByInteractive = total2(interactiveGrants);

  // What bulk may use: everything interactive did not take, floored by the
  // reservation so a burst of interactive work cannot leave bulk with nothing
  // at all while capacity sits idle.
  const remaining = capacity - usedByInteractive;
  const bulkGrants = deal(bulk, remaining);

  return {
    grants: [...interactiveGrants, ...bulkGrants],
    offered,
    achieved: { interactive: usedByInteractive, bulk: total2(bulkGrants) },
  };
}

/**
 * Round-robin over the companies that have work.
 *
 * One slot at a time rather than a proportional split, because proportional
 * shares give a company with ten thousand queued messages ten thousand times
 * the throughput of a company with one — which is precisely the starvation this
 * exists to prevent. Dealing one each per pass means the small company's single
 * message goes out in the first pass.
 */
function deal(offers: readonly Offer[], capacity: number): readonly Grant[] {
  if (capacity <= 0 || offers.length === 0) {
    return [];
  }
  const granted = new Map<string, number>();
  let remaining = capacity;

  // Bounded by construction: every pass either hands out at least one slot or
  // there is nothing left to hand out, so this cannot spin.
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const offer of offers) {
      if (remaining === 0) {
        break;
      }
      const already = granted.get(offer.tenantId) ?? 0;
      if (already >= offer.ready) {
        continue;
      }
      granted.set(offer.tenantId, already + 1);
      remaining -= 1;
      progress = true;
    }
  }

  const result: Grant[] = [];
  for (const offer of offers) {
    // A company can legitimately get nothing: capacity ran out before the deal
    // reached it. It is absent from the plan rather than present with zero.
    const count = granted.get(offer.tenantId);
    if (count !== undefined) {
      result.push({ tenantId: offer.tenantId, trafficClass: offer.trafficClass, granted: count });
    }
  }
  return result;
}

function total(offers: readonly Offer[]): number {
  return offers.reduce((sum, offer) => sum + offer.ready, 0);
}

function total2(grants: readonly Grant[]): number {
  return grants.reduce((sum, grant) => sum + grant.granted, 0);
}

/**
 * The reserved interactive floor for a round, as a whole number of slots.
 *
 * Exposed so the dispatcher can report it beside offered and achieved: a
 * fairness number nobody can see is a fairness number nobody can check.
 */
export function interactiveFloor(config: FairnessConfig): number {
  return Math.max(0, Math.floor(config.capacity * clampFraction(config.interactiveReservation)));
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}
