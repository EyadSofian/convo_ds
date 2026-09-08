import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import {
  API_CONFIG,
  API_POOL,
  PASSWORD_HASHER,
  RECOVERY_DELIVERY,
  type PasswordHasher,
} from '../tokens.js';
import { AuthRateLimiter } from './auth-rate-limiter.js';
import type { RecoveryDeliveryPort } from './recovery-delivery.js';
import { parseRecoveryComplete, parseRecoveryStart } from './recovery-request.js';
import { tokenFingerprint } from './auth-tokens.js';

/** One hour. Long enough for a distracted person, short enough to matter. */
const CHALLENGE_TTL_SECONDS = 60 * 60;

const TOKEN_PURPOSE = 'recovery';
const TARGET_PURPOSE = 'recovery-target';

export interface RecoveryStartOutcome {
  readonly accepted: true;
  readonly retryAfterSeconds?: number;
}

/**
 * Password recovery (IAM-03).
 *
 * Three rules shape every line here:
 *
 * 1. **The response never depends on whether the account exists.** Start always
 *    returns the same 202 body. An unknown address does the same amount of
 *    observable work — including a rate-limit consume — as a known one.
 * 2. **Only hashes are stored.** The raw token exists in memory long enough to
 *    hand to the delivery port and is never written, logged or returned.
 * 3. **Completion is one transaction.** The challenge is consumed, the password
 *    is replaced and every existing session is revoked together, so a token
 *    cannot be spent twice and a stolen session cannot outlive the reset.
 */
@Injectable()
export class RecoveryService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AuthRateLimiter) private readonly limiter: AuthRateLimiter,
    @Inject(RECOVERY_DELIVERY) private readonly delivery: RecoveryDeliveryPort,
  ) {}

  /**
   * Starts recovery. Always reports acceptance.
   *
   * Rate limits are shared with login through the same `auth_rate_limits`
   * table, so recovery cannot be used to sidestep the login limit — and being
   * limited is reported the same way for a known and an unknown address.
   */
  async start(body: unknown, ip: string): Promise<RecoveryStartOutcome> {
    const parsed = parseRecoveryStart(body);
    if (!parsed.ok) {
      throw new ApiHttpError(
        400,
        'invalid_input',
        'The request is not valid.',
        parsed.details,
      );
    }
    const email = parsed.value.email;

    // Both buckets are consumed before any account lookup, so the timing and
    // the limit behaviour are identical whether or not the address is real.
    const perAddress = await this.limiter.consume('recovery:target', email);
    const perIp = await this.limiter.consume('recovery:ip', ip);
    if (perAddress.status === 'blocked' || perIp.status === 'blocked') {
      const retry = Math.max(
        perAddress.status === 'blocked' ? perAddress.retryAfterSeconds : 0,
        perIp.status === 'blocked' ? perIp.retryAfterSeconds : 0,
      );
      // Still 202: a 429 here would tell an enumerator that they had found a
      // rate-limited — therefore real — target. The delay is advertised, the
      // existence of the account is not.
      return { accepted: true, retryAfterSeconds: retry };
    }

    const user = await this.pool.query<{ id: string }>(
      "SELECT id::text FROM users WHERE email = $1 AND status = 'active'",
      [email],
    );
    const userId = user.rows[0]?.id ?? null;

    // A challenge row is written either way. For an unknown address `user_id`
    // is NULL, so the table's shape and size do not reveal which addresses are
    // real, and the write cost is the same.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    await this.pool.query(
      `INSERT INTO password_recovery_challenges
         (id, user_id, target_hash, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        userId,
        this.fingerprint(TARGET_PURPOSE, email),
        this.fingerprint(TOKEN_PURPOSE, token),
        expiresAt,
      ],
    );

    if (userId !== null) {
      await this.delivery.deliver({ email, token, expiresAt });
    }

    return { accepted: true };
  }

  /**
   * Completes recovery: consume the challenge, replace the password, revoke
   * every session — all in one transaction.
   *
   * An expired, already-used or unknown token gives the same typed error. There
   * is nothing useful to distinguish: all three mean "start again".
   */
  async complete(body: unknown, ip: string): Promise<void> {
    const parsed = parseRecoveryComplete(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }

    // Guessing a 256-bit token is not feasible, but an unlimited completion
    // endpoint is still an unlimited oracle; it shares the login IP bucket.
    const perIp = await this.limiter.consume('recovery:complete', ip);
    if (perIp.status === 'blocked') {
      throw new ApiHttpError(429, 'rate_limited', 'Too many attempts. Try again later.', [
        {
          field: 'retry_after',
          code: 'seconds',
          message: String(perIp.retryAfterSeconds),
        },
      ]);
    }

    const tokenHash = this.fingerprint(TOKEN_PURPOSE, parsed.value.token);
    const passwordHash = await this.hasher.hash(parsed.value.password);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Claim the challenge with a conditional UPDATE: two concurrent requests
      // holding the same token cannot both succeed, because the second sees
      // `used_at` already set and updates nothing.
      //
      // `user_id IS NOT NULL` is part of the predicate rather than a branch
      // below it. Decoy challenges — the rows written for addresses with no
      // account, so the table is not a directory — carry a NULL user and are
      // never delivered to anyone, so they simply do not match. Handling them
      // in a separate branch would be code no request could ever reach.
      const claimed = await client.query<{ user_id: string }>(
        `UPDATE password_recovery_challenges
            SET used_at = now()
          WHERE token_hash = $1
            AND used_at IS NULL
            AND expires_at > now()
            AND user_id IS NOT NULL
          RETURNING user_id::text AS user_id`,
        [tokenHash],
      );
      const userId = claimed.rows[0]?.user_id;

      if (userId === undefined) {
        await client.query('ROLLBACK');
        throw invalidToken();
      }

      await client.query(
        "UPDATE users SET password_hash = $1 WHERE id = $2 AND status = 'active'",
        [passwordHash, userId],
      );

      // Every session, including the one that requested the reset. A password
      // change that leaves an attacker's session alive has changed nothing.
      await client.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );

      // Any other outstanding challenge for the same account is spent too, so
      // an older email cannot be used after this one.
      await client.query(
        'UPDATE password_recovery_challenges SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [userId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private fingerprint(purpose: string, value: string): string {
    return tokenFingerprint(this.config.secrets.authHash, purpose, value);
  }
}

function invalidToken(): ApiHttpError {
  // Expired, already used and never issued are one answer on purpose.
  return new ApiHttpError(
    400,
    'invalid_input',
    'This recovery link is no longer valid. Request a new one.',
    [
      {
        field: 'token',
        code: 'invalid_or_expired',
        message: 'Expired, already used, or never issued — all report the same way.',
      },
    ],
  );
}
