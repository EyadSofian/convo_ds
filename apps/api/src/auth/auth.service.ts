import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { API_CONFIG, API_POOL, PASSWORD_HASHER, type PasswordHasher } from '../tokens.js';
import { AuthRateLimiter, type RateLimitDecision } from './auth-rate-limiter.js';
import { parseLoginRequest } from './auth-request.js';
import { parsePasswordChange } from './password-change-request.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  issueAuthTokens,
  readCookie,
  tokenFingerprint,
  tokenMatches,
  type AuthTokens,
} from './auth-tokens.js';

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$kdub0hM+hpYH+qEhIuyVcQ$OkrruZr1O3+cSPMXtC4/lzRCmG3RdOxAbcNB7v4hyWs';
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string | null;
  readonly status: 'active' | 'suspended' | 'deleted';
}

interface AuthenticatedRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly csrf_hash: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly expires_at: Date;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly csrfHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export interface PublicSession {
  readonly id: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly current: boolean;
}

export interface LoginOutcome {
  readonly principal: AuthenticatedSession;
  readonly tokens: AuthTokens;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(AuthRateLimiter) private readonly rateLimiter: AuthRateLimiter,
  ) {}

  async login(body: unknown, ip: string, userAgent: string | undefined): Promise<LoginOutcome> {
    const parsed = parseLoginRequest(body);
    if (parsed.status === 'invalid') {
      throw new ApiHttpError(
        400,
        'invalid_input',
        'The login request is not valid.',
        parsed.details,
      );
    }

    const [accountLimit, ipLimit] = await Promise.all([
      this.rateLimiter.consume('login-account', parsed.value.email),
      this.rateLimiter.consume('login-ip', ip),
    ]);
    this.throwIfRateLimited(accountLimit, ipLimit);

    const found = await this.pool.query<UserRow>(
      'SELECT id::text, email::text, password_hash, status FROM users WHERE email = $1',
      [parsed.value.email],
    );
    const user = found.rows[0];
    const passwordHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await this.passwords
      .verify(passwordHash, parsed.value.password)
      .catch(() => false);
    if (user === undefined || user.status !== 'active' || !passwordMatches) {
      throw new ApiHttpError(401, 'credentials_invalid', 'Email or password is not valid.');
    }

    await Promise.all([
      this.rateLimiter.reset('login-account', parsed.value.email),
      this.rateLimiter.reset('login-ip', ip),
    ]);
    const tokens = issueAuthTokens();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const secret = this.config.secrets.authHash;
    const inserted = await this.pool.query<AuthenticatedRow>(
      `INSERT INTO user_sessions
         (id, user_id, verifier_hash, csrf_hash, ip_hash, user_agent_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS session_id, user_id::text, $8::text AS email,
         csrf_hash, created_at, last_seen_at, expires_at`,
      [
        sessionId,
        user.id,
        tokenFingerprint(secret, 'session', tokens.session),
        tokenFingerprint(secret, 'csrf', tokens.csrf),
        tokenFingerprint(secret, 'client-ip', ip),
        userAgent === undefined
          ? null
          : tokenFingerprint(secret, 'user-agent', userAgent.slice(0, 1024)),
        expiresAt,
        user.email,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Session insert did not return the created row');
    }
    return { principal: mapAuthenticated(row), tokens };
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthenticatedSession> {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (token === undefined) {
      throw unauthenticated();
    }
    const verifierHash = tokenFingerprint(this.config.secrets.authHash, 'session', token);
    const result = await this.pool.query<AuthenticatedRow>(
      `SELECT s.id::text AS session_id, s.user_id::text, u.email::text,
         s.csrf_hash, s.created_at, s.last_seen_at, s.expires_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.verifier_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > now() AND u.status = 'active'`,
      [verifierHash],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw unauthenticated();
    }
    await this.pool.query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [
      row.session_id,
    ]);
    return mapAuthenticated(row);
  }

  requireCsrf(
    session: AuthenticatedSession,
    cookieHeader: string | undefined,
    header: string | string[] | undefined,
  ): void {
    const cookie = readCookie(cookieHeader, CSRF_COOKIE);
    const secret = this.config.secrets.authHash;
    if (
      !tokenMatches(session.csrfHash, secret, 'csrf', cookie) ||
      !tokenMatches(session.csrfHash, secret, 'csrf', header)
    ) {
      throw new ApiHttpError(403, 'csrf_invalid', 'The CSRF token is missing or invalid.');
    }
  }

  async listSessions(current: AuthenticatedSession): Promise<readonly PublicSession[]> {
    const rows = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT id::text, created_at, last_seen_at, expires_at
       FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [current.userId],
    );
    return rows.rows.map((row) => mapPublicSession(row, current.sessionId));
  }

  async getSession(current: AuthenticatedSession, sessionId: string): Promise<PublicSession> {
    if (!UUID_PATTERN.test(sessionId)) {
      throw sessionNotFound();
    }
    const result = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT id::text, created_at, last_seen_at, expires_at
       FROM user_sessions
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [sessionId, current.userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw sessionNotFound();
    }
    return mapPublicSession(row, current.sessionId);
  }

  async revokeSession(current: AuthenticatedSession, sessionId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(sessionId)) {
      throw sessionNotFound();
    }
    const result = await this.pool.query(
      `UPDATE user_sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [sessionId, current.userId],
    );
    if (result.rowCount !== 1) {
      throw sessionNotFound();
    }
    return sessionId === current.sessionId;
  }

  async logout(current: AuthenticatedSession): Promise<void> {
    await this.pool.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [current.sessionId],
    );
  }

  /** Changes the credential atomically, retaining only the session that proved it. */
  async changePassword(current: AuthenticatedSession, body: unknown): Promise<void> {
    const parsed = parsePasswordChange(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The password change request is not valid.', parsed.details);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE",
        [current.userId],
      );
      const existing = found.rows[0]?.password_hash;
      if (existing === null || existing === undefined || !(await this.passwords.verify(existing, parsed.value.currentPassword).catch(() => false))) {
        throw new ApiHttpError(400, 'current_password_invalid', 'The current password is not valid.');
      }
      if (await this.passwords.verify(existing, parsed.value.newPassword).catch(() => false)) {
        throw new ApiHttpError(409, 'password_unchanged', 'Choose a password you have not just used.');
      }
      const replacement = await this.passwords.hash(parsed.value.newPassword);
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [replacement, current.userId]);
      await client.query(
        `UPDATE user_sessions SET revoked_at = now()
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [current.userId, current.sessionId],
      );
      await client.query(
        `INSERT INTO account_security_events(user_id,session_id,action,detail)
         VALUES ($1,$2,'password.changed',$3::jsonb)`,
        [current.userId, current.sessionId, JSON.stringify({ other_sessions_revoked: true })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  get sessionTtlSeconds(): number {
    return SESSION_TTL_SECONDS;
  }

  get secureCookies(): boolean {
    return this.config.publicBaseUrl.startsWith('https://');
  }

  private throwIfRateLimited(...decisions: readonly RateLimitDecision[]): void {
    const blocked = decisions.filter(
      (decision): decision is Extract<RateLimitDecision, { status: 'blocked' }> =>
        decision.status === 'blocked',
    );
    if (blocked.length === 0) {
      return;
    }
    const retryAfter = Math.max(...blocked.map((decision) => decision.retryAfterSeconds));
    throw new ApiHttpError(
      429,
      'login_rate_limited',
      'Too many login attempts. Try again later.',
      [
        {
          field: 'retry_after_seconds',
          code: 'retry_later',
          message: String(retryAfter),
        },
      ],
      { 'retry-after': String(retryAfter) },
    );
  }
}

function mapAuthenticated(row: AuthenticatedRow): AuthenticatedSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    csrfHash: row.csrf_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

function mapPublicSession(
  row: { readonly id: string; readonly created_at: Date; readonly last_seen_at: Date; readonly expires_at: Date },
  currentSessionId: string,
): PublicSession {
  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    current: row.id === currentSessionId,
  };
}

function unauthenticated(): ApiHttpError {
  return new ApiHttpError(401, 'authentication_required', 'Authentication is required.');
}

function sessionNotFound(): ApiHttpError {
  return new ApiHttpError(404, 'session_not_found', 'The requested session does not exist.');
}
