/**
 * Who may see which event, and in what shape.
 *
 * This is the socket half of invariant I3, and it is deliberately built on the
 * *same* `authorize` the HTTP routes use rather than a second copy of the
 * rules. A subscription that authorized differently from the endpoint would be
 * a way around the endpoint.
 *
 * Three outcomes, and the middle one is the point:
 *
 * - `full` — the caller may read this conversation, so the event goes out as
 *   written.
 * - `projected` — the caller holds `conversation.unassigned.preview` and the
 *   conversation is unassigned. They get a **queue card**: an object built from
 *   a closed list of named fields, which never contained a transcript, a note,
 *   an attachment or contact PII (business-rules.md §4.1, IAM-11).
 * - `hidden` — nothing goes out at all. Not an empty event, not an id: a
 *   subscriber must not be able to count another team's conversations.
 *
 * Because the decision is recomputed from the principal on every delivery, a
 * membership that is revoked, suspended, moved to a different role, or removed
 * from an inbox stops receiving events on the next one — which is what
 * "immediate revocation" means for a stream that is already open.
 */

import { authorize } from '../iam/authorize.js';
import type { Principal } from '../iam/authorize.js';
import type { QueueCard, RealtimeEnvelope } from './events.js';

export type Visibility = 'full' | 'projected' | 'hidden';

/**
 * The conversation content this principal may see, given one event's scope.
 *
 * `participantMembershipIds` is passed separately because participation is a
 * property of the conversation, not of the event: an agent who replied once
 * keeps read access after being reassigned, and the event that reassigned them
 * is exactly the one that must still reach them.
 */
export function visibilityOf(
  principal: Principal,
  event: RealtimeEnvelope,
  participantMembershipIds: readonly string[] = [],
): Visibility {
  const resource = {
    inboxId: event.scope.inboxId,
    ...(event.scope.teamId === null ? {} : { teamId: event.scope.teamId }),
    assigneeMembershipId: event.scope.assigneeMembershipId,
    participantMembershipIds,
  };

  if (authorize(principal, 'conversation.read', resource).allowed) {
    return 'full';
  }

  // Neither a private note nor a handoff offer has a projected form. A queue
  // card cannot carry one — it is a closed list of fields and neither is among
  // them — but their *existence* is itself internal: an agent who may only
  // preview an unclaimed conversation has no business learning that colleagues
  // are discussing it, or negotiating who takes it. Filtered by the event's own
  // type, before any payload is read.
  if (event.type === 'conversation.note' || event.type === 'conversation.handoff') {
    return 'hidden';
  }

  // A preview is only ever a preview of something nobody has claimed. Once a
  // conversation has an assignee it is somebody's work, and an agent without
  // `conversation.read` for it has no business knowing it is there.
  if (event.scope.assigneeMembershipId !== null) {
    return 'hidden';
  }

  // Note: previewing an unassigned conversation is scoped by inbox and team,
  // never by ownership — there is no owner yet. `authorize` narrows an `own`
  // grant to nothing here, which is correct: an `own`-level preview grant would
  // be a grant to preview conversations you are already assigned, i.e. nothing.
  const preview = authorize(principal, 'conversation.unassigned.preview', {
    inboxId: event.scope.inboxId,
    ...(event.scope.teamId === null ? {} : { teamId: event.scope.teamId }),
  });
  return preview.allowed ? 'projected' : 'hidden';
}

/**
 * Builds the queue card for an event.
 *
 * Every field is read from a named source and defaulted if it is missing.
 * Nothing is spread, nothing is deleted from a copy: the object that leaves
 * this function is the object that was built here, so a payload field added
 * later cannot appear on it without somebody editing this list.
 */
export function projectQueueCard(event: RealtimeEnvelope): QueueCard {
  const payload = event.payload;
  return {
    id: event.scope.conversationId,
    inboxLabel: stringOr(payload['inboxLabel'], ''),
    channel: stringOr(payload['channel'], 'unknown'),
    maskedLabel: maskIdentity(stringOr(payload['peerIdentity'], '')),
    priority: stringOr(payload['priority'], 'normal'),
    status: stringOr(payload['status'], 'open'),
    waitingSinceAt: typeof payload['waitingSinceAt'] === 'string' ? payload['waitingSinceAt'] : null,
    // Claimable exactly when nobody holds it. The server decides this; a client
    // that believes otherwise still loses the version-checked claim.
    claimable: event.scope.assigneeMembershipId === null,
    // The entity's version at the moment this card was produced — which is what
    // "the version the agent saw" means.
    version: event.entity.version,
  };
}

/**
 * A display label that identifies a conversation to an agent without handing
 * them the customer's contact details.
 *
 * The last three characters are kept because an agent working a queue needs to
 * tell two waiting cards apart, and the rest is replaced rather than truncated
 * so the length of the original is not a hint either. A short identity is
 * masked entirely — there is nothing to keep that would not be most of it.
 */
export function maskIdentity(identity: string): string {
  const trimmed = identity.trim();
  if (trimmed === '') {
    return '';
  }
  const visible = trimmed.length > 6 ? trimmed.slice(-3) : '';
  return '•'.repeat(4) + visible;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}
