import type { ConversationState, OwnerState, Principal, SqlExecutor } from '@convo/domain';
import { authorize, isConversationState, isOwnerState } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';

/**
 * Reading a conversation, and deciding who may.
 *
 * Extracted so that the record, the lifecycle transitions, the notes and the
 * read cursor all reach a conversation through **one** query and **one**
 * authorization decision. Four services each with their own `SELECT` is four
 * chances for one of them to forget a term — and the term most easily forgotten
 * is `participantMembershipIds`, without which an agent's `own` grant is
 * unsatisfiable and an agent who wrote the reply cannot read their own thread.
 */

export interface ConversationRow {
  readonly id: string;
  readonly connectionId: string;
  readonly peerIdentity: string;
  readonly teamId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly status: ConversationState;
  readonly priority: string;
  readonly version: number;
  readonly waitingSince: Date | null;
  readonly contactId: string | null;
  /** Why an agent said they were waiting, when the state is `pending`. */
  readonly pendingReason: string | null;
  readonly snoozedUntil: Date | null;
  /** The IANA zone the wake time was chosen in. Not derivable from the instant. */
  readonly snoozeTimezone: string | null;
  readonly resolution: string | null;
  readonly resolvedAt: Date | null;
  readonly lastActivityAt: Date;
  /**
   * Bot-versus-human ownership (ADR-0008). A different dimension from `status`,
   * from each person's read cursor and from provider delivery state — invariant
   * I12 — and never folded into any of them.
   */
  readonly ownerState: OwnerState;
  /** The fence a future AI result is re-checked against, at submit and at dispatch. */
  readonly ownerVersion: number;
}

export interface RawConversation {
  readonly id: string;
  readonly connection_id: string;
  readonly peer_identity: string;
  readonly team_id: string | null;
  readonly assignee_membership_id: string | null;
  readonly status: string;
  readonly priority: string;
  readonly version: number;
  readonly waiting_since: Date | null;
  readonly contact_id: string | null;
  readonly pending_reason: string | null;
  readonly snoozed_until: Date | null;
  readonly snooze_timezone: string | null;
  readonly resolution: string | null;
  readonly resolved_at: Date | null;
  readonly last_activity_at: Date;
  readonly owner_state: string;
  readonly owner_version: number;
}

export interface ConversationDetail extends ConversationRow {
  readonly inboxLabel: string;
  readonly channel: string;
  readonly participantMembershipIds: readonly string[];
}

export const SELECT_COLUMNS = `id::text, connection_id::text, peer_identity, team_id::text,
                        assignee_membership_id::text, status, priority, version, waiting_since,
                        contact_id::text, pending_reason, snoozed_until, snooze_timezone,
                        resolution, resolved_at, last_activity_at, owner_state, owner_version`;

/** The same columns, qualified, for the joined reads. */
export const DETAIL_COLUMNS = `c.id::text, c.connection_id::text, c.peer_identity, c.team_id::text,
                        c.assignee_membership_id::text, c.status, c.priority, c.version,
                        c.waiting_since, c.contact_id::text, c.pending_reason, c.snoozed_until,
                        c.snooze_timezone, c.resolution, c.resolved_at, c.last_activity_at,
                        c.owner_state, c.owner_version`;

/** The read decision, in one place, so a record and its contents agree. */
export function requireReadable(principal: Principal, detail: ConversationDetail): void {
  const decision = authorize(principal, 'conversation.read', resourceOf(detail));
  if (!decision.allowed) {
    throw denied();
  }
}

/**
 * The authorization terms a conversation carries.
 *
 * Every decision about a conversation — reading it, replying to it, closing it,
 * noting on it — narrows on the same four terms. Building them here means a new
 * action cannot accidentally be decided against fewer of them than an existing
 * one.
 */
export function resourceOf(detail: ConversationDetail): {
  readonly inboxId: string;
  readonly teamId?: string;
  readonly assigneeMembershipId: string | null;
  readonly participantMembershipIds: readonly string[];
} {
  return {
    inboxId: detail.connectionId,
    ...(detail.teamId === null ? {} : { teamId: detail.teamId }),
    assigneeMembershipId: detail.assigneeMembershipId,
    participantMembershipIds: detail.participantMembershipIds,
  };
}

/** The inbox's label and channel, for the card fields on an event. */
export async function inboxOf(
  sql: SqlExecutor,
  connectionId: string,
): Promise<{ readonly display_name: string; readonly kind: string }> {
  const rows = await sql.query<{ display_name: string; kind: string }>(
    'SELECT display_name, kind FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  return requireRow(rows.rows, 'the conversation names a channel that does not exist');
}

export async function readConversation(
  sql: SqlExecutor,
  conversationId: string,
): Promise<ConversationRow | null> {
  const rows = await sql.query<RawConversation>(
    `SELECT ${SELECT_COLUMNS} FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : rowOf(row);
}

export async function readDetail(
  sql: SqlExecutor,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const rows = await sql.query<RawConversation & { display_name: string; kind: string }>(
    `SELECT ${DETAIL_COLUMNS}, n.display_name, n.kind
       FROM conversations c
       JOIN channel_connections n ON n.id = c.connection_id
      WHERE c.id = $1`,
    [conversationId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...rowOf(row),
    inboxLabel: row.display_name,
    channel: row.kind,
    participantMembershipIds: await participantIds(sql, conversationId),
  };
}

/**
 * Everybody an `own` grant reaches on this conversation.
 *
 * The union of two different facts, deliberately read together because
 * `authorize` asks one question:
 *
 * - **participants** are people who actually *acted*. Append-only by grant, and
 *   never removed: a colleague who replied keeps permitted read access to what
 *   they wrote, and erasing that to tidy up a reassignment would erase the
 *   authorship of real messages.
 * - **collaborators** are people who were *invited* and have not necessarily
 *   said anything. That invitation can be withdrawn, so only the live interval
 *   counts — a removed collaborator loses future access, while anything they
 *   did leaves them a participant and keeps what that gives them.
 */
export async function participantIds(
  sql: SqlExecutor,
  conversationId: string,
): Promise<readonly string[]> {
  const rows = await sql.query<{ membership_id: string }>(
    `SELECT membership_id::text FROM conversation_participants WHERE conversation_id = $1
      UNION
     SELECT membership_id::text FROM conversation_collaborators
      WHERE conversation_id = $1 AND removed_at IS NULL`,
    [conversationId],
  );
  return rows.rows.map((row) => row.membership_id);
}

export function rowOf(row: RawConversation): ConversationRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    peerIdentity: row.peer_identity,
    teamId: row.team_id,
    assigneeMembershipId: row.assignee_membership_id,
    status: stateOf(row.status),
    priority: row.priority,
    version: row.version,
    waitingSince: row.waiting_since,
    contactId: row.contact_id,
    pendingReason: row.pending_reason,
    snoozedUntil: row.snoozed_until,
    snoozeTimezone: row.snooze_timezone,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    lastActivityAt: row.last_activity_at,
    ownerState: ownerStateOf(row.owner_state),
    ownerVersion: row.owner_version,
  };
}

/**
 * Narrows the stored ownership state to ADR-0008's vocabulary.
 *
 * The same drift guard `stateOf` is: the column has a CHECK naming exactly
 * these four, so a row that failed this test would mean the schema and the
 * domain had parted company — worth a loud failure rather than a silent cast
 * that would let the send permit reason about a state it has no rule for.
 */
function ownerStateOf(state: string): OwnerState {
  if (!isOwnerState(state)) {
    throw new Error(`a conversation holds the unknown ownership state ${state}`);
  }
  return state;
}

/**
 * Narrows the stored status to the lifecycle's own vocabulary.
 *
 * The column has a CHECK constraint naming exactly these values, so a row that
 * failed this test would mean the schema and the domain had drifted apart —
 * which is worth a loud failure rather than a silent cast.
 */
function stateOf(status: string): ConversationState {
  if (!isConversationState(status)) {
    throw new Error(`a conversation holds the unknown status ${status}`);
  }
  return status;
}

/**
 * Records that this membership has taken part.
 *
 * Participation outlives assignment: an agent reassigned tomorrow keeps read
 * access to what they wrote today. Every act that constitutes taking part —
 * claiming, replying, noting — goes through here, so none of them can create a
 * participant the others would not recognise.
 */
export async function recordParticipation(
  sql: SqlExecutor,
  tenantId: string,
  conversationId: string,
  membershipId: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO conversation_participants (tenant_id, conversation_id, membership_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [tenantId, conversationId, membershipId],
  );
}

export function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}

export function denied(): ApiHttpError {
  return new ApiHttpError(
    403,
    'permission_denied',
    'You do not have permission to perform this action.',
  );
}
