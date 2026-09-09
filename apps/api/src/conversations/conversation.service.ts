import { Inject, Injectable } from '@nestjs/common';
import type { QueueCard, SqlExecutor } from '@convo/domain';
import { authorize, projectQueueCard, REALTIME_SCHEMA_VERSION } from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_POOL } from '../tokens.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/**
 * Conversations: the thing an inbox is a list of.
 *
 * Until now a conversation was an implicit pair — a connection and a peer
 * identity — which was enough to serialize dispatch and not enough to answer
 * "may this person see this?". The columns here are exactly the terms
 * `authorize` narrows on: the inbox, the routing team, the assignee, and who
 * has taken part.
 *
 * Two rules from business-rules.md §4.1 are enforced here rather than described:
 *
 * - **The claim is atomic and version-checked.** Two agents pressing Claim on
 *   the same card at the same moment produce exactly one winner; the loser is
 *   told `conversation_version_conflict` rather than quietly taking the
 *   conversation from the winner.
 * - **Full content requires a claim or participation.** An agent holding only
 *   `conversation.unassigned.preview` gets a queue card and never a transcript,
 *   from the endpoint as well as from the socket.
 */

export interface ConversationRow {
  readonly id: string;
  readonly connectionId: string;
  readonly peerIdentity: string;
  readonly teamId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly status: string;
  readonly priority: string;
  readonly version: number;
  readonly waitingSince: Date | null;
}

interface RawConversation {
  readonly id: string;
  readonly connection_id: string;
  readonly peer_identity: string;
  readonly team_id: string | null;
  readonly assignee_membership_id: string | null;
  readonly status: string;
  readonly priority: string;
  readonly version: number;
  readonly waiting_since: Date | null;
}

export interface ConversationDetail extends ConversationRow {
  readonly inboxLabel: string;
  readonly channel: string;
  readonly participantMembershipIds: readonly string[];
}

const SELECT_COLUMNS = `id::text, connection_id::text, peer_identity, team_id::text,
                        assignee_membership_id::text, status, priority, version, waiting_since`;

@Injectable()
export class ConversationService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /**
   * The conversation for one customer on one inbox, created if this is the
   * first we have heard of them.
   *
   * `ON CONFLICT DO NOTHING` then `SELECT`, rather than `ON CONFLICT DO UPDATE
   * RETURNING`: two workers racing on a first message must both end up with the
   * same row, and neither should bump a version merely by arriving second.
   */
  async ensure(
    sql: SqlExecutor,
    tenantId: string,
    connectionId: string,
    peerIdentity: string,
  ): Promise<ConversationRow> {
    await sql.query(
      `INSERT INTO conversations (tenant_id, connection_id, peer_identity)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, connection_id, peer_identity) DO NOTHING`,
      [tenantId, connectionId, peerIdentity],
    );
    const rows = await sql.query<RawConversation>(
      `SELECT ${SELECT_COLUMNS} FROM conversations
        WHERE connection_id = $1 AND peer_identity = $2`,
      [connectionId, peerIdentity],
    );
    return rowOf(requireRow(rows.rows, 'the conversation vanished after being ensured'));
  }

  /**
   * Records that a customer wrote, and says so on the feed.
   *
   * `waiting_since` is set only when nobody holds the conversation: a customer
   * writing to an agent who already owns the thread is not a new arrival in the
   * unassigned queue, and treating it as one is how a claimed conversation
   * reappears on somebody else's screen.
   */
  async noteInbound(
    sql: SqlExecutor,
    tenantId: string,
    conversation: ConversationRow,
    inbound: { readonly occurredAt: Date; readonly payload: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    const inbox = await inboxOf(sql, conversation.connectionId);
    const updated = await sql.query<{ version: number; waiting_since: Date | null }>(
      `UPDATE conversations
          SET last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2),
              last_activity_at = now(),
              waiting_since = CASE
                WHEN assignee_membership_id IS NULL THEN coalesce(waiting_since, $2)
                ELSE waiting_since
              END,
              status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
              version = version + 1
        WHERE id = $1
        RETURNING version, waiting_since`,
      [conversation.id, inbound.occurredAt],
    );
    const row = requireRow(updated.rows, 'the conversation vanished while recording a message');
    await this.realtime.emit(sql, tenantId, {
      type: 'message.inbound',
      entityType: 'conversation',
      entityId: conversation.id,
      entityVersion: row.version,
      conversationId: conversation.id,
      connectionId: conversation.connectionId,
      teamId: conversation.teamId,
      assigneeMembershipId: conversation.assigneeMembershipId,
      occurredAt: inbound.occurredAt,
      payload: {
        ...inbound.payload,
        // The card fields, alongside whatever the event itself carries. A
        // projected subscriber sees only these; a full one sees both.
        inboxLabel: inbox.display_name,
        channel: inbox.kind,
        peerIdentity: conversation.peerIdentity,
        priority: conversation.priority,
        status: conversation.status,
        waitingSinceAt: row.waiting_since?.toISOString() ?? null,
      },
    });
  }

  /**
   * Says on the feed that a provider receipt moved a message's delivery state.
   *
   * Separate from `message.inbound` because a subscriber watching delivery is
   * not the same as one watching arrivals, and one event type carrying both
   * would force everyone to receive both.
   */
  async noteDelivery(
    sql: SqlExecutor,
    tenantId: string,
    conversation: ConversationRow,
    delivery: {
      readonly messageId: string;
      readonly state: string;
      readonly at: Date;
      readonly anomaly: string | null;
    },
  ): Promise<void> {
    await this.realtime.emit(sql, tenantId, {
      type: 'message.delivery',
      entityType: 'message',
      entityId: delivery.messageId,
      // A message's delivery state is monotonic, so its rank *is* its version:
      // an out-of-order receipt is recognisable without a counter column.
      entityVersion: deliveryRank(delivery.state),
      conversationId: conversation.id,
      connectionId: conversation.connectionId,
      teamId: conversation.teamId,
      assigneeMembershipId: conversation.assigneeMembershipId,
      occurredAt: delivery.at,
      payload: {
        messageId: delivery.messageId,
        deliveryState: delivery.state,
        anomaly: delivery.anomaly,
        priority: conversation.priority,
        status: conversation.status,
      },
    });
  }

  /**
   * The Unassigned queue, projected.
   *
   * The projection happens here, on the server, from the columns — not by
   * selecting a full record and trusting the browser to hide fields. A caller
   * who may read the conversation fully still gets the card from this endpoint;
   * the full timeline is a different request, and getting it requires holding
   * the conversation (IAM-12).
   */
  async unassigned(
    session: AuthenticatedSession,
    tenantId: string,
    connectionId: string | null = null,
  ): Promise<readonly QueueCard[]> {
    return this.authorization.authorized(
      session,
      tenantId,
      'conversation.unassigned.preview',
      async ({ sql, principal }) => {
        const rows = await sql.query<
          RawConversation & { display_name: string; kind: string }
        >(
          `SELECT c.id::text, c.connection_id::text, c.peer_identity, c.team_id::text,
                  c.assignee_membership_id::text, c.status, c.priority, c.version, c.waiting_since,
                  n.display_name, n.kind
             FROM conversations c
             JOIN channel_connections n ON n.id = c.connection_id
            WHERE c.assignee_membership_id IS NULL
              AND c.status = 'open'
              AND ($1::uuid IS NULL OR c.connection_id = $1)
            ORDER BY c.waiting_since NULLS LAST, c.id
            LIMIT 200`,
          [connectionId],
        );
        const cards: QueueCard[] = [];
        for (const row of rows.rows) {
          // Authorized per row, not once for the list: a supervisor scoped to
          // one inbox must not see another inbox's queue because the list route
          // was allowed in general.
          const decision = authorize(principal, 'conversation.unassigned.preview', {
            inboxId: row.connection_id,
            ...(row.team_id === null ? {} : { teamId: row.team_id }),
          });
          if (!decision.allowed) {
            continue;
          }
          cards.push(
            projectQueueCard({
              schemaVersion: REALTIME_SCHEMA_VERSION,
              id: row.id,
              seq: 0,
              type: 'conversation.state',
              entity: { type: 'conversation', id: row.id, version: row.version },
              scope: {
                conversationId: row.id,
                inboxId: row.connection_id,
                teamId: row.team_id,
                assigneeMembershipId: row.assignee_membership_id,
              },
              occurredAt: (row.waiting_since ?? new Date(0)).toISOString(),
              payload: {
                inboxLabel: row.display_name,
                channel: row.kind,
                peerIdentity: row.peer_identity,
                priority: row.priority,
                status: row.status,
                waitingSinceAt: row.waiting_since?.toISOString() ?? null,
              },
            }),
          );
        }
        return cards;
      },
    );
  }

  /**
   * Claims a conversation: atomic, version-checked, exactly one winner.
   *
   * The version the caller saw on the card is the fence. Two agents pressing
   * Claim at the same instant send the same version; the `UPDATE` matches for
   * one of them and matches nothing for the other, who is told so. Without the
   * version, the second write would silently take the conversation away from
   * the agent who is already typing in it (IAM-13).
   */
  async claim(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    expectedVersion: number,
  ): Promise<ConversationDetail> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const existing = await readConversation(sql, conversationId);
      if (existing === null) {
        throw notFound();
      }
      const decision = authorize(principal, 'conversation.claim', {
        inboxId: existing.connectionId,
        ...(existing.teamId === null ? {} : { teamId: existing.teamId }),
        assigneeMembershipId: existing.assigneeMembershipId,
      });
      if (!decision.allowed) {
        throw denied();
      }
      const claimed = await sql.query<{ version: number }>(
        `UPDATE conversations
            SET assignee_membership_id = $2, waiting_since = NULL,
                last_activity_at = now(), version = version + 1
          WHERE id = $1 AND version = $3 AND assignee_membership_id IS NULL
          RETURNING version`,
        [conversationId, principal.membershipId, expectedVersion],
      );
      const row = claimed.rows[0];
      if (row === undefined) {
        // Either somebody else won, or the card the caller acted on is stale.
        // Both are the same answer: re-read and decide again.
        throw new ApiHttpError(
          409,
          'conversation_version_conflict',
          'This conversation was claimed or changed by someone else. Reload it and try again.',
        );
      }
      // Participation outlives assignment: an agent reassigned tomorrow keeps
      // read access to what they wrote today.
      await sql.query(
        `INSERT INTO conversation_participants (tenant_id, conversation_id, membership_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, conversationId, principal.membershipId],
      );
      await this.realtime.emit(sql, tenantId, {
        type: 'conversation.assigned',
        entityType: 'conversation',
        entityId: conversationId,
        entityVersion: row.version,
        conversationId,
        connectionId: existing.connectionId,
        teamId: existing.teamId,
        assigneeMembershipId: principal.membershipId,
        occurredAt: new Date(),
        payload: {
          assigneeMembershipId: principal.membershipId,
          previousAssigneeMembershipId: null,
          priority: existing.priority,
          status: existing.status,
          waitingSinceAt: null,
        },
      });
      return requireRow(
        [await readDetail(sql, conversationId)].filter(present),
        'the conversation vanished after a claim',
      );
    });
  }

  /**
   * The full conversation record.
   *
   * `conversation.read` decides it, with the assignee and the participants as
   * resource terms — so an agent whose grant is `own` is refused before a claim
   * and allowed after one, and refused again the moment their inbox access is
   * taken away (IAM-12).
   */
  async read(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationDetail> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      const decision = authorize(principal, 'conversation.read', {
        inboxId: detail.connectionId,
        ...(detail.teamId === null ? {} : { teamId: detail.teamId }),
        assigneeMembershipId: detail.assigneeMembershipId,
        participantMembershipIds: detail.participantMembershipIds,
      });
      if (!decision.allowed) {
        throw denied();
      }
      return detail;
    });
  }

}

/** The inbox's label and channel, for the card fields on an event. */
async function inboxOf(
  sql: SqlExecutor,
  connectionId: string,
): Promise<{ readonly display_name: string; readonly kind: string }> {
  const rows = await sql.query<{ display_name: string; kind: string }>(
    'SELECT display_name, kind FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  return requireRow(rows.rows, 'the conversation names a channel that does not exist');
}

/**
 * The delivery rank, used as the event's entity version.
 *
 * A receipt only ever moves a message to `delivered` or `read` — `sent` is what
 * the provider's acceptance records, and no receipt reports it — so there are
 * two ranks here rather than three.
 */
function deliveryRank(state: string): number {
  return state === 'read' ? 3 : 2;
}

async function readConversation(
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

async function readDetail(
  sql: SqlExecutor,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const rows = await sql.query<RawConversation & { display_name: string; kind: string }>(
    `SELECT c.id::text, c.connection_id::text, c.peer_identity, c.team_id::text,
            c.assignee_membership_id::text, c.status, c.priority, c.version, c.waiting_since,
            n.display_name, n.kind
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

async function participantIds(
  sql: SqlExecutor,
  conversationId: string,
): Promise<readonly string[]> {
  const rows = await sql.query<{ membership_id: string }>(
    `SELECT membership_id::text FROM conversation_participants WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows.rows.map((row) => row.membership_id);
}

function rowOf(row: RawConversation): ConversationRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    peerIdentity: row.peer_identity,
    teamId: row.team_id,
    assigneeMembershipId: row.assignee_membership_id,
    status: row.status,
    priority: row.priority,
    version: row.version,
    waitingSince: row.waiting_since,
  };
}

function present(detail: ConversationDetail | null): detail is ConversationDetail {
  return detail !== null;
}

function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}

function denied(): ApiHttpError {
  return new ApiHttpError(
    403,
    'permission_denied',
    'You do not have permission to perform this action.',
  );
}
