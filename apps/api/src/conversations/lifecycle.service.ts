import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type { Pool } from 'pg';
import type {
  ConversationState,
  LifecycleEffect,
  LifecycleOutcome,
  LifecycleRefusal,
  LifecycleTrigger,
  Principal,
  SnoozeRefusal,
  SqlExecutor,
} from '@convo/domain';
import { applyTrigger, authorize, checkSnooze } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { API_POOL } from '../tokens.js';
import {
  denied,
  notFound,
  readDetail,
  recordParticipation,
  resourceOf,
} from './record.js';
import type { ConversationDetail } from './record.js';

/**
 * The lifecycle, enforced.
 *
 * There is exactly **one** way a conversation's state changes: a trigger goes
 * to the domain's table, the table answers, and this service performs the
 * effects the answer names. No endpoint sets `status` directly, which is the
 * only way to keep "resolving does not mark a customer's message read" true
 * six months from now.
 *
 * Every transition is fenced on the version the caller saw, for the same reason
 * a claim is: two agents acting on the same stale card must not both succeed,
 * and the loser is told to re-read rather than silently overwriting the winner.
 */

/** What an agent asks for. The trigger is derived; a caller never names one. */
export type LifecycleCommand =
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'snooze'; readonly wakeAt: Date; readonly timezone: string }
  | { readonly kind: 'resolve'; readonly resolution: string }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'archive' };

const TRIGGER_OF: Readonly<Record<LifecycleCommand['kind'], LifecycleTrigger>> = {
  wait: 'agent_waits',
  snooze: 'agent_snoozes',
  resolve: 'agent_resolves',
  reopen: 'agent_reopens',
  archive: 'agent_archives',
};

/**
 * Which grant each command needs.
 *
 * `conversation.close` covers ending and reopening a thread — both decide
 * whether the company considers the issue done. Waiting and snoozing are part
 * of working the conversation, so they ride on `conversation.reply`: an agent
 * who may answer a customer may also say they are waiting for one.
 */
const PERMISSION_OF: Readonly<Record<LifecycleCommand['kind'], 'conversation.reply' | 'conversation.close'>> = {
  wait: 'conversation.reply',
  snooze: 'conversation.reply',
  resolve: 'conversation.close',
  reopen: 'conversation.close',
  archive: 'conversation.close',
};

/** The refusals, in words an operator can act on. */
const REFUSAL_MESSAGE: Readonly<Record<LifecycleRefusal, string>> = {
  archived_conversation_is_immutable:
    'This conversation is archived. Its history is kept as it was; a new message from the customer opens a new one.',
  not_waiting_on_a_customer: 'This conversation is not open, so there is nobody to wait for.',
  wake_without_snooze: 'This conversation is not snoozed.',
  already_open: 'This conversation is already open.',
  not_resolved: 'Only a resolved conversation can be archived.',
};

const SNOOZE_MESSAGE: Readonly<Record<SnoozeRefusal, string>> = {
  wake_time_in_the_past: 'Choose a time in the future.',
  wake_time_too_far_ahead: 'Choose a time within the next year.',
  unknown_timezone: 'That is not a timezone this server recognises.',
};

export interface EpisodeRow {
  readonly id: string;
  readonly seq: number;
  readonly openedAt: Date;
  readonly openedBy: string;
  readonly firstInboundAt: Date | null;
  readonly firstResponseAt: Date | null;
  readonly closedAt: Date | null;
  readonly resolution: string | null;
}

@Injectable()
export class LifecycleService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /**
   * One sweep across every company with a wake due.
   *
   * The company list comes from the RLS-free job queue; the wake itself is done
   * inside that company's tenant context, so the conversation, its event and its
   * job all move under the same isolation every other write does.
   */
  async sweepDueWakes(now: Date, limit: number): Promise<number> {
    const tenants = await this.tenantsWithWakesDue(asExecutor(this.pool), now);
    let woken = 0;
    for (const tenantId of tenants) {
      woken += await withTenant(this.pool, tenantId, (client) =>
        this.sweepWakes(asExecutor(client), tenantId, now, limit),
      );
    }
    return woken;
  }

  /**
   * Moves a conversation, if the table allows it and the caller may.
   *
   * The order is deliberate: authorize, then ask the table, then check the
   * version. Asking the table first would let an unauthorized caller learn a
   * conversation's state from the shape of the refusal.
   */
  async command(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
    expectedVersion: number,
    command: LifecycleCommand,
  ): Promise<ConversationDetail> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      requirePermission(principal, PERMISSION_OF[command.kind], detail);

      const outcome = applyTrigger(detail.status, TRIGGER_OF[command.kind]);
      if (outcome.refusal !== null) {
        throw new ApiHttpError(409, outcome.refusal, REFUSAL_MESSAGE[outcome.refusal]);
      }
      if (command.kind === 'snooze') {
        const refusal = checkSnooze({ wakeAt: command.wakeAt, timezone: command.timezone }, new Date());
        if (refusal !== null) {
          // Keyed on the refusal union rather than on `string`, so a new
          // refusal in the domain is a compile error here instead of a generic
          // message somebody discovers in production.
          throw new ApiHttpError(422, refusal, SNOOZE_MESSAGE[refusal]);
        }
      }

      const version = await this.write(sql, conversationId, expectedVersion, outcome, command);
      await recordParticipation(sql, tenantId, conversationId, principal.membershipId);
      await this.applyEpisodeEffects(sql, tenantId, conversationId, outcome, command);
      await this.announce(sql, tenantId, detail, outcome, version, principal.membershipId);

      return requireRow(
        [await readDetail(sql, conversationId)].filter(present),
        'the conversation vanished mid-transition',
      );
    });
  }

  /**
   * Applies a customer's message to the lifecycle, inside the inbound
   * transaction.
   *
   * The whole conversation row moves in **one** UPDATE. Splitting it — clearing
   * the wake here, setting the status there — would leave the row momentarily
   * `snoozed` with no wake time, and the CHECK that makes that state
   * unrepresentable is checked at the end of each statement, not at commit.
   */
  async noteCustomerInbound(
    sql: SqlExecutor,
    tenantId: string,
    conversation: { readonly id: string; readonly status: ConversationState },
    inbound: { readonly occurredAt: Date; readonly contactId: string },
  ): Promise<{
    readonly outcome: LifecycleOutcome;
    readonly version: number;
    readonly waitingSince: Date | null;
    readonly status: ConversationState;
  }> {
    const outcome = applyTrigger(conversation.status, 'customer_inbound');
    const sets = [
      'last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2)',
      'last_activity_at = now()',
      `status = $4`,
      // Set only when nobody holds the conversation: a customer writing to an
      // agent who already owns the thread is not a new arrival in the queue.
      `waiting_since = CASE
         WHEN assignee_membership_id IS NULL THEN coalesce(waiting_since, $2)
         ELSE waiting_since
       END`,
      // Attached once and then left alone: re-resolving on every message would
      // let a later identity rotation quietly re-attribute an older thread.
      'contact_id = coalesce(contact_id, $3)',
      'version = version + 1',
    ];
    if (has(outcome, 'invalidate_wake')) {
      sets.push(
        'snoozed_until = NULL',
        'snooze_timezone = NULL',
        'wake_version = wake_version + 1',
      );
    }
    if (has(outcome, 'clear_waiting_reason')) {
      sets.push('pending_reason = NULL', 'pending_since = NULL');
    }
    if (outcome.to === 'open') {
      sets.push('resolution = NULL', 'resolved_at = NULL');
    }

    const updated = await sql.query<{ version: number; waiting_since: Date | null }>(
      `UPDATE conversations SET ${sets.join(', ')}
        WHERE id = $1
        RETURNING version, waiting_since`,
      [conversation.id, inbound.occurredAt, inbound.contactId, outcome.to],
    );
    const row = requireRow(updated.rows, 'the conversation vanished while recording a message');

    if (has(outcome, 'invalidate_wake')) {
      // The customer answered before the wake time. The job is spent.
      await sql.query('DELETE FROM conversation_wakes WHERE conversation_id = $1', [
        conversation.id,
      ]);
    }
    if (has(outcome, 'start_new_episode')) {
      await closeEpisode(sql, conversation.id, null, inbound.occurredAt);
      await openEpisode(sql, tenantId, conversation.id, 'customer_inbound', inbound.occurredAt);
    }
    // The episode's own first inbound, set once: a second message in the same
    // episode must not move the number the first-response report is built from.
    await sql.query(
      `UPDATE conversation_episodes
          SET first_inbound_at = coalesce(first_inbound_at, $2)
        WHERE conversation_id = $1 AND closed_at IS NULL`,
      [conversation.id, inbound.occurredAt],
    );
    return {
      outcome,
      version: row.version,
      waitingSince: row.waiting_since,
      status: outcome.to,
    };
  }

  /**
   * Records the first human reply of the current episode.
   *
   * `coalesce` rather than a conditional write: the first response is the first,
   * and a second reply must not move the number a report is computed from.
   */
  async noteResponse(
    sql: SqlExecutor,
    conversationId: string,
    at: Date,
  ): Promise<void> {
    await sql.query(
      `UPDATE conversation_episodes
          SET first_response_at = coalesce(first_response_at, $2)
        WHERE conversation_id = $1 AND closed_at IS NULL`,
      [conversationId, at],
    );
  }

  /**
   * Opens the first episode of a brand-new conversation.
   *
   * Called by whoever created the conversation row, in the same transaction, so
   * a thread can never exist without an episode to account for it.
   */
  async openFirstEpisode(
    sql: SqlExecutor,
    tenantId: string,
    conversationId: string,
    openedBy: 'customer_inbound' | 'outbound_contact',
    at: Date,
  ): Promise<void> {
    await openEpisode(sql, tenantId, conversationId, openedBy, at);
  }

  /** The episodes of one conversation, oldest first. */
  async episodes(
    session: AuthenticatedSession,
    tenantId: string,
    conversationId: string,
  ): Promise<readonly EpisodeRow[]> {
    this.authorization.assertTenantId(conversationId);
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const detail = await readDetail(sql, conversationId);
      if (detail === null) {
        throw notFound();
      }
      requirePermission(principal, 'conversation.read', detail);
      const rows = await sql.query<{
        id: string;
        seq: number;
        opened_at: Date;
        opened_by: string;
        first_inbound_at: Date | null;
        first_response_at: Date | null;
        closed_at: Date | null;
        resolution: string | null;
      }>(
        `SELECT id::text, seq, opened_at, opened_by, first_inbound_at, first_response_at,
                closed_at, resolution
           FROM conversation_episodes
          WHERE conversation_id = $1
          ORDER BY seq`,
        [conversationId],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        openedAt: row.opened_at,
        openedBy: row.opened_by,
        firstInboundAt: row.first_inbound_at,
        firstResponseAt: row.first_response_at,
        closedAt: row.closed_at,
        resolution: row.resolution,
      }));
    });
  }

  /**
   * The companies with a wake due.
   *
   * Read from the job queue rather than from `conversations`, which is under
   * FORCE RLS: a sweeper has to ask "whose wake is due?" before it has a company
   * to set a context for. Sweeping only the companies that happen to have other
   * traffic is how a snoozed conversation in a quiet company never wakes.
   */
  async tenantsWithWakesDue(sql: SqlExecutor, now: Date, limit = 50): Promise<readonly string[]> {
    const rows = await sql.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id::text FROM conversation_wakes WHERE wake_at <= $1 LIMIT $2`,
      [now, limit],
    );
    return rows.rows.map((row) => row.tenant_id);
  }

  /**
   * Wakes the conversations whose snooze is due, for one company.
   *
   * Runs without a session: it is time passing, not somebody acting. The job's
   * version is compared at update, so a conversation re-snoozed between the
   * select and the write is skipped rather than woken early.
   */
  async sweepWakes(
    sql: SqlExecutor,
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<number> {
    const due = await sql.query<{ conversation_id: string; wake_version: number }>(
      `SELECT conversation_id::text, wake_version
         FROM conversation_wakes
        WHERE tenant_id = $1 AND wake_at <= $2
        ORDER BY wake_at
        LIMIT $3`,
      [tenantId, now, limit],
    );
    let woken = 0;
    for (const job of due.rows) {
      const outcome = applyTrigger('snoozed', 'wake_due');
      const updated = await sql.query<{ version: number }>(
        `UPDATE conversations
            SET status = 'open', snoozed_until = NULL, snooze_timezone = NULL,
                wake_version = wake_version + 1, last_activity_at = now(),
                version = version + 1
          WHERE id = $1 AND wake_version = $2 AND status = 'snoozed'
          RETURNING version`,
        [job.conversation_id, job.wake_version],
      );
      // The job is spent either way. If the fence rejected it, the conversation
      // was re-snoozed, resolved or already woken by a message — all of which
      // wrote their own job or none, and leaving this row would make the sweeper
      // revisit it forever.
      await sql.query(
        `DELETE FROM conversation_wakes WHERE conversation_id = $1 AND wake_version = $2`,
        [job.conversation_id, job.wake_version],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        continue;
      }
      const detail = await readDetail(sql, job.conversation_id);
      if (detail !== null) {
        // No actor: nobody woke it, the time did.
        await this.announce(sql, tenantId, detail, outcome, row.version, null);
      }
      woken += 1;
    }
    return woken;
  }

  /* ----------------------------------------------------------- internals -- */

  private async write(
    sql: SqlExecutor,
    conversationId: string,
    expectedVersion: number,
    outcome: LifecycleOutcome,
    command: LifecycleCommand,
  ): Promise<number> {
    const sets: string[] = ['status = $3', 'last_activity_at = now()', 'version = version + 1'];
    const values: unknown[] = [conversationId, expectedVersion, outcome.to];

    if (has(outcome, 'record_waiting_reason') && command.kind === 'wait') {
      values.push(command.reason);
      sets.push(`pending_reason = $${values.length}`, 'pending_since = now()');
    }
    if (has(outcome, 'clear_waiting_reason')) {
      sets.push('pending_reason = NULL', 'pending_since = NULL');
    }
    if (has(outcome, 'invalidate_wake')) {
      sets.push('wake_version = wake_version + 1');
    }
    if (has(outcome, 'schedule_wake') && command.kind === 'snooze') {
      values.push(command.wakeAt, command.timezone);
      sets.push(
        `snoozed_until = $${values.length - 1}`,
        `snooze_timezone = $${values.length}`,
        // Bumped here too when there was no prior wake to invalidate, so every
        // snooze produces a version no earlier job can match.
        ...(has(outcome, 'invalidate_wake') ? [] : ['wake_version = wake_version + 1']),
      );
    } else {
      sets.push('snoozed_until = NULL', 'snooze_timezone = NULL');
    }
    if (has(outcome, 'record_resolution') && command.kind === 'resolve') {
      values.push(command.resolution);
      sets.push(`resolution = $${values.length}`, 'resolved_at = now()');
    }
    if (outcome.to === 'open') {
      sets.push('resolution = NULL', 'resolved_at = NULL');
    }
    if (outcome.to === 'archived') {
      sets.push('archived_at = now()');
    }

    const updated = await sql.query<{ version: number }>(
      `UPDATE conversations SET ${sets.join(', ')}
        WHERE id = $1 AND version = $2
        RETURNING version`,
      values,
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new ApiHttpError(
        409,
        'conversation_version_conflict',
        'This conversation changed while you were looking at it. Reload it and try again.',
      );
    }
    await this.reschedule(sql, conversationId, outcome, command);
    return row.version;
  }

  /**
   * Writes or clears the durable wake job, in the same transaction as the state
   * it belongs to.
   *
   * The upsert is what makes re-snoozing safe: the row for the earlier time
   * stops existing rather than racing the new one.
   */
  private async reschedule(
    sql: SqlExecutor,
    conversationId: string,
    outcome: LifecycleOutcome,
    command: LifecycleCommand,
  ): Promise<void> {
    if (has(outcome, 'schedule_wake') && command.kind === 'snooze') {
      const current = await sql.query<{ tenant_id: string; wake_version: number }>(
        'SELECT tenant_id::text, wake_version FROM conversations WHERE id = $1',
        [conversationId],
      );
      const row = requireRow(current.rows, 'the conversation vanished while being snoozed');
      await sql.query(
        `INSERT INTO conversation_wakes (conversation_id, tenant_id, wake_at, wake_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id)
         DO UPDATE SET wake_at = EXCLUDED.wake_at, wake_version = EXCLUDED.wake_version,
                       created_at = now()`,
        [conversationId, row.tenant_id, command.wakeAt, row.wake_version],
      );
      return;
    }
    // Any move out of `snoozed` cancels the job. Leaving it would wake a
    // conversation somebody has since resolved.
    await sql.query('DELETE FROM conversation_wakes WHERE conversation_id = $1', [conversationId]);
  }

  private async applyEpisodeEffects(
    sql: SqlExecutor,
    tenantId: string,
    conversationId: string,
    outcome: LifecycleOutcome,
    command: LifecycleCommand,
  ): Promise<void> {
    // `record_resolution` appears in exactly the `agent_resolves` rows, so the
    // command is always a resolve here. Narrowing on the command rather than
    // carrying a `: null` for a case the table cannot produce keeps the two
    // facts in one condition instead of two that could drift apart.
    if (has(outcome, 'record_resolution') && command.kind === 'resolve') {
      await closeEpisode(sql, conversationId, command.resolution, new Date());
    }
    if (has(outcome, 'start_new_episode')) {
      await closeEpisode(sql, conversationId, null, new Date());
      await openEpisode(sql, tenantId, conversationId, 'agent_reopen', new Date());
    }
  }

  /**
   * Puts the transition on the feed.
   *
   * `conversation.state` carries the state and the effects, not a transcript:
   * the authorization terms are the event's own columns, so a subscriber who
   * may only preview learns that a conversation closed without learning what
   * was in it.
   */
  private async announce(
    sql: SqlExecutor,
    tenantId: string,
    detail: ConversationDetail,
    outcome: LifecycleOutcome,
    version: number,
    actorMembershipId: string | null,
  ): Promise<void> {
    await this.realtime.emit(sql, tenantId, {
      type: 'conversation.state',
      entityType: 'conversation',
      entityId: detail.id,
      entityVersion: version,
      conversationId: detail.id,
      connectionId: detail.connectionId,
      teamId: detail.teamId,
      assigneeMembershipId: detail.assigneeMembershipId,
      occurredAt: new Date(),
      payload: {
        status: outcome.to,
        previousStatus: outcome.from,
        priority: detail.priority,
        actorMembershipId,
        // Named so a subscriber can tell a wake from a resolve without
        // re-reading, and so "notify the team once" is a decision the server
        // already made rather than one each client repeats.
        effects: outcome.effects,
        waitingSinceAt: detail.waitingSince?.toISOString() ?? null,
      },
    });
  }
}

function has(outcome: LifecycleOutcome, effect: LifecycleEffect): boolean {
  return outcome.effects.includes(effect);
}

function requirePermission(
  principal: Principal,
  key: 'conversation.read' | 'conversation.reply' | 'conversation.close',
  detail: ConversationDetail,
): void {
  const decision = authorize(principal, key, resourceOf(detail));
  if (!decision.allowed) {
    throw denied();
  }
}

async function openEpisode(
  sql: SqlExecutor,
  tenantId: string,
  conversationId: string,
  openedBy: string,
  at: Date,
): Promise<void> {
  await sql.query(
    `INSERT INTO conversation_episodes
       (tenant_id, conversation_id, seq, opened_at, opened_by)
     SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4
       FROM conversation_episodes WHERE conversation_id = $2`,
    [tenantId, conversationId, at, openedBy],
  );
}

/**
 * Closes whichever episode is open, if one is.
 *
 * `WHERE closed_at IS NULL` rather than naming an id: the caller does not need
 * to know which episode is current, and a caller that thought it knew would be
 * the one to close the wrong one after a concurrent reopen.
 */
async function closeEpisode(
  sql: SqlExecutor,
  conversationId: string,
  resolution: string | null,
  at: Date,
): Promise<void> {
  await sql.query(
    `UPDATE conversation_episodes
        SET closed_at = greatest($3, opened_at), resolution = $2
      WHERE conversation_id = $1 AND closed_at IS NULL`,
    [conversationId, resolution, at],
  );
}


function present(detail: ConversationDetail | null): detail is ConversationDetail {
  return detail !== null;
}
