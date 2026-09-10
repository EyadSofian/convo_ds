/**
 * Who a conversation belongs to, and how it changes hands.
 *
 * Three acts move a conversation between people, and this module keeps them
 * apart because every product that merges them ends up lying about at least one
 * (ADR-0017):
 *
 * - a **claim** takes work nobody holds;
 * - an **assignment** puts work on a named person's desk, agreed or not;
 * - a **handoff** *asks* a named colleague, who may decline.
 *
 * Two different "ownership" questions also live here and are deliberately not
 * folded together. `AssignmentAct` is about which *person* holds a conversation.
 * `OwnerState` is ADR-0008's **bot-versus-human** dimension, whose
 * `handoff_pending` means "a bot's send may already be with the provider" — a
 * completely different fact from "Layla has been asked and has not answered".
 */

/* ----------------------------------------------------------- assignment -- */

/**
 * Why the assignee changed. Recorded on every audit row, because "the
 * conversation moved to Layla" and "Layla took the conversation" are different
 * events and only one of them involves somebody exercising authority.
 *
 * `handoff` and not `handoff_accept`: the settlement vocabulary below already
 * has `handoff_accepted` for what happened to the *offer*, and two acts one
 * letter apart meaning two different things is a reader's trap.
 */
export const ASSIGNMENT_ACTS = ['claim', 'assign', 'unassign', 'handoff'] as const;

export type AssignmentAct = (typeof ASSIGNMENT_ACTS)[number];

/* -------------------------------------------------------------- handoff -- */

export const HANDOFF_STATES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

const LIVE: HandoffState = 'pending';

/** True while the offer is still awaiting an answer. */
export function isLiveHandoff(state: HandoffState): boolean {
  return state === LIVE;
}

/** What somebody tried to do to an offer. */
export const HANDOFF_ACTIONS = ['accept', 'decline', 'cancel', 'expire'] as const;

export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export type HandoffRefusal =
  | 'handoff_not_pending'
  | 'not_the_recipient'
  | 'not_the_requester'
  | 'handoff_expired'
  | 'handoff_superseded';

/** Who is trying to settle an offer, in the only terms the decision needs. */
export interface HandoffActor {
  readonly membershipId: string;
  /** True when the actor could have made the assignment directly. */
  readonly mayAssign: boolean;
}

export interface HandoffOffer {
  readonly state: HandoffState;
  readonly fromMembershipId: string;
  readonly toMembershipId: string;
  readonly expiresAt: Date;
  /** Who held the conversation when the offer was made. */
  readonly basedOnAssigneeMembershipId: string | null;
  /** Who holds it now. */
  readonly currentAssigneeMembershipId: string | null;
}

/**
 * Decides whether an actor may settle an offer the way they asked to.
 *
 * A pure function over facts the caller has already read, so the same rules
 * apply to an HTTP request and to the expiry sweep, and neither can drift.
 *
 * The order matters. A **settled** offer refuses everybody first: once an offer
 * is answered, "you are not the recipient" would be a misleading reason to give
 * the person who *is* the recipient and simply arrived second. Expiry is checked
 * before identity for the same reason — the honest answer to "why can I not
 * accept this" is that it ran out, not that it is not addressed to you.
 */
export function checkHandoffAction(
  offer: HandoffOffer,
  action: HandoffAction,
  actor: HandoffActor,
  now: Date,
): HandoffRefusal | null {
  if (!isLiveHandoff(offer.state)) {
    return 'handoff_not_pending';
  }
  if (offer.expiresAt.getTime() <= now.getTime()) {
    // The sweep may not have run yet. An offer past its instant is expired
    // whether or not a worker has noticed, or the answer would depend on how
    // busy the cluster is.
    return action === 'expire' ? null : 'handoff_expired';
  }
  if (action === 'expire') {
    return 'handoff_not_pending';
  }
  if (action === 'accept' || action === 'decline') {
    // Only the person who was asked. Not the person who asked, not a
    // supervisor: answering on somebody's behalf is not an answer.
    if (actor.membershipId !== offer.toMembershipId) {
      return 'not_the_recipient';
    }
    // A newer ownership decision supersedes the offer. Accepting one made when
    // Hana held the conversation, after a supervisor moved it to Layla, would
    // take it from somebody who never agreed to anything — and the person who
    // made the offer no longer has it to give.
    //
    // Declining stays possible: saying no to a request that has been overtaken
    // is still an answer, and leaving it pending forever helps nobody.
    if (action === 'accept' && offer.currentAssigneeMembershipId !== offer.basedOnAssigneeMembershipId) {
      return 'handoff_superseded';
    }
    return null;
  }
  // `cancel`: the person who made the offer, or anybody who could have made the
  // assignment outright — tidying up a stale offer is a routing act.
  return actor.membershipId === offer.fromMembershipId || actor.mayAssign
    ? null
    : 'not_the_requester';
}

/** The state an offer lands in once the action is applied. */
export function settledStateOf(action: HandoffAction): Exclude<HandoffState, 'pending'> {
  if (action === 'accept') return 'accepted';
  if (action === 'decline') return 'declined';
  if (action === 'cancel') return 'cancelled';
  return 'expired';
}

/**
 * How long an offer may stand, and the bounds the API enforces.
 *
 * A floor as well as a ceiling: an offer that expires in ten seconds is not a
 * request, it is a way to produce an audit row that says somebody was asked.
 */
export const HANDOFF_MIN_TTL_MS = 5 * 60 * 1000;
export const HANDOFF_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_DEFAULT_TTL_MS = 60 * 60 * 1000;

export type HandoffTtlRefusal = 'handoff_expiry_too_soon' | 'handoff_expiry_too_far';

/** Checks a requested expiry against the clock the caller passes in. */
export function checkHandoffExpiry(expiresAt: Date, now: Date): HandoffTtlRefusal | null {
  const span = expiresAt.getTime() - now.getTime();
  if (span < HANDOFF_MIN_TTL_MS) {
    return 'handoff_expiry_too_soon';
  }
  return span > HANDOFF_MAX_TTL_MS ? 'handoff_expiry_too_far' : null;
}

/* ------------------------------------------------------ bot vs. human -- */

/**
 * ADR-0008's ownership dimension. Independent of the lifecycle status, of each
 * person's read cursor, and of provider delivery state (invariant I12).
 */
export const OWNER_STATES = ['bot_active', 'handoff_pending', 'human_active', 'bot_paused'] as const;

export type OwnerState = (typeof OWNER_STATES)[number];

const OWNER_SET: ReadonlySet<string> = new Set<string>(OWNER_STATES);

export function isOwnerState(value: unknown): value is OwnerState {
  return typeof value === 'string' && OWNER_SET.has(value);
}

/** Who is trying to send. */
export type SendActor = 'human' | 'bot';

export type OwnershipRefusal =
  | 'handoff_barrier_pending'
  | 'ownership_is_human'
  | 'bot_is_paused';

/**
 * The send permit's ownership term, as a total function.
 *
 * Centralised here and read from the stored state at permit time — never from
 * the browser and never from whatever the caller believed when a generation
 * started (ADR-0008). Four states × two actors, all eight stated:
 *
 * - **`human_active`** — people are working it. A bot may not send; a human may.
 * - **`bot_active`** — the bot is answering. A human sending *is* the takeover,
 *   so it is allowed and the caller records the transition.
 * - **`bot_paused`** — a person paused it. Neither an old queued generation nor
 *   a new one may resume by itself; a new inbound must not restart it either.
 * - **`handoff_pending`** — a bot request may already be with the provider.
 *   **Nobody sends**, human included: a human reply into that window is exactly
 *   the double-reply nobody can recall. The refusal says the barrier is open; it
 *   never claims the bot's message was cancelled.
 *
 * No bot exists in this build, so only `human_active` is reachable through a
 * route today. The function is total and exhaustively tested so that the day one
 * does exist, the barrier is already the thing the permit consults.
 */
export function ownershipPermits(state: OwnerState, actor: SendActor): OwnershipRefusal | null {
  if (state === 'handoff_pending') {
    return 'handoff_barrier_pending';
  }
  if (actor === 'human') {
    return null;
  }
  if (state === 'human_active') {
    return 'ownership_is_human';
  }
  return state === 'bot_paused' ? 'bot_is_paused' : null;
}
