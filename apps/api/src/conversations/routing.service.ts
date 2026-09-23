import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { Pool } from 'pg';
import type {
  AssignmentAct,
  HandoffAction,
  HandoffRefusal,
  HandoffState,
  HandoffTtlRefusal,
  Principal,
  SqlExecutor,
} from '@convo/domain';
import {
  authorize,
  checkHandoffAction,
  checkHandoffExpiry,
  settledStateOf,
} from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { loadPrincipalForMembership } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { API_POOL } from '../tokens.js';
import { denied, notFound, readDetail, recordParticipation, resourceOf } from './record.js';
import type { ConversationDetail } from './record.js';

/**
 * Who a conversation belongs to, and how it changes hands.
 *
 * Three acts, three permissions, one fence (ADR-0017):
 *
 * - **claim** — taking work nobody holds. Lives in `ConversationService`, where
 *   it always has; it is the only one of the three whose target is always the
 *   caller.
 * - **assign** — putting work on a named desk, agreed or not. `conversation.assign`.
 * - **handoff** — *asking* a named colleague, who may decline.
 *   `conversation.handoff.request`, which an Agent holds at `own` scope so they
 *   can offer their own conversation without being able to reassign anybody
 *   else's.
 *
 * Two rules hold across all of them.
 *
 * **The target is re-checked inside the write.** The assignee directory answers
 * for one instant; between reading it and pressing the button a membership can
 * be revoked, a role changed or an inbox taken away. Every write re-derives the
 * target's principal from the database and asks `authorize` again, so a
 * directory result is a suggestion and never an authorization.
 *
 * **Nothing is taken from anybody without a version.** Every contested write
 * carries the conversation version the operator saw and bumps it exactly once.
 * A stale version is a typed conflict, not a silent takeover — the whole point
 * of the fence is that an operator acting on a screen from a minute ago cannot
 * quietly undo what somebody did in between.
 */

/** What a caller asked to happen to the assignee. */
export type AssignmentCommand =
  | { readonly kind: 'assign'; readonly toMembershipId: string }
  | { readonly kind: 'unassign' };

export interface HandoffRow {
  readonly id: string;
  readonly conversationId: string;
  readonly fromMembershipId: string;
  readonly fromLabel: string;
  readonly toMembershipId: string;
  readonly toLabel: string;
  readonly state: HandoffState;
  readonly note: string | null;
  readonly basedOnVersion: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly settledAt: Date | null;
  readonly settledByMembershipId: string | null;
}

export interface DirectoryEntry {
  readonly membershipId: string;
  readonly label: string;
  /** Whether this person currently holds the conversation. */
  readonly assigned: boolean;
}

export interface CollaboratorRow {
  readonly membershipId: string;
  readonly label: string;
  readonly addedAt: Date;
  /** True when this person actually acted, which no removal can undo. */
  readonly participated: boolean;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type Priority = (typeof PRIORITIES)[number];

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

@Injectable()
export class RoutingService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(API_POOL) private readonly pool: Pool,
  ) {}

  /* ------------------------------------------------------------ assign -- */

  /**
   * Puts a conversation on a named person's desk, or takes it off every desk.
   *
   * The order is deliberate: read the conversation, authorize the *actor*
   * against it, check the fence, re-derive the *target's* eligibility, then
   * write. Authorizing the actor before looking at the target means a caller
   * with no routing authority cannot use this endpoint to discover which
   * membership ids exist.
   */
  async assign(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    expectedVersion: number,
    command: AssignmentCommand,
  ): Promise<ConversationDetail> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireAssignAuthority(principal, detail);

      if (command.kind === 'assign') {
        await requireEligibleTarget(sql, command.toMembershipId, detail);
      }
      const target = command.kind === 'assign' ? command.toMembershipId : null;
      if (target === detail.assigneeMembershipId) {
        // Not an error and not a write: re-pressing a button that already
        // happened must not bump the version and must not produce an audit row
        // claiming the conversation moved.
        return detail;
      }

      await this.moveAssignee(
        sql,
        tenantId,
        detail,
        expectedVersion,
        target,
        principal.membershipId,
        command.kind === 'assign' ? 'assign' : 'unassign',
      );
      return requireConversation(sql, conversationId);
    });
  }

  /**
   * The one place the assignee column changes outside a claim.
   *
   * Everything a move has to do happens here, in the caller's transaction: the
   * fenced update, the human-ownership transition, the participation row, the
   * audit evidence and the event. A caller that did four of the five would
   * leave an assignment nobody can explain.
   */
  private async moveAssignee(
    sql: SqlExecutor,
    tenantId: string,
    detail: ConversationDetail,
    expectedVersion: number,
    toMembershipId: string | null,
    actorMembershipId: string,
    act: AssignmentAct,
  ): Promise<number> {
    const updated = await sql.query<{ version: number; owner_version: number }>(
      `UPDATE conversations
          SET assignee_membership_id = $2,
              waiting_since = CASE WHEN $2::uuid IS NULL THEN now() ELSE NULL END,
              -- Assignment to a person IS the ownership transition (ADR-0008,
              -- as clarified by ADR-0017): the bot resumes only by an explicit
              -- resume or reassignment, so a reassignment has to be one.
              owner_state = CASE WHEN $2::uuid IS NULL THEN owner_state ELSE 'human_active' END,
              owner_version = owner_version + 1,
              last_activity_at = now(),
              version = version + 1
        WHERE id = $1 AND version = $3
        RETURNING version, owner_version`,
      [detail.id, toMembershipId, expectedVersion],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw versionConflict();
    }

    if (toMembershipId !== null) {
      // Being given a conversation is participation: it is how a former
      // assignee keeps permitted read access to what they worked on.
      await recordParticipation(sql, tenantId, detail.id, toMembershipId);
    }
    await recordConversationAudit(sql, tenantId, {
      conversationId: detail.id,
      actorMembershipId,
      act,
      fromValue: detail.assigneeMembershipId,
      toValue: toMembershipId,
      atVersion: row.version,
      // ADR-0008's transition evidence rides on the same row rather than a
      // second one: the ownership moved *because* the assignee did, and two
      // rows for one fact would let an audit reader find one without the other.
      detail: {
        ownerStateFrom: detail.ownerState,
        ownerStateTo: toMembershipId === null ? detail.ownerState : 'human_active',
        ownerVersion: row.owner_version,
      },
    });
    await this.realtime.emit(sql, tenantId, {
      type: 'conversation.assigned',
      entityType: 'conversation',
      entityId: detail.id,
      entityVersion: row.version,
      conversationId: detail.id,
      connectionId: detail.connectionId,
      teamId: detail.teamId,
      assigneeMembershipId: toMembershipId,
      occurredAt: new Date(),
      payload: {
        assigneeMembershipId: toMembershipId,
        previousAssigneeMembershipId: detail.assigneeMembershipId,
        priority: detail.priority,
        status: detail.status,
        waitingSinceAt: null,
        act,
      },
    });
    if (toMembershipId !== null && toMembershipId !== actorMembershipId) {
      await this.notifications.create(sql, tenantId, {
        recipientMembershipId: toMembershipId,
        kind: 'assignment', targetType: 'conversation', targetId: detail.id,
        dedupeKey: `assignment:${detail.id}:${row.version}`,
      });
    }
    return row.version;
  }

  /* --------------------------------------------------------- directory -- */

  /**
   * The people who could actually take this conversation.
   *
   * Not `GET /people`: that requires `member.manage` and returns roles, scopes,
   * statuses and login emails, none of which a Supervisor needs in order to
   * choose an assignee — and `member.manage` is precisely the permission a
   * Supervisor does not have.
   *
   * Eligibility is computed the same way the write computes it, by loading each
   * candidate's principal and asking `authorize`. A list built from a role name
   * or a scope join would eventually disagree with the endpoint that enforces
   * it, and the disagreement would look like a bug in the picker.
   */
  async assignableAgents(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<readonly DirectoryEntry[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      // Whoever may route this conversation may see who can take it. An agent
      // who may only work their own conversation gets the same list, because
      // offering it to a colleague needs the same names.
      requireRoutingReader(principal, detail);

      const candidates = await sql.query<{ membership_id: string; display_name: string }>(
        `SELECT id::text AS membership_id, display_name
           FROM memberships
          WHERE status = 'active'
          ORDER BY display_name, id`,
      );
      const entries: DirectoryEntry[] = [];
      for (const row of candidates.rows) {
        const candidate = await loadPrincipalForMembership(sql, row.membership_id);
        if (candidate === null || !canWork(candidate, detail)) {
          continue;
        }
        entries.push({
          membershipId: row.membership_id,
          label: row.display_name,
          assigned: row.membership_id === detail.assigneeMembershipId,
        });
      }
      return entries;
    });
  }

  /* ----------------------------------------------------------- handoff -- */

  /** Offers the conversation to a named colleague. */
  async requestHandoff(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    input: {
      readonly expectedVersion: number;
      readonly toMembershipId: string;
      readonly note: string | null;
      readonly expiresAt: Date;
    },
  ): Promise<HandoffRow> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      const decision = authorize(principal, 'conversation.handoff.request', resourceOf(detail));
      if (!decision.allowed) {
        throw denied();
      }
      if (detail.version !== input.expectedVersion) {
        // An offer is a routing decision even though it does not immediately
        // move the assignee. Record exactly the version the requester saw, and
        // refuse to make a current offer from a stale screen.
        throw versionConflict();
      }
      if (input.toMembershipId === principal.membershipId) {
        throw new ApiHttpError(
          422,
          'handoff_to_self',
          'A handoff is an offer to somebody else. This one is addressed to you.',
        );
      }
      const refusal = checkHandoffExpiry(input.expiresAt, new Date());
      if (refusal !== null) {
        throw new ApiHttpError(422, refusal, EXPIRY_MESSAGE[refusal]);
      }
      // The recipient has to be able to take it. Offering a conversation to
      // somebody who could never accept produces a request that can only ever
      // expire, and an audit row that says a colleague ignored you.
      await requireEligibleTarget(sql, input.toMembershipId, detail);

      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO conversation_handoffs
           (tenant_id, conversation_id, from_membership_id, to_membership_id, note,
            based_on_version, expires_at, based_on_assignee_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id::text`,
        [
          tenantId,
          conversationId,
          principal.membershipId,
          input.toMembershipId,
          input.note,
          input.expectedVersion,
          input.expiresAt,
          detail.assigneeMembershipId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        // The partial unique index refused it: somebody is already being asked.
        // A second live offer would make "who is being asked" unanswerable.
        throw new ApiHttpError(
          409,
          'handoff_already_pending',
          'Somebody has already been asked to take this conversation.',
        );
      }
      // The schedule, outside RLS, so a sweeper can ask "whose offer is due?"
      // before it has a company to set a context for.
      await sql.query(
        `INSERT INTO conversation_handoff_expiries
           (handoff_id, tenant_id, conversation_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [row.id, tenantId, conversationId, input.expiresAt],
      );
      await recordConversationAudit(sql, tenantId, {
        conversationId,
        actorMembershipId: principal.membershipId,
        act: 'handoff_requested',
        fromValue: principal.membershipId,
        toValue: input.toMembershipId,
        atVersion: input.expectedVersion,
        detail: { handoffId: row.id },
      });
      await this.emitHandoff(sql, tenantId, detail, row.id, 'pending', input.toMembershipId);
      return requireRow(await readHandoffs(sql, { handoffId: row.id }), 'the handoff vanished');
    });
  }

  /**
   * Settles an offer: accept, decline or cancel.
   *
   * One method for the three because they share every check but the last, and
   * three methods would be three places for the fence, the expiry and the
   * identity rule to drift apart. Acceptance additionally applies the
   * reassignment **in the same transaction** — an offer that settled without
   * moving the conversation, or a conversation that moved without settling the
   * offer, are both states nothing could explain afterwards.
   */
  async settleHandoff(
    session: AuthenticatedSession,
    tenantId: string,
    handoffId: string,
    action: Exclude<HandoffAction, 'expire'>,
  ): Promise<HandoffRow> {
    this.authorization.assertTenantId(handoffId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const offer = await lockHandoff(sql, handoffId);
      if (offer === null) {
        throw notFound();
      }
      const detail = await requireConversation(sql, offer.conversationId);
      const mayAssign = authorize(principal, 'conversation.assign', resourceOf(detail)).allowed;
      // Being *named* in the offer is itself the reason to be here. The
      // recipient does not hold the conversation yet — that is the whole point
      // of being asked — so a check that only admitted its current owner would
      // refuse the one person who has to be able to answer.
      const party =
        principal.membershipId === offer.toMembershipId ||
        principal.membershipId === offer.fromMembershipId;
      if (!party && !mayAssign) {
        throw notFound();
      }
      const refusal = checkHandoffAction(
        {
          state: offer.state,
          fromMembershipId: offer.fromMembershipId,
          toMembershipId: offer.toMembershipId,
          expiresAt: offer.expiresAt,
          basedOnAssigneeMembershipId: offer.basedOnAssigneeMembershipId,
          currentAssigneeMembershipId: detail.assigneeMembershipId,
        },
        action,
        { membershipId: principal.membershipId, mayAssign },
        new Date(),
      );
      if (refusal !== null) {
        throw new ApiHttpError(HANDOFF_STATUS[refusal], refusal, HANDOFF_MESSAGE[refusal]);
      }

      if (action === 'accept') {
        // Re-checked here and not only at request time: an offer made last week
        // to somebody who has since lost the inbox must not let them back in.
        await requireEligibleTarget(sql, offer.toMembershipId, detail);
        await this.moveAssignee(
          sql,
          tenantId,
          detail,
          detail.version,
          offer.toMembershipId,
          principal.membershipId,
          'handoff',
        );
      }
      await settle(sql, handoffId, settledStateOf(action), principal.membershipId);
      await recordConversationAudit(sql, tenantId, {
        conversationId: offer.conversationId,
        actorMembershipId: principal.membershipId,
        act: AUDIT_ACT[action],
        fromValue: offer.fromMembershipId,
        toValue: offer.toMembershipId,
        atVersion: detail.version,
        detail: { handoffId },
      });
      await this.emitHandoff(
        sql,
        tenantId,
        detail,
        handoffId,
        settledStateOf(action),
        offer.toMembershipId,
      );
      return requireRow(await readHandoffs(sql, { handoffId }), 'the handoff vanished');
    });
  }

  /** The offers on a conversation, newest first. */
  async listHandoffs(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<readonly HandoffRow[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireRoutingReader(principal, detail);
      return readHandoffs(sql, { conversationId });
    });
  }

  /**
   * Expires every offer whose instant has passed.
   *
   * A stored instant swept durably, because a browser timer that greyed out a
   * button would leave the row `pending` forever and the recipient could still
   * accept it from another tab. Nothing here assigns anything: an offer that
   * ran out is an offer nobody answered.
   */
  async sweepExpiredHandoffs(now: Date, limit: number): Promise<number> {
    const tenants = await asExecutor(this.pool).query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM conversation_handoff_expiries
        WHERE expires_at <= $1 LIMIT $2`,
      [now, limit],
    );
    let expired = 0;
    for (const row of tenants.rows) {
      expired += await withTenant(this.pool, row.tenant_id, async (client) => {
        const sql = asExecutor(client);
        const due = await sql.query<{ handoff_id: string; conversation_id: string }>(
          `SELECT handoff_id::text, conversation_id::text
             FROM conversation_handoff_expiries
            WHERE expires_at <= $1
            ORDER BY expires_at
            LIMIT $2`,
          [now, limit],
        );
        for (const offer of due.rows) {
          // The schedule cascades with the conversation, so a due row always
          // has one — there is no "expired offer on a conversation that is
          // gone" case to reason about.
          const detail = await requireConversation(sql, offer.conversation_id);
          // Nobody caused it and nothing is assigned: an offer that ran out is
          // an offer nobody answered.
          await settle(sql, offer.handoff_id, 'expired', null);
          await recordConversationAudit(sql, row.tenant_id, {
            conversationId: offer.conversation_id,
            actorMembershipId: null,
            act: 'handoff_expired',
            fromValue: null,
            toValue: null,
            atVersion: detail.version,
            detail: { handoffId: offer.handoff_id },
          });
          await this.emitHandoff(sql, row.tenant_id, detail, offer.handoff_id, 'expired', null);
        }
        return due.rows.length;
      });
    }
    return expired;
  }

  private async emitHandoff(
    sql: SqlExecutor,
    tenantId: string,
    detail: ConversationDetail,
    handoffId: string,
    state: HandoffState,
    toMembershipId: string | null,
  ): Promise<void> {
    await this.realtime.emit(sql, tenantId, {
      // Its own type, so a subscriber who may only preview an unclaimed
      // conversation is filtered by the event's type before any payload is
      // read — the same rule that keeps notes off a projected feed.
      type: 'conversation.handoff',
      entityType: 'conversation',
      entityId: detail.id,
      entityVersion: detail.version,
      conversationId: detail.id,
      connectionId: detail.connectionId,
      teamId: detail.teamId,
      assigneeMembershipId: detail.assigneeMembershipId,
      occurredAt: new Date(),
      payload: { handoffId, state, toMembershipId },
    });
    if (state === 'pending' && toMembershipId !== null) {
      await this.notifications.create(sql, tenantId, {
        recipientMembershipId: toMembershipId,
        kind: 'handoff', targetType: 'conversation', targetId: detail.id,
        dedupeKey: `handoff:${handoffId}`,
      });
    }
  }

  /* ---------------------------------------------------------- priority -- */

  /**
   * Changes the queue position this conversation argues for.
   *
   * Governed by `conversation.assign`: business-rules.md §7's row is *"Assign
   * others / **override routing**"*, and priority is routing (ADR-0017). An
   * Agent therefore cannot re-prioritise even their own conversation, which is
   * the matrix's answer rather than this service's opinion.
   */
  async setPriority(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    expectedVersion: number,
    priority: Priority,
    reason: string | null,
  ): Promise<ConversationDetail> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireAssignAuthority(principal, detail);
      if (detail.priority === priority) {
        return detail;
      }

      const updated = await sql.query<{ version: number }>(
        `UPDATE conversations
            SET priority = $2, last_activity_at = now(), version = version + 1
          WHERE id = $1 AND version = $3
          RETURNING version`,
        [conversationId, priority, expectedVersion],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw versionConflict();
      }
      await recordConversationAudit(sql, tenantId, {
        conversationId,
        actorMembershipId: principal.membershipId,
        act: 'priority_changed',
        fromValue: detail.priority,
        toValue: priority,
        atVersion: row.version,
        ...(reason === null ? {} : { detail: { reason } }),
      });
      await this.emitRouting(sql, tenantId, detail, row.version, {
        priority,
        previousPriority: detail.priority,
      });
      return requireConversation(sql, conversationId);
    });
  }

  /* ----------------------------------------------------- collaborators -- */

  /**
   * Invites somebody to help, or ends that invitation.
   *
   * Deliberately **not** a write to `conversation_participants`. That table
   * records who actually acted, is append-only by grant, and must never lose a
   * row: a colleague who replied keeps read access to what they wrote, and
   * erasing it to make a removal look tidy would erase the authorship of real
   * messages. A collaboration is an interval instead — removal closes it, the
   * row stays, and anything the person did still stands on its own.
   */
  async setCollaborator(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    expectedVersion: number,
    membershipId: string,
    present: boolean,
  ): Promise<readonly CollaboratorRow[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireAssignAuthority(principal, detail);
      if (detail.version !== expectedVersion) {
        throw versionConflict();
      }
      if (present) {
        // Adding somebody grants them access, so the target is checked exactly
        // as an assignment target is.
        await requireEligibleTarget(sql, membershipId, detail);
        await sql.query(
          `INSERT INTO conversation_collaborators
             (tenant_id, conversation_id, membership_id, added_by_membership_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [tenantId, conversationId, membershipId, principal.membershipId],
        );
      } else {
        await sql.query(
          `UPDATE conversation_collaborators
              SET removed_at = now(), removed_by_membership_id = $4
            WHERE tenant_id = $1 AND conversation_id = $2 AND membership_id = $3
              AND removed_at IS NULL`,
          [tenantId, conversationId, membershipId, principal.membershipId],
        );
      }
      await recordConversationAudit(sql, tenantId, {
        conversationId,
        actorMembershipId: principal.membershipId,
        act: present ? 'collaborator_added' : 'collaborator_removed',
        fromValue: null,
        toValue: membershipId,
        atVersion: detail.version,
      });
      await this.emitRouting(sql, tenantId, detail, detail.version, {
        collaboratorMembershipId: membershipId,
        present,
      });
      return readCollaborators(sql, conversationId);
    });
  }

  /** The people invited to help, and whether each of them actually acted. */
  async collaborators(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<readonly CollaboratorRow[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await requireConversation(sql, conversationId);
      requireRoutingReader(principal, detail);
      return readCollaborators(sql, conversationId);
    });
  }

  private async emitRouting(
    sql: SqlExecutor,
    tenantId: string,
    detail: ConversationDetail,
    version: number,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.realtime.emit(sql, tenantId, {
      // Priority is on the queue card, so this one is projected rather than
      // hidden — unlike `conversation.handoff`, which is a private negotiation.
      type: 'conversation.routing',
      entityType: 'conversation',
      entityId: detail.id,
      entityVersion: version,
      conversationId: detail.id,
      connectionId: detail.connectionId,
      teamId: detail.teamId,
      assigneeMembershipId: detail.assigneeMembershipId,
      occurredAt: new Date(),
      payload,
    });
  }

}

/* --------------------------------------------------------------- helpers -- */

function versionConflict(): ApiHttpError {
  return new ApiHttpError(
    409,
    'conversation_version_conflict',
    'This conversation was changed by someone else. Reload it and try again.',
  );
}

const HANDOFF_STATUS: Readonly<Record<HandoffRefusal, number>> = {
  handoff_not_pending: 409,
  handoff_expired: 409,
  handoff_superseded: 409,
  not_the_recipient: 403,
  not_the_requester: 403,
};

const HANDOFF_MESSAGE: Readonly<Record<HandoffRefusal, string>> = {
  handoff_not_pending: 'This request has already been answered.',
  handoff_expired: 'This request ran out of time.',
  handoff_superseded:
    'This conversation has moved to somebody else since the request was made.',
  not_the_recipient: 'Only the person who was asked can answer this request.',
  not_the_requester: 'Only the person who made this request can withdraw it.',
};

const EXPIRY_MESSAGE: Readonly<Record<HandoffTtlRefusal, string>> = {
  handoff_expiry_too_soon: 'Give your colleague at least five minutes to answer.',
  handoff_expiry_too_far: 'A request can stand for at most seven days.',
};

const AUDIT_ACT = {
  accept: 'handoff_accepted',
  decline: 'handoff_declined',
  cancel: 'handoff_cancelled',
} as const;

async function requireConversation(
  sql: SqlExecutor,
  conversationId: string,
): Promise<ConversationDetail> {
  const detail = await readDetail(sql, conversationId);
  if (detail === null) {
    throw notFound();
  }
  return detail;
}

/** Routing authority over this conversation, by key and by scope. */
function requireAssignAuthority(principal: Principal, detail: ConversationDetail): void {
  const decision = authorize(principal, 'conversation.assign', resourceOf(detail));
  if (!decision.allowed) {
    throw denied();
  }
}

/**
 * Enough reason to be looking at who holds this conversation.
 *
 * Either routing authority, or the ability to ask for a handoff from it — which
 * an Agent has for their own work. Anything less and the answer is the same
 * `notFound` the rest of the surface gives, so the endpoint reveals nothing
 * about conversations the caller cannot reach.
 */
function requireRoutingReader(principal: Principal, detail: ConversationDetail): void {
  const resource = resourceOf(detail);
  if (
    authorize(principal, 'conversation.assign', resource).allowed ||
    authorize(principal, 'conversation.handoff.request', resource).allowed
  ) {
    return;
  }
  throw denied();
}

/** Whether a candidate principal could actually work this conversation. */
function canWork(candidate: Principal, detail: ConversationDetail): boolean {
  // `conversation.reply` and not `conversation.read`: somebody who may only
  // read a conversation cannot be given it to answer, and an assignee who
  // cannot reply is a conversation nobody is really handling. The `own` terms
  // are satisfied by the assignment itself, so the candidate is measured as if
  // they already held it.
  return authorize(candidate, 'conversation.reply', {
    ...resourceOf(detail),
    assigneeMembershipId: candidate.membershipId,
  }).allowed;
}

/**
 * Re-derives a target's eligibility from the database, inside the write.
 *
 * The refusal is deliberately the same shape for "no such membership", "another
 * tenant's membership" and "a membership that cannot work this conversation":
 * a caller with routing authority may learn that a target is unusable, and must
 * not be able to use the difference between those answers to enumerate the
 * company's memberships.
 */
async function requireEligibleTarget(
  sql: SqlExecutor,
  membershipId: string,
  detail: ConversationDetail,
): Promise<void> {
  if (!UUID.test(membershipId)) {
    throw ineligible();
  }
  const candidate = await loadPrincipalForMembership(sql, membershipId);
  if (candidate === null || !canWork(candidate, detail)) {
    throw ineligible();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ineligible(): ApiHttpError {
  return new ApiHttpError(
    422,
    'assignee_not_eligible',
    'That person cannot work this conversation. Their access may have changed.',
  );
}

export interface ConversationAuditInput {
  readonly conversationId: string;
  readonly actorMembershipId: string | null;
  readonly act: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly atVersion: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Append-only. The runtime role holds no UPDATE and no DELETE on this table. */
export async function recordConversationAudit(
  sql: SqlExecutor,
  tenantId: string,
  input: ConversationAuditInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO conversation_audit
       (tenant_id, conversation_id, actor_membership_id, act, from_value, to_value,
        at_version, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      tenantId,
      input.conversationId,
      input.actorMembershipId,
      input.act,
      input.fromValue,
      input.toValue,
      input.atVersion,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

interface LockedHandoff {
  readonly conversationId: string;
  readonly fromMembershipId: string;
  readonly toMembershipId: string;
  readonly state: HandoffState;
  readonly expiresAt: Date;
  readonly basedOnAssigneeMembershipId: string | null;
}

/**
 * Reads one offer and holds it for the rest of the transaction.
 *
 * `FOR UPDATE`, so two people answering the same offer at the same instant
 * serialize here: the second sees the state the first wrote and is refused
 * `handoff_not_pending` rather than both settling it.
 */
async function lockHandoff(sql: SqlExecutor, handoffId: string): Promise<LockedHandoff | null> {
  const rows = await sql.query<{
    conversation_id: string;
    from_membership_id: string;
    to_membership_id: string;
    state: string;
    expires_at: Date;
    based_on_assignee_membership_id: string | null;
  }>(
    `SELECT conversation_id::text, from_membership_id::text, to_membership_id::text,
            state, expires_at, based_on_assignee_membership_id::text
       FROM conversation_handoffs
      WHERE id = $1
        FOR UPDATE`,
    [handoffId],
  );
  const row = rows.rows[0];
  return row === undefined
    ? null
    : {
        conversationId: row.conversation_id,
        fromMembershipId: row.from_membership_id,
        toMembershipId: row.to_membership_id,
        state: row.state as HandoffState,
        expiresAt: row.expires_at,
        basedOnAssigneeMembershipId: row.based_on_assignee_membership_id,
      };
}

async function settle(
  sql: SqlExecutor,
  handoffId: string,
  state: HandoffState,
  byMembershipId: string | null,
): Promise<void> {
  await sql.query(
    `UPDATE conversation_handoffs
        SET state = $2, settled_at = now(), settled_by_membership_id = $3
      WHERE id = $1 AND state = 'pending'`,
    [handoffId, state, byMembershipId],
  );
  // An answered offer is no longer outstanding, so it leaves the schedule and
  // the sweep stops looking at it.
  await sql.query('DELETE FROM conversation_handoff_expiries WHERE handoff_id = $1', [handoffId]);
}

async function readHandoffs(
  sql: SqlExecutor,
  where: { readonly handoffId?: string; readonly conversationId?: string },
): Promise<readonly HandoffRow[]> {
  const rows = await sql.query<{
    id: string;
    conversation_id: string;
    from_membership_id: string;
    from_label: string;
    to_membership_id: string;
    to_label: string;
    state: string;
    note: string | null;
    based_on_version: number;
    created_at: Date;
    expires_at: Date;
    settled_at: Date | null;
    settled_by_membership_id: string | null;
  }>(
    `SELECT h.id::text, h.conversation_id::text, h.from_membership_id::text,
            f.display_name AS from_label, h.to_membership_id::text,
            t.display_name AS to_label, h.state, h.note, h.based_on_version,
            h.created_at, h.expires_at, h.settled_at, h.settled_by_membership_id::text
       FROM conversation_handoffs h
       JOIN memberships f ON f.id = h.from_membership_id
       JOIN memberships t ON t.id = h.to_membership_id
      WHERE ($1::uuid IS NULL OR h.id = $1)
        AND ($2::uuid IS NULL OR h.conversation_id = $2)
      ORDER BY h.created_at DESC, h.id`,
    [where.handoffId ?? null, where.conversationId ?? null],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    fromMembershipId: row.from_membership_id,
    fromLabel: row.from_label,
    toMembershipId: row.to_membership_id,
    toLabel: row.to_label,
    state: row.state as HandoffState,
    note: row.note,
    basedOnVersion: row.based_on_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    settledByMembershipId: row.settled_by_membership_id,
  }));
}

async function readCollaborators(
  sql: SqlExecutor,
  conversationId: string,
): Promise<readonly CollaboratorRow[]> {
  const rows = await sql.query<{
    membership_id: string;
    display_name: string;
    added_at: Date;
    participated: boolean;
  }>(
    `SELECT c.membership_id::text, m.display_name, c.added_at,
            EXISTS (
              SELECT 1 FROM conversation_participants p
               WHERE p.conversation_id = c.conversation_id
                 AND p.membership_id = c.membership_id
            ) AS participated
       FROM conversation_collaborators c
       JOIN memberships m ON m.id = c.membership_id
      WHERE c.conversation_id = $1 AND c.removed_at IS NULL
      ORDER BY c.added_at, c.membership_id`,
    [conversationId],
  );
  return rows.rows.map((row) => ({
    membershipId: row.membership_id,
    label: row.display_name,
    addedAt: row.added_at,
    participated: row.participated,
  }));
}
