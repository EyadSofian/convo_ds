/**
 * The realtime event contract (DEL-19).
 *
 * One envelope shape for every event, carrying four things a consumer cannot
 * work without:
 *
 * 1. **`schemaVersion`** — so a client built against an older shape can refuse
 *    loudly instead of silently misreading a field.
 * 2. **`id`** — a stable identity for deduplication. At-least-once delivery is
 *    the honest guarantee (ADR-0004), so the consumer needs something to
 *    recognise a repeat by; a sequence number alone cannot do it across a
 *    catch-up that overlaps a live stream.
 * 3. **`entity` + `entityVersion`** — so an out-of-order or replayed event can
 *    be dropped rather than rolling a screen backwards.
 * 4. **`scope`** — the terms authorization is decided from. They are part of
 *    the envelope rather than the payload because the decision is made *before*
 *    the payload is read.
 *
 * `seq` is dense and gapless per company, so a client can tell "nothing
 * happened" apart from "I missed something".
 */

export const REALTIME_SCHEMA_VERSION = 1;

/**
 * Separate types, deliberately.
 *
 * The task's rule is that provider status, assignment, read state, notes and
 * conversation state are distinct events. Collapsing them into one "changed"
 * event would force every subscriber to receive everything and filter on the
 * client, which is the same mistake as hiding a field in the browser.
 */
export const REALTIME_EVENT_TYPES = [
  /** A customer message was normalized into the inbox. */
  'message.inbound',
  /** A provider receipt moved an outbound message's delivery state. */
  'message.delivery',
  /** The conversation gained, lost or changed its assignee. */
  'conversation.assigned',
  /** The conversation opened, snoozed or resolved. */
  'conversation.state',
  /** A private note was written. Never projected, never previewed. */
  'conversation.note',
  /**
   * An offer between two named people was made or answered.
   *
   * Its own type rather than a flavour of `conversation.assigned`, because it
   * must be filtered like a note: an agent who may only *preview* an unclaimed
   * conversation has no business learning that colleagues are negotiating who
   * takes it. Filtered by the type before any payload is read.
   */
  'conversation.handoff',
  /**
   * Priority or collaborators changed.
   *
   * Projected rather than hidden: priority is a field of the queue card, so an
   * agent deciding what to pick up is entitled to know it moved.
   */
  'conversation.routing',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export function isRealtimeEventType(value: unknown): value is RealtimeEventType {
  return typeof value === 'string' && (REALTIME_EVENT_TYPES as readonly string[]).includes(value);
}

/** The authorization terms, as carried on the wire. */
export interface RealtimeScope {
  readonly conversationId: string;
  /** The inbox. A channel connection is an inbox in this build. */
  readonly inboxId: string;
  readonly teamId: string | null;
  readonly assigneeMembershipId: string | null;
}

export interface RealtimeEnvelope {
  readonly schemaVersion: number;
  readonly id: string;
  readonly seq: number;
  readonly type: RealtimeEventType;
  /**
   * What the event is about.
   *
   * `note` is separate from `message` on purpose: a subscriber authorized for
   * receipts and not for notes is filtered by this column, before anything
   * reads the payload.
   */
  readonly entity: {
    readonly type: 'conversation' | 'message' | 'note';
    readonly id: string;
    readonly version: number;
  };
  readonly scope: RealtimeScope;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The queue card an unclaimed conversation is projected to.
 *
 * The shape, not a subset of a bigger shape: it is built field by field from
 * named sources, so a payload that grows a `snippet` tomorrow cannot leak
 * through it. `QUEUE_CARD_FIELDS` in `iam/authorize.ts` is the same list, and
 * the contract test asserts the two agree.
 */
export interface QueueCard {
  readonly id: string;
  readonly inboxLabel: string;
  readonly channel: string;
  readonly maskedLabel: string;
  readonly priority: string;
  readonly status: string;
  readonly waitingSinceAt: string | null;
  readonly claimable: boolean;
  /** The version to claim at. See `QUEUE_CARD_FIELDS`. */
  readonly version: number;
}
