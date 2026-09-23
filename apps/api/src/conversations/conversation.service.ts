import { Inject, Injectable } from '@nestjs/common';
import type { InboxQuery, QueueCard, ResourceRef, SqlExecutor } from '@convo/domain';
import { authorize, projectQueueCard, reachFor, REALTIME_SCHEMA_VERSION } from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { API_CONFIG, API_POOL } from '../tokens.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { LifecycleService } from './lifecycle.service.js';
import {
  denied,
  DETAIL_COLUMNS,
  inboxOf,
  notFound,
  readConversation,
  readDetail,
  recordParticipation,
  requireReadable,
  rowOf,
  SELECT_COLUMNS,
} from './record.js';
import type { ConversationDetail, ConversationRow, RawConversation } from './record.js';
import { recordConversationAudit } from './routing.service.js';
import {
  readTimeline,
  TIMELINE_PAGE_SIZE,
  timelineBinding,
  timelineCodec,
} from './timeline.js';
import type { TimelinePage } from './timeline.js';
import { MetadataService } from '../metadata/metadata.service.js';
import type { EntityMetadata } from '../metadata/metadata.service.js';
import { OpaqueCursorCodec } from '../pagination.js';
import { compileInboxQuery, readableScope } from './inbox-query-compiler.js';
import { validateInboxQuery } from './inbox-query-validation.js';
import { requireScopedSupervisorAgent, scopedSupervisorAgents } from './supervisor-directory.js';
import { conversationUnrepliedPredicate, latestConversationInbound } from './event-boundary.js';

export type { ConversationDetail, ConversationRow } from './record.js';

/**
 * A conversation as it appears in somebody's list.
 *
 * `unread` is not on `ConversationDetail` because it is not a property of the
 * conversation: it is the answer to "has *this* person seen the newest activity",
 * and putting it on the record would invite a caller to cache it and show one
 * agent another's unread state.
 */
export interface ConversationListRow extends ConversationDetail, EntityMetadata {
  readonly unread: boolean;
}
export interface ConversationListPage { readonly items: readonly ConversationListRow[]; readonly nextCursor: string | null; }
export interface SupervisorAgent { readonly membershipId: string; readonly name: string; readonly email: string; readonly teams: readonly string[]; }
export interface SupervisorWorkload {
  readonly agent: SupervisorAgent;
  readonly current: { readonly assigned: number; readonly open: number; readonly pending: number; readonly snoozed: number; readonly unreplied: number; readonly urgent: number; readonly high: number };
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly byChannel: readonly { readonly channel: string; readonly count: number }[];
}

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

/**
 * How long a timeline page position stays usable.
 *
 * Long enough to read a conversation, short enough that a cursor found in a log
 * a week later is not a working pointer into somebody's messages.
 */
const CURSOR_TTL_SECONDS = 3600;

@Injectable()
export class ConversationService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(MetadataService) private readonly metadata: MetadataService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
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
    openedBy: 'customer_inbound' | 'outbound_contact' = 'customer_inbound',
  ): Promise<ConversationRow> {
    // The conflict target names the index's predicate because the index is
    // partial: an archived thread keeps its row, so the identity it once held
    // is free again and this insert must be allowed to take it (§18.1).
    const inserted = await sql.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, connection_id, peer_identity)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, connection_id, peer_identity) WHERE status <> 'archived'
       DO NOTHING
       RETURNING id::text`,
      [tenantId, connectionId, peerIdentity],
    );
    const created = inserted.rows[0];
    if (created !== undefined) {
      // A thread never exists without an episode to account for it, or the
      // first report to ask "how long did this take" finds nothing to measure.
      await this.lifecycle.openFirstEpisode(sql, tenantId, created.id, openedBy, new Date());
      if (openedBy === 'customer_inbound') {
        // An archived conversation is historical evidence, not an active
        // thread. A response after its archival boundary therefore belongs to
        // this newly created conversation. Every qualifying campaign send is
        // bound once; no campaign delivery can create a conversation itself.
        await sql.query(
          `UPDATE campaign_conversation_attributions attribution
              SET conversation_id=$1,bound_at=now()
            WHERE attribution.tenant_id=$2
              AND attribution.connection_id=$3
              AND attribution.peer_identity=$4
              AND attribution.conversation_id IS NULL
              AND attribution.sent_at <= (SELECT created_at FROM conversations WHERE id=$1)
              AND attribution.sent_at >= COALESCE((
                SELECT max(previous.archived_at) FROM conversations previous
                 WHERE previous.tenant_id=$2 AND previous.connection_id=$3 AND previous.peer_identity=$4
                   AND previous.status='archived' AND previous.id <> $1
              ), '-infinity'::timestamptz)`,
          [created.id, tenantId, connectionId, peerIdentity],
        );
      }
    }
    const rows = await sql.query<RawConversation>(
      `SELECT ${SELECT_COLUMNS} FROM conversations
        WHERE connection_id = $1 AND peer_identity = $2 AND status <> 'archived'`,
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
    inbound: {
      readonly inboundEventId: string;
      readonly occurredAt: Date;
      readonly payload: Readonly<Record<string, unknown>>;
      /**
       * The contact this customer resolved to.
       *
       * Required, not optional: the caller resolves it in the same transaction,
       * and an optional field here would invent a "message from nobody" case
       * that the inbound path cannot produce.
       */
      readonly contactId: string;
    },
  ): Promise<void> {
    const inbox = await inboxOf(sql, conversation.connectionId);
    // The lifecycle decides what the message means. A resolved thread reopens
    // with a new reporting episode, a snoozed one wakes and invalidates its
    // job, a pending one stops waiting — none of which this method should be
    // deciding for itself.
    const row = await this.lifecycle.noteCustomerInbound(sql, tenantId, conversation, {
      occurredAt: inbound.occurredAt,
      contactId: inbound.contactId,
    });
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
        status: row.status,
        previousStatus: row.outcome.from,
        lifecycleEffects: row.outcome.effects,
        waitingSinceAt: row.waitingSince?.toISOString() ?? null,
      },
    });
    if (conversation.assigneeMembershipId !== null) {
      await this.notifications.create(sql, tenantId, {
        recipientMembershipId: conversation.assigneeMembershipId,
        kind: 'new_message',
        targetType: 'conversation',
        targetId: conversation.id,
        dedupeKey: `inbound:${inbound.inboundEventId}`,
      });
    }
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
    filters: {
      readonly connectionId: string | null;
      readonly priority: string | null;
      readonly channel: string | null;
      readonly labelIds: readonly string[];
    },
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
              AND ($2::text IS NULL OR c.priority = $2)
              AND ($3::text IS NULL OR n.kind = $3)
              AND (cardinality($4::uuid[]) = 0 OR (
                SELECT count(DISTINCT cl.label_id) FROM conversation_labels cl
                 WHERE cl.conversation_id = c.id AND cl.removed_at IS NULL
                   AND cl.label_id = ANY($4::uuid[])
              ) = cardinality($4::uuid[]))
            ORDER BY c.waiting_since NULLS LAST, c.id
            LIMIT 200`,
          [filters.connectionId, filters.priority, filters.channel, filters.labelIds],
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
   * The conversations this caller may actually read.
   *
   * A different endpoint from the Unassigned queue on purpose: this one returns
   * **records**, and every row it returns is one the caller passed
   * `conversation.read` for. The queue returns projected cards for
   * conversations nobody holds. Mixing the two into one endpoint with a flag is
   * how a card and a transcript end up one bug apart.
   */
  async list(
    session: AuthenticatedSession,
    tenantId: string,
    query: InboxQuery,
  ): Promise<ConversationListPage> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      if (reachFor(principal, 'conversation.read') === 'none') throw denied();
      const customFields = await validateInboxQuery(sql, query);
      const compiled=compileInboxQuery(query,principal,customFields);
      const params=[...compiled.params]; const add=(value:unknown)=>{params.push(value);return `$${params.length}`;};
      const binding={tenantId,filterHash:compiled.fingerprint,sort:query.sort};const codec=new OpaqueCursorCodec(this.config.secrets.idempotencyHash);
      let cursor='';
      if(query.cursor!==null){const decoded=codec.decode(query.cursor,binding);if(decoded.status==='rejected')throw new ApiHttpError(400,decoded.code,decoded.message);cursor=cursorPredicate(query.sort,decoded.after.value,decoded.after.id,add);}
      const viewer=add(principal.membershipId);const limit=add(query.limit+1);
      const rows = await sql.query<
        RawConversation & { display_name: string; kind: string; read_through: Date | null; cursor_value:string; participant_membership_ids: readonly string[] }
      >(
        // The read cursor is joined for THIS membership only. Unread is a fact
        // about a person, so a row's unread flag is not a property of the row —
        // two agents looking at the same list see different answers, correctly.
        `SELECT ${DETAIL_COLUMNS}, n.display_name, n.kind, r.read_through, ${cursorValue(query.sort)} AS cursor_value,
                ARRAY(SELECT participant.membership_id::text FROM conversation_participants participant WHERE participant.conversation_id = c.id
                      UNION
                      SELECT collaborator.membership_id::text FROM conversation_collaborators collaborator WHERE collaborator.conversation_id = c.id AND collaborator.removed_at IS NULL) AS participant_membership_ids
           FROM conversations c
           JOIN channel_connections n ON n.id = c.connection_id
           LEFT JOIN conversation_reads r
             ON r.conversation_id = c.id AND r.membership_id = ${viewer}
          WHERE ${compiled.where}${cursor}
          ORDER BY ${compiled.order}
          LIMIT ${limit}`,
        params,
      );
      const pageRows=rows.rows.slice(0,query.limit);const items: ConversationListRow[] = [];
      // Metadata is a page concern, not a row concern. The batch has a fixed
      // two-query cost (labels and fields) for a 50-row Inbox page.
      const metadata = await this.metadata.conversationMetadataBatch(sql, pageRows.map((row) => row.id));
      for (const row of pageRows) {
        const participants = row.participant_membership_ids;
        // This is an equivalence guard, not a post-page filter. The SQL scope
        // above has already applied the exact same terms before LIMIT; a drift
        // must fail closed instead of returning a shortened, misleading page.
        const decision = authorize(principal, 'conversation.read', {
          inboxId: row.connection_id,
          ...(row.team_id === null ? {} : { teamId: row.team_id }),
          assigneeMembershipId: row.assignee_membership_id,
          participantMembershipIds: participants,
        });
        if (!decision.allowed) throw new Error('Inbox SQL authorization scope disagreed with domain authorization.');
        items.push({
          ...rowOf(row),
          inboxLabel: row.display_name,
          channel: row.kind,
          participantMembershipIds: participants,
          unread:
            row.read_through === null ||
            row.read_through.getTime() < row.last_activity_at.getTime(),
          ...(metadata.get(row.id) ?? { labels: [], customFields: [] }),
        });
      }
      const last=pageRows.at(-1);return{items,nextCursor:rows.rows.length>query.limit&&last!==undefined?codec.encode(binding,{value:last.cursor_value,id:last.id},900):null};
    });
  }

  /**
   * Read-only supervisor lens. It never changes the principal or masquerades
   * as the selected member: the ordinary Inbox query is still compiled with
   * the supervisor's own scopes, then additionally limited to the agent.
   */
  async supervisorList(session: AuthenticatedSession, tenantId: string, agentMembershipId: string, query: InboxQuery): Promise<ConversationListPage> {
    await this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => requireScopedSupervisorAgent(sql, principal, agentMembershipId));
    return this.list(session, tenantId, { ...query, queue: 'all', filters: [...query.filters, { key: 'assigned_agent_id', operator: 'eq', value: agentMembershipId }] });
  }

  /** Current workload for a selected visible agent, constrained by the supervisor's scope. */
  async supervisorWorkload(session: AuthenticatedSession, tenantId: string, agentMembershipId: string): Promise<SupervisorWorkload> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const agent = await requireScopedSupervisorAgent(sql, principal, agentMembershipId);
      const values: unknown[] = [agentMembershipId];
      const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
      const scope = readableScope(principal, add);
      const result = await sql.query<{ workload: Omit<SupervisorWorkload, 'agent'> }>(`
        WITH current_scope AS (
          SELECT c.id,c.tenant_id,c.connection_id,c.peer_identity,c.created_at,c.archived_at,c.status,c.priority,n.kind,
                 ${conversationUnrepliedPredicate('c')} AS unreplied
            FROM conversations c JOIN channel_connections n ON n.id=c.connection_id
           -- Workload is a live operating queue. Resolved and archived records
           -- remain reportable history but must never inflate an agent's live
           -- assignment, unreplied, priority or channel counts.
           WHERE c.assignee_membership_id=$1::uuid AND c.status IN ('open','pending','snoozed') AND ${scope}
        ), counts AS (
          SELECT count(*)::int AS assigned,
                 count(*) FILTER (WHERE status='open')::int AS open,
                 count(*) FILTER (WHERE status='pending')::int AS pending,
                 count(*) FILTER (WHERE status='snoozed')::int AS snoozed,
                 count(*) FILTER (WHERE priority='urgent')::int AS urgent,
                 count(*) FILTER (WHERE priority='high')::int AS high,
                 count(*) FILTER (WHERE unreplied)::int AS unreplied
            FROM current_scope
        )
        SELECT jsonb_build_object(
          'current',jsonb_build_object('assigned',assigned,'open',open,'pending',pending,'snoozed',snoozed,'unreplied',unreplied,'urgent',urgent,'high',high),
          'byStatus',coalesce((SELECT jsonb_agg(jsonb_build_object('status',status,'count',count) ORDER BY status) FROM (SELECT status,count(*)::int AS count FROM current_scope GROUP BY status) x),'[]'::jsonb),
          'byChannel',coalesce((SELECT jsonb_agg(jsonb_build_object('channel',kind,'count',count) ORDER BY kind) FROM (SELECT kind,count(*)::int AS count FROM current_scope GROUP BY kind) x),'[]'::jsonb)
        ) AS workload FROM counts`, values,
      );
      const workload = result.rows[0]?.workload;
      if (workload === undefined) throw new Error('supervisor workload returned no row');
      return { agent, ...workload };
    });
  }

  /**
   * Returns the active agents this supervisor may inspect, including zero-work
   * agents. A current visible assignment is one defensible relationship, but
   * not the only one: a scoped lead may also inspect an active member who is
   * explicitly in one of the lead's teams or Inbox scopes. We never substitute
   * the selected person's permissions for the supervisor's own authorization.
   */
  async supervisorAgents(session: AuthenticatedSession, tenantId: string): Promise<readonly SupervisorAgent[]> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => scopedSupervisorAgents(sql, principal));
  }

  /**
   * One page of a conversation's messages, newest page first.
   *
   * Authorized exactly like reading the conversation itself, because that is
   * what it is: an agent who may not read the record may not read its contents
   * either, and the two decisions must not be able to disagree.
   */
  async timeline(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    cursor: string | null,
  ): Promise<TimelinePage> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      requireReadable(principal, detail);

      const codec = timelineCodec(this.config.secrets.idempotencyHash);
      const binding = timelineBinding(tenantId, conversationId);
      let after: { at: string; id: string } | null = null;
      if (cursor !== null) {
        const decoded = codec.decode(cursor, binding);
        if (decoded.status === 'rejected') {
          // A page position that no longer works is a typed answer with a safe
          // next step, not a silent jump back to the top of the conversation.
          throw new ApiHttpError(400, decoded.code, decoded.message);
        }
        after = { at: decoded.after.value, id: decoded.after.id };
      }

      const page = await readTimeline(
        sql,
        detail.connectionId,
        detail.peerIdentity,
        after,
        TIMELINE_PAGE_SIZE,
      );
      const oldest = page.rows[0];
      return {
        messages: page.rows,
        nextCursor:
          page.hasMore && oldest !== undefined
            ? codec.encode(binding, { value: oldest.at, id: oldest.id }, CURSOR_TTL_SECONDS)
            : null,
      };
    });
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
  ): Promise<ConversationDetail & EntityMetadata> {
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
      const claimed = await sql.query<{ version: number; owner_version: number }>(
        `UPDATE conversations
            SET assignee_membership_id = $2, waiting_since = NULL,
                owner_state = 'human_active', owner_version = owner_version + 1,
                last_activity_at = now(), version = version + 1
          WHERE id = $1 AND version = $3 AND assignee_membership_id IS NULL
          RETURNING version, owner_version`,
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
      await recordParticipation(sql, tenantId, conversationId, principal.membershipId);
      await recordConversationAudit(sql, tenantId, {
        conversationId,
        actorMembershipId: principal.membershipId,
        act: 'claim',
        fromValue: null,
        toValue: principal.membershipId,
        atVersion: row.version,
        detail: {
          ownerStateFrom: existing.ownerState,
          ownerStateTo: 'human_active',
          ownerVersion: row.owner_version,
        },
      });
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
      const detail = requireRow(
        [await readDetail(sql, conversationId)].filter(present),
        'the conversation vanished after a claim',
      );
      return { ...detail, ...(await this.metadata.conversationMetadata(sql, conversationId)) };
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
  ): Promise<ConversationDetail & EntityMetadata> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      requireReadable(principal, detail);
      const serviceWindow = detail.channel !== 'whatsapp'
        ? { status: 'not_applicable' as const, lastCustomerInboundAt: null, serviceWindowExpiresAt: null }
        : await readWhatsAppWindow(sql, conversationId);
      return { ...detail, serviceWindow, ...(await this.metadata.conversationMetadata(sql, conversationId)) };
    });
  }

  /**
   * The connection and recipient a reply to this conversation goes to.
   *
   * The caller names a *conversation*; the channel and the customer identity
   * come from the record. An agent replying must not be able to redirect a
   * message to another recipient by editing a field, which is exactly what
   * taking `peerIdentity` from the request body here would allow.
   */
  async replyTarget(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<{
    readonly connectionId: string;
    readonly peerIdentity: string;
    readonly resource: ResourceRef;
  }> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      const resource: ResourceRef = {
        inboxId: detail.connectionId,
        ...(detail.teamId === null ? {} : { teamId: detail.teamId }),
        assigneeMembershipId: detail.assigneeMembershipId,
        participantMembershipIds: detail.participantMembershipIds,
      };
      const decision = authorize(principal, 'conversation.reply', resource);
      if (!decision.allowed) {
        throw denied();
      }
      // The same terms are handed to the send path, so the two decisions cannot
      // disagree: an Agent's `own` grant means nothing without them.
      return { connectionId: detail.connectionId, peerIdentity: detail.peerIdentity, resource };
    });
  }
}

function cursorValue(sort: InboxQuery['sort']): string {
  if (sort === 'created_desc' || sort === 'created_asc') return 'c.created_at::text';
  if (sort === 'waiting_desc') return "coalesce(c.waiting_since,'-infinity'::timestamptz)::text";
  if (sort === 'priority_desc') return "(CASE c.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END)::text";
  return 'c.last_activity_at::text';
}

function cursorPredicate(sort: InboxQuery['sort'], value: string, id: string, add: (value: unknown) => string): string {
  const v=add(value);const i=add(id);
  if(sort==='created_desc')return ` AND (c.created_at, c.id)<(${v}::timestamptz,${i}::uuid)`;
  if(sort==='created_asc')return ` AND (c.created_at, c.id)>(${v}::timestamptz,${i}::uuid)`;
  if(sort==='waiting_desc')return ` AND (coalesce(c.waiting_since,'-infinity'::timestamptz),c.id)<(${v}::timestamptz,${i}::uuid)`;
  if(sort==='priority_desc')return ` AND ((CASE c.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END),c.id)<(${v}::integer,${i}::uuid)`;
  if(sort==='activity_asc')return ` AND (c.last_activity_at,c.id)>(${v}::timestamptz,${i}::uuid)`;
  return ` AND (c.last_activity_at,c.id)<(${v}::timestamptz,${i}::uuid)`;
}

async function readWhatsAppWindow(
  sql: SqlExecutor,
  conversationId: string,
): Promise<{ readonly status: 'open' | 'closed' | 'unknown'; readonly lastCustomerInboundAt: string | null; readonly serviceWindowExpiresAt: string | null }> {
  const evidence = await latestConversationInbound(sql, conversationId);
  if (evidence.lastInboundAt === null) {
    return { status: 'closed', lastCustomerInboundAt: null, serviceWindowExpiresAt: null };
  }
  const expiry = new Date(evidence.lastInboundAt.getTime() + 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiry.getTime()) || !Number.isFinite(evidence.serverNow.getTime())) {
    return { status: 'unknown', lastCustomerInboundAt: null, serviceWindowExpiresAt: null };
  }
  return {
    status: expiry.getTime() > evidence.serverNow.getTime() ? 'open' : 'closed',
    lastCustomerInboundAt: evidence.lastInboundAt.toISOString(),
    serviceWindowExpiresAt: expiry.toISOString(),
  };
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





function present(detail: ConversationDetail | null): detail is ConversationDetail {
  return detail !== null;
}
