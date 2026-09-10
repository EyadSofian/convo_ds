/**
 * The conversation lifecycle, as a table rather than as a set of `if`s.
 *
 * MASTER-PROMPT §18.1 specifies eleven rows. They are written here as data,
 * decided by one function, because the alternative — a `status` column each
 * endpoint is trusted to update correctly — is how a conversation ends up
 * `resolved` with an unread customer message in it.
 *
 * Three properties this shape buys, none of which survive scattering the rules
 * across handlers:
 *
 * - **A trigger that changes nothing says so.** A receipt, a typing indicator
 *   and a private note are explicit `unchanged` rows (§18.1, last rows), not
 *   cases that happen to fall through. Reopening a resolved conversation
 *   because somebody left an internal note would be a silent regression that
 *   no test for "resolve works" would catch.
 * - **A refusal is a value, not an exception.** Snoozing an archived thread is
 *   refused with a reason the API can turn into a typed error and the browser
 *   can render in the operator's words.
 * - **The side effects are named by the table.** "Start a new reporting
 *   episode" is a *consequence of the row*, so it cannot be forgotten by the
 *   one caller that reopens a conversation from an unusual place.
 */

/**
 * The states.
 *
 * `pending` is waiting for the customer; `snoozed` is deliberately hidden until
 * a time or an inbound; `resolved` means the support issue is closed. They are
 * different dimensions from bot/human ownership, from read state and from
 * provider delivery state, and nothing here folds any of those together.
 */
export const CONVERSATION_STATES = ['open', 'pending', 'snoozed', 'resolved', 'archived'] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set<string>(CONVERSATION_STATES);

export function isConversationState(value: unknown): value is ConversationState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/**
 * What can happen to a conversation.
 *
 * Deliberately *causes*, not commands: `customer_inbound` is a fact that
 * arrived, and the table decides what it means from where the conversation
 * already was. An endpoint named `reopen` would let a caller assert an outcome
 * instead of reporting a cause.
 */
export const LIFECYCLE_TRIGGERS = [
  'customer_inbound',
  'agent_waits',
  'agent_snoozes',
  'wake_due',
  'agent_resolves',
  'agent_reopens',
  'agent_archives',
  /** A receipt, a typing indicator, a duplicate, or an internal note. */
  'internal_activity',
] as const;

export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

/**
 * The named consequences of a transition.
 *
 * Each is a thing a caller must actually do. They are returned rather than
 * performed because this module owns no database and no clock — but a caller
 * that ignores one is failing a test, not merely differing in style.
 */
export const LIFECYCLE_EFFECTS = [
  /** Append the message and move this conversation's event cursor. */
  'record_activity',
  /** Begin the first-response clock for a newly waiting customer. */
  'start_response_clock',
  /** Store who waited and why. */
  'record_waiting_reason',
  /** Clear it again, because the customer answered. */
  'clear_waiting_reason',
  /** Persist the UTC wake time, the source timezone, and a fresh job version. */
  'schedule_wake',
  /**
   * Bump the wake version so any wake job already in flight is a no-op.
   * Re-snoozing must invalidate the old job rather than race it.
   */
  'invalidate_wake',
  /** Tell the assigned team, once — not once per event that woke it. */
  'notify_team',
  /** Write the resolution with its disposition. */
  'record_resolution',
  /** Cancel timers that only make sense while the issue is open. */
  'cancel_timers',
  /**
   * Close the current reporting episode and open a new one.
   *
   * The original episode's metrics are retained (CON-04). A reopen that reused
   * the first episode would make every resolution-time report a lie: the second
   * issue's clock would start at the first issue's first message.
   */
  'start_new_episode',
] as const;

export type LifecycleEffect = (typeof LIFECYCLE_EFFECTS)[number];

/** Why a trigger was refused, in terms an API error can carry. */
export type LifecycleRefusal =
  | 'archived_conversation_is_immutable'
  | 'not_waiting_on_a_customer'
  | 'wake_without_snooze'
  | 'already_open'
  | 'not_resolved';

export interface LifecycleOutcome {
  readonly from: ConversationState;
  readonly to: ConversationState;
  /** False when the row says the state does not move. */
  readonly changed: boolean;
  readonly effects: readonly LifecycleEffect[];
  /**
   * Present only when the trigger is refused. `to` then equals `from`, so a
   * caller that forgets to check still cannot corrupt the state — it merely
   * fails to report the refusal.
   */
  readonly refusal: LifecycleRefusal | null;
  /**
   * True when the trigger must create a **new** conversation rather than move
   * this one (§18.1: new inbound after archival). The archived thread keeps its
   * history and is never mutated as if it were active.
   */
  readonly startsNewThread: boolean;
}

interface Row {
  readonly to: ConversationState;
  readonly effects: readonly LifecycleEffect[];
  readonly startsNewThread?: true;
}

type TriggerTable = Partial<Record<ConversationState, Row | LifecycleRefusal>>;

/**
 * §18.1, transcribed.
 *
 * A missing `(trigger, state)` pair is not an oversight — it is the "unchanged"
 * default below, which is what the table's last rows require for receipts,
 * duplicates and notes.
 */
const TABLE: Readonly<Record<LifecycleTrigger, TriggerTable>> = {
  // Rows 2, 4, 6, 8 and 9: what a customer's message means depends entirely on
  // where the conversation was.
  customer_inbound: {
    open: { to: 'open', effects: ['record_activity', 'start_response_clock'] },
    pending: { to: 'open', effects: ['record_activity', 'clear_waiting_reason', 'start_response_clock'] },
    snoozed: {
      to: 'open',
      effects: ['record_activity', 'invalidate_wake', 'notify_team', 'start_response_clock'],
    },
    resolved: {
      to: 'open',
      effects: ['record_activity', 'start_new_episode', 'start_response_clock'],
    },
    // The archived thread is not touched. Its history is preserved and the new
    // message opens a thread of its own.
    archived: { to: 'archived', effects: [], startsNewThread: true },
  },

  // Row 3.
  agent_waits: {
    open: { to: 'pending', effects: ['record_waiting_reason'] },
    pending: 'not_waiting_on_a_customer',
    snoozed: 'not_waiting_on_a_customer',
    resolved: 'not_waiting_on_a_customer',
    archived: 'archived_conversation_is_immutable',
  },

  // Row 5. Re-snoozing an already-snoozed conversation is allowed and must
  // invalidate the wake job already scheduled, or the first one fires early.
  agent_snoozes: {
    open: { to: 'snoozed', effects: ['schedule_wake'] },
    pending: { to: 'snoozed', effects: ['clear_waiting_reason', 'schedule_wake'] },
    snoozed: { to: 'snoozed', effects: ['invalidate_wake', 'schedule_wake'] },
    resolved: { to: 'snoozed', effects: ['schedule_wake'] },
    archived: 'archived_conversation_is_immutable',
  },

  // Row 6, by time rather than by message.
  wake_due: {
    snoozed: { to: 'open', effects: ['invalidate_wake', 'notify_team'] },
    open: 'wake_without_snooze',
    pending: 'wake_without_snooze',
    resolved: 'wake_without_snooze',
    archived: 'archived_conversation_is_immutable',
  },

  // Row 7. `cancel_timers` and the absence of any read effect are both part of
  // the row: resolving must not pretend an unread customer message was read.
  agent_resolves: {
    open: { to: 'resolved', effects: ['record_resolution', 'cancel_timers'] },
    pending: { to: 'resolved', effects: ['clear_waiting_reason', 'record_resolution', 'cancel_timers'] },
    snoozed: { to: 'resolved', effects: ['invalidate_wake', 'record_resolution', 'cancel_timers'] },
    resolved: { to: 'resolved', effects: [] },
    archived: 'archived_conversation_is_immutable',
  },

  // Row 8's other door: an agent may reopen without waiting for the customer.
  // It is the same transition and therefore the same new episode.
  agent_reopens: {
    resolved: { to: 'open', effects: ['start_new_episode'] },
    open: 'already_open',
    pending: 'already_open',
    snoozed: 'already_open',
    archived: 'archived_conversation_is_immutable',
  },

  // Archival is only ever from `resolved`: archiving live work would hide a
  // customer who is still waiting.
  agent_archives: {
    resolved: { to: 'archived', effects: ['cancel_timers'] },
    open: 'not_resolved',
    pending: 'not_resolved',
    snoozed: 'not_resolved',
    archived: 'archived_conversation_is_immutable',
  },

  // The last row of §18.1, stated rather than implied: none of these reopens
  // anything, and none of them is refused either.
  internal_activity: {},
};

/**
 * Decides what a trigger does to a conversation in a given state.
 *
 * Total: every state/trigger pair has an answer, and the answer for a pair the
 * table does not name is "nothing happens" — which is the behaviour §18.1
 * requires for receipts, typing indicators, duplicates and private notes.
 */
export function applyTrigger(
  from: ConversationState,
  trigger: LifecycleTrigger,
): LifecycleOutcome {
  const row = TABLE[trigger][from];
  if (row === undefined) {
    return unchanged(from);
  }
  if (typeof row === 'string') {
    return { from, to: from, changed: false, effects: [], refusal: row, startsNewThread: false };
  }
  return {
    from,
    to: row.to,
    changed: row.to !== from,
    effects: row.effects,
    refusal: null,
    startsNewThread: row.startsNewThread ?? false,
  };
}

function unchanged(from: ConversationState): LifecycleOutcome {
  return { from, to: from, changed: false, effects: [], refusal: null, startsNewThread: false };
}

/**
 * Whether a state counts as *active* for the one-conversation-per-identity rule.
 *
 * §18.1 allows at most one non-archived active conversation per
 * `(tenant, inbox, identity)`. `resolved` is included deliberately: a resolved
 * thread is the one a new inbound reopens, so a second row must not be created
 * beside it. Only archival releases the identity.
 */
export function occupiesIdentity(state: ConversationState): boolean {
  return state !== 'archived';
}

/**
 * The wake time a snooze stores, and the timezone it was chosen in.
 *
 * Both, because they answer different questions. The UTC instant is when the
 * job fires. The IANA zone is what the operator *meant* — "tomorrow morning" is
 * a question about their calendar, and a system that kept only the instant
 * cannot re-derive it after a DST change or explain the choice later (CON-03).
 */
export interface SnoozeRequest {
  readonly wakeAt: Date;
  readonly timezone: string;
}

export type SnoozeRefusal = 'wake_time_in_the_past' | 'wake_time_too_far_ahead' | 'unknown_timezone';

/** A year. Long enough for any real deferral, short enough to catch a bad unit. */
const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Checks a snooze request against the clock the caller passes in.
 *
 * The timezone is validated against the runtime's own IANA database rather than
 * a list we would have to maintain: an unknown zone stored now becomes an
 * unreadable wake time later, and the failure would surface at wake time in a
 * worker rather than here, in front of the person who chose it.
 */
export function checkSnooze(request: SnoozeRequest, now: Date): SnoozeRefusal | null {
  if (!knownTimezone(request.timezone)) {
    return 'unknown_timezone';
  }
  const delta = request.wakeAt.getTime() - now.getTime();
  if (delta <= 0) {
    return 'wake_time_in_the_past';
  }
  if (delta > MAX_SNOOZE_MS) {
    return 'wake_time_too_far_ahead';
  }
  return null;
}

function knownTimezone(zone: string): boolean {
  try {
    // `Intl` throws a RangeError for a zone it does not know, which is exactly
    // the question being asked.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
