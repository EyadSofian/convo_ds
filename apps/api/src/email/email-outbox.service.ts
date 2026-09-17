import { Inject, Injectable } from '@nestjs/common';
import { asExecutor } from '@convo/database';
import {
  renderInvitationEmail,
  renderRecoveryEmail,
  type EmailLocale,
  type RenderedEmail,
  type SqlExecutor,
} from '@convo/domain';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, API_POOL, EMAIL_PROVIDER } from '../tokens.js';
import type { EmailProviderPort, EmailSendOutcome } from './email-provider.port.js';

/**
 * The durable email outbox.
 *
 * `enqueue` is called inside the request that mints a token and does one INSERT.
 * `drain` is called by a worker and is the only thing in this product that talks
 * to an email provider. Nothing else about either half is interesting, and that
 * is the point: the interesting behaviour is all in the ordering.
 *
 * Why the claim commits before the send:
 *
 * A worker that dies between "provider accepted" and "row updated" must not
 * lose the delivery, and must not resend it forever. Incrementing
 * `attempt_count` and taking a lease in a committed transaction *before* the
 * HTTP call gives both: the attempt is on the record even if this process never
 * speaks again, and when the lease expires another worker picks the row up with
 * the count already advanced, so a row that kills workers exhausts its attempts
 * and fails rather than cycling.
 *
 * Why a duplicate is acceptable here and not on the message path:
 *
 * An outbound WhatsApp message that may or may not have been sent is never
 * automatically retried, because a duplicate reaches a customer. An invitation
 * that may or may not have been sent *is* retried, because a duplicate reaches
 * a colleague's inbox twice and a lost one leaves a person unable to join. The
 * provider's `Idempotency-Key` closes most of that window anyway.
 */

export type EmailKind = 'invitation' | 'password_recovery';

export interface InvitationEnqueue {
  readonly kind: 'invitation';
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly email: string;
  readonly locale: EmailLocale;
  readonly workspaceName: string;
  readonly roleName: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface RecoveryEnqueue {
  readonly kind: 'password_recovery';
  readonly idempotencyKey: string;
  readonly email: string;
  readonly locale: EmailLocale;
  readonly token: string;
  readonly expiresAt: Date;
}

export type EmailEnqueue = InvitationEnqueue | RecoveryEnqueue;

export interface DrainResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly retried: number;
}

export interface EmailBacklog {
  readonly pending: number;
  readonly failed: number;
  /** Age in seconds of the oldest delivery still waiting. Null when none is. */
  readonly oldestPendingAgeSeconds: number | null;
}

interface ClaimRow {
  readonly id: string;
  readonly kind: EmailKind;
  readonly recipient_email: string;
  readonly locale: EmailLocale;
  readonly payload: Record<string, unknown>;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

/** How long one claim is held. Generous next to a 10s provider timeout. */
const LEASE_SECONDS = 120;
/** Base for exponential backoff, in seconds: 30s, 1m, 2m, 4m, 8m. */
const BACKOFF_BASE_SECONDS = 30;
/** Ceiling, so a long outage does not push a delivery a day into the future. */
const BACKOFF_MAX_SECONDS = 3600;

@Injectable()
export class EmailOutboxService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProviderPort,
  ) {}

  /**
   * Queues one email. One INSERT, no network, no rendering.
   *
   * Rendering is deferred to the worker on purpose: the copy and the public base
   * URL can both change between queueing and sending, and the version that goes
   * out should be the current one. It also keeps this call cheap enough to sit
   * inside an IAM transaction without widening it.
   *
   * `ON CONFLICT DO NOTHING` makes a retried request one email. The returned id
   * is the existing row's when that happens, so a caller always learns which
   * delivery its request corresponds to.
   */
  enqueue(message: EmailEnqueue): Promise<string> {
    return enqueueEmail(asExecutor(this.pool), message);
  }

  /**
   * Sends up to `limit` queued emails.
   *
   * Sequential rather than concurrent. The whole volume of this queue is
   * invitations and password resets — tens per day for a school, not thousands
   * per second — and a sequential drain cannot exhaust the connection pool or
   * trip a provider rate limit, which are the two ways this worker could hurt
   * something that matters more than it does.
   */
  async drain(limit = 20, workerId = 'worker-integration'): Promise<DrainResult> {
    const result = { claimed: 0, sent: 0, failed: 0, retried: 0 };
    for (let index = 0; index < limit; index += 1) {
      const claim = await this.claim(workerId);
      if (claim === null) {
        break;
      }
      result.claimed += 1;
      const outcome = await this.send(claim);
      const settled = await this.record(claim, outcome);
      if (settled === 'sent') result.sent += 1;
      else if (settled === 'failed') result.failed += 1;
      else result.retried += 1;
    }
    return result;
  }

  /** What an operator needs to see on a dashboard, in one query. */
  async backlog(): Promise<EmailBacklog> {
    const rows = await this.pool.query<{
      pending: string;
      failed: string;
      oldest_age: string | null;
    }>(
      `SELECT count(*) FILTER (WHERE state = 'pending')::text AS pending,
              count(*) FILTER (WHERE state = 'failed')::text AS failed,
              extract(epoch FROM now() - min(created_at) FILTER (WHERE state = 'pending'))::text
                AS oldest_age
         FROM email_deliveries`,
    );
    const row = rows.rows[0];
    /* c8 ignore next 3 -- an aggregate always returns one row */
    if (row === undefined) {
      return { pending: 0, failed: 0, oldestPendingAgeSeconds: null };
    }
    return {
      pending: Number(row.pending),
      failed: Number(row.failed),
      oldestPendingAgeSeconds: row.oldest_age === null ? null : Math.floor(Number(row.oldest_age)),
    };
  }

  /**
   * Claims one delivery, and commits the claim.
   *
   * `SKIP LOCKED` so two workers never wait on each other, and the attempt
   * count advances here rather than after the send — see the class comment.
   */
  private async claim(workerId: string): Promise<ClaimRow | null> {
    const claimed = await this.pool.query<ClaimRow>(
      `UPDATE email_deliveries
          SET attempt_count = attempt_count + 1,
              lease_until = now() + make_interval(secs => $2),
              leased_by = $1
        WHERE id = (
          SELECT id FROM email_deliveries
           WHERE state = 'pending'
             AND next_attempt_at <= now()
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY next_attempt_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING id::text, kind, recipient_email::text, locale, payload,
                attempt_count, max_attempts`,
      [workerId, LEASE_SECONDS],
    );
    return claimed.rows[0] ?? null;
  }

  private async send(claim: ClaimRow): Promise<EmailSendOutcome> {
    let rendered: RenderedEmail;
    try {
      rendered = this.render(claim);
    } catch (error) {
      // A payload the renderer cannot use is not going to become usable. It is
      // refused permanently with a code that names the row, not retried.
      return {
        status: 'refused',
        code: 'payload_unrenderable',
        /* c8 ignore next -- `render` only ever throws Error */
        message: error instanceof Error ? error.message : 'The stored payload could not be rendered.',
        retryable: false,
      };
    }
    return this.provider.send({
      to: claim.recipient_email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: claim.id,
    });
  }

  private render(claim: ClaimRow): RenderedEmail {
    const payload = claim.payload;
    const token = text(payload, 'token');
    const expiresAt = new Date(text(payload, 'expiresAt'));
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('The stored expiry is not a date.');
    }
    if (claim.kind === 'password_recovery') {
      return renderRecoveryEmail({
        locale: claim.locale,
        publicBaseUrl: this.config.publicBaseUrl,
        installationName: this.config.installationName,
        token,
        expiresAt,
      });
    }
    return renderInvitationEmail({
      locale: claim.locale,
      publicBaseUrl: this.config.publicBaseUrl,
      installationName: this.config.installationName,
      workspaceName: text(payload, 'workspaceName'),
      roleName: text(payload, 'roleName'),
      token,
      expiresAt,
    });
  }

  /**
   * Records the answer and decides what happens next.
   *
   * Every terminal write scrubs the payload in the same statement that sets the
   * state, so there is no window in which a row is `sent` and still holding a
   * live token. The table's CHECK constraint enforces that from below.
   */
  private async record(claim: ClaimRow, outcome: EmailSendOutcome): Promise<'sent' | 'failed' | 'retry'> {
    if (outcome.status === 'accepted') {
      await this.pool.query(
        `UPDATE email_deliveries
            SET state = 'sent', sent_at = now(), provider_message_id = $2, provider = $3,
                lease_until = NULL, leased_by = NULL,
                payload = '{}'::jsonb, payload_scrubbed_at = now()
          WHERE id = $1`,
        [claim.id, outcome.providerMessageId, this.provider.name],
      );
      return 'sent';
    }

    const retryable = outcome.status === 'unknown' || outcome.retryable;
    const exhausted = claim.attempt_count >= claim.max_attempts;

    if (!retryable || exhausted) {
      await this.pool.query(
        `UPDATE email_deliveries
            SET state = 'failed', failed_at = now(), provider = $4,
                last_error_code = $2, last_error_message = $3, last_error_at = now(),
                lease_until = NULL, leased_by = NULL,
                payload = '{}'::jsonb, payload_scrubbed_at = now()
          WHERE id = $1`,
        [claim.id, exhausted && retryable ? `attempts_exhausted:${outcome.code}` : outcome.code, outcome.message, this.provider.name],
      );
      return 'failed';
    }

    await this.pool.query(
      `UPDATE email_deliveries
          SET next_attempt_at = now() + make_interval(secs => $4),
              last_error_code = $2, last_error_message = $3, last_error_at = now(),
              provider = $5, lease_until = NULL, leased_by = NULL
        WHERE id = $1`,
      [claim.id, outcome.code, outcome.message, backoffSeconds(claim.attempt_count), this.provider.name],
    );
    return 'retry';
  }
}

/**
 * Queues one email on the caller's executor.
 *
 * A free function rather than a method because the callers that matter most —
 * invitation creation and recovery start — are already inside a transaction and
 * must write through *that* executor, not through a second connection. Using the
 * pool here would defeat the entire point: the email row could commit while the
 * invitation rolled back.
 *
 * `ON CONFLICT DO NOTHING` makes a retried request one email. The returned id is
 * the existing row's when that happens, so a caller always learns which delivery
 * its request corresponds to.
 */
export async function enqueueEmail(sql: SqlExecutor, message: EmailEnqueue): Promise<string> {
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO email_deliveries (tenant_id, kind, idempotency_key, recipient_email, locale, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (kind, idempotency_key) DO NOTHING
     RETURNING id::text`,
    [
      message.kind === 'invitation' ? message.tenantId : null,
      message.kind,
      message.idempotencyKey,
      message.email,
      message.locale,
      JSON.stringify(payloadOf(message)),
    ],
  );
  const created = inserted.rows[0];
  if (created !== undefined) {
    return created.id;
  }
  const existing = await sql.query<{ id: string }>(
    'SELECT id::text FROM email_deliveries WHERE kind = $1 AND idempotency_key = $2',
    [message.kind, message.idempotencyKey],
  );
  const row = existing.rows[0];
  /* c8 ignore next 3 -- the conflict proves the row is there */
  if (row === undefined) {
    throw new Error('email delivery conflicted with a row that does not exist');
  }
  return row.id;
}

/** 30s, 1m, 2m, 4m, 8m, … capped at an hour. */
export function backoffSeconds(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.min(exponent, 20));
}

function payloadOf(message: EmailEnqueue): Record<string, unknown> {
  if (message.kind === 'invitation') {
    return {
      token: message.token,
      expiresAt: message.expiresAt.toISOString(),
      workspaceName: message.workspaceName,
      roleName: message.roleName,
    };
  }
  return { token: message.token, expiresAt: message.expiresAt.toISOString() };
}

function text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`The stored payload has no usable "${field}".`);
  }
  return value;
}
