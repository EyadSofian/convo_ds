import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { asExecutor, CREDENTIAL_SETTINGS, withCredentialResolvedTenant } from '@convo/database';
import type {
  GrantMap,
  PermissionKey,
  Principal,
  ScopeLevel,
  SqlExecutor,
} from '@convo/domain';
import { canAssignRole, canGrantScopes, isPermissionKey } from '@convo/domain';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import { requestHash, type JsonValue } from '../idempotency/canonical-json.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { API_CONFIG, API_POOL, INVITATION_DELIVERY, PASSWORD_HASHER } from '../tokens.js';
import type { PasswordHasher } from '../tokens.js';
import { AuthRateLimiter } from '../auth/auth-rate-limiter.js';
import { tokenFingerprint } from '../auth/auth-tokens.js';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { InvitationDeliveryPort } from './invitation-delivery.js';
import type { CreateInvitationRequest } from './invitation-request.js';
import {
  INVITATION_TOKEN_PATTERN,
  parseAcceptInvitation,
  parseCreateInvitation,
} from './invitation-request.js';

/** Seven days. Long enough for a colleague on holiday, short enough to matter. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PURPOSE = 'invitation';

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly status: 'pending' | 'accepted' | 'revoked';
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly created_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly revoked_at: string | null;
  readonly scopes: readonly { readonly type: string; readonly id: string | null }[];
}

export interface AcceptedInvitation {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly userId: string;
}

/**
 * Invitations (IAM-06).
 *
 * The rules that shape this file:
 *
 * 1. **A token is a credential.** Only its HMAC fingerprint is stored, and the
 *    raw value is returned by no endpoint and written to no log.
 * 2. **An inviter cannot give away reach they do not have.** The role and the
 *    scopes are checked against the inviter's own grants at creation time, and
 *    applied verbatim at accept time, so nothing can widen in between.
 * 3. **Acceptance is one transaction, and it is single-use.** The invitation is
 *    claimed by a conditional UPDATE, so two people racing the same link cannot
 *    both become members.
 * 4. **Nothing reveals a global identity.** Whether the address already has an
 *    account somewhere else is never observable — not in a status code, not in
 *    a message, not in a timing-visible branch that skips password hashing.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AuthRateLimiter) private readonly limiter: AuthRateLimiter,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(INVITATION_DELIVERY) private readonly delivery: InvitationDeliveryPort,
  ) {}

  async list(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly InvitationSummary[]> {
    return this.authorization.authorized(session, tenantId, 'member.manage', async ({ sql }) => readInvitations(sql),
    );
  }

  /**
   * Creates an invitation and hands the token to the delivery port.
   *
   * Returns the invitation *without* the token. The caller learns that an
   * invitation exists, not how to accept it — an inviter who could read the
   * token could join as their colleague.
   */
  async create(
    session: AuthenticatedSession,
    tenantId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<InvitationSummary> {
    const parsed = parseCreateInvitation(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }
    const request = parsed.value;
    this.authorization.assertTenantId(tenantId);

    // The idempotency record and the invitation commit together, so a retry
    // replays the first answer instead of minting a second live token for the
    // same seat. Authorization runs inside that same transaction rather than
    // opening its own: nesting would let the two commit separately.
    const outcome = await this.idempotency.execute(
      {
        tenantContextId: tenantId,
        tenantId,
        principalId: session.userId,
        operation: 'invitation.create',
        key: idempotencyKey,
        requestHash: requestHash(body as JsonValue, this.config.secrets.idempotencyHash),
      },
      async (sql) => {
        const principal = await this.authorization.requirePermission(sql, session, 'member.manage');
        const summary = await this.createWithin(sql, tenantId, principal, request);
        return { statusCode: 201, body: summary };
      },
    );

    if (outcome.status === 'conflict') {
      throw new ApiHttpError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    return outcome.response.body as InvitationSummary;
  }

  private async createWithin(
    sql: SqlExecutor,
    tenantId: string,
    principal: Principal,
    request: CreateInvitationRequest,
  ): Promise<InvitationSummary> {
    const role = await sql.query<{ id: string; key: string; name: string }>(
      'SELECT id::text, key, name FROM roles WHERE id = $1',
      [request.roleId],
    );
    const target = role.rows[0];
    if (target === undefined) {
      throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
    }

    // The delegation ceiling. An Admin cannot invite an Owner, and a
    // scoped inviter cannot grant an inbox they cannot see themselves —
    // both fall out of the actor's own grants, with no role name involved.
    const targetGrants = await grantsOfRole(sql, target.id);
    const roleCheck = canAssignRole(principal.grants, targetGrants);
    const scopeCheck = canGrantScopes(principal.scopes, request.scopes);
    if (!roleCheck.allowed || !scopeCheck.allowed) {
      const refusals = [
        ...(roleCheck.allowed ? [] : roleCheck.refusals),
        ...(scopeCheck.allowed ? [] : scopeCheck.refusals),
      ];
      throw new ApiHttpError(
        403,
        'delegation_ceiling',
        'You cannot grant access wider than your own.',
        refusals.map((refusal) => ({
          field: refusal.permission,
          code: refusal.reason,
          message: 'This grant exceeds your own access.',
        })),
      );
    }

    // Already a member *of this company*. That is not a disclosure: the
    // inviter holds `member.manage` and can already see this person on the
    // People screen. Membership of any OTHER company is never consulted.
    const existing = await sql.query<{ id: string }>(
      `SELECT m.id::text FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND m.status <> 'revoked'`,
      [request.email],
    );
    if (existing.rows.length > 0) {
      throw new ApiHttpError(409, 'already_a_member', 'That person is already in this company.');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);

    // Supersede any live invitation for the same address. Two valid tokens
    // for one seat would be two ways in, and revoking one would silently
    // leave the other open. The partial unique index enforces the same
    // thing if this is ever skipped.
    await sql.query(
      `UPDATE invitations SET status = 'revoked', revoked_at = now(), revoked_by = $2
        WHERE email = $1 AND status = 'pending'`,
      [request.email, principal.membershipId],
    );

    const created = await sql.query<{ id: string }>(
      `INSERT INTO invitations (tenant_id, invited_by, email, role_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text`,
      [
        tenantId,
        principal.membershipId,
        request.email,
        target.id,
        this.fingerprint(token),
        expiresAt,
      ],
    );
    const invitationId = requireRow(created.rows, 'invitation insert returned no id').id;

    for (const scope of request.scopes) {
      await sql.query(
        `INSERT INTO invitation_scopes (tenant_id, invitation_id, scope_type, scope_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, invitationId, scope.type, scope.id],
      );
    }

    const tenant = await sql.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [
      tenantId,
    ]);

    // Inside this transaction, on this executor. The invitation and the record
    // that says "send this email" commit together or not at all.
    await this.delivery.deliver(sql, {
      tenantId,
      invitationId,
      email: request.email,
      token,
      tenantName: requireRow(tenant.rows, 'the company vanished mid-transaction').name,
      roleName: target.name,
      expiresAt,
    });

    return requireRow(
      await readInvitations(sql, invitationId),
      'invitation disappeared immediately after insert',
    );
  }

  /** Revokes a pending invitation. Revoking an already-settled one is a no-op 404. */
  async revoke(session: AuthenticatedSession, tenantId: string, invitationId: string): Promise<void> {
    await this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const revoked = await sql.query<{ id: string }>(
          `UPDATE invitations
              SET status = 'revoked', revoked_at = now(), revoked_by = $2
            WHERE id = $1 AND status = 'pending'
            RETURNING id::text`,
          [invitationId, principal.membershipId],
        );
        if (revoked.rows.length === 0) {
          throw new ApiHttpError(
            404,
            'resource_not_found',
            'The requested resource does not exist.',
          );
        }
      },
    );
  }

  /**
   * Accepts an invitation. Unauthenticated by necessity: the invitee may have
   * no account yet.
   *
   * The password is required in both cases — creating a new identity, and
   * proving an existing one. Without it, holding the link would be enough to
   * attach a stranger's established account to a company.
   *
   * Every failure — unknown token, expired, revoked, already accepted, wrong
   * password — returns the same typed error. Distinguishing them would turn the
   * endpoint into an account-existence oracle for the invited address.
   */
  async accept(token: string, body: unknown, ip: string): Promise<AcceptedInvitation> {
    if (!INVITATION_TOKEN_PATTERN.test(token)) {
      throw invalidInvitation();
    }
    const parsed = parseAcceptInvitation(body);
    if (!parsed.ok) {
      throw new ApiHttpError(400, 'invalid_input', 'The request is not valid.', parsed.details);
    }

    // The token is unguessable, but an unlimited accept endpoint is still an
    // unlimited password oracle for the invited address.
    const perIp = await this.limiter.consume('invitation:accept', ip);
    if (perIp.status === 'blocked') {
      throw new ApiHttpError(429, 'rate_limited', 'Too many attempts. Try again later.', [
        { field: 'retry_after', code: 'seconds', message: String(perIp.retryAfterSeconds) },
      ]);
    }

    const credentialHash = this.fingerprint(token);

    // One transaction. `withCredentialResolvedTenant` sets a transaction-local
    // credential fingerprint, which the invitations policy admits for exactly
    // the row carrying that token, reads the tenant off that row, then enters
    // the tenant's normal context for everything that follows. Resolving in a
    // separate transaction would leave a window in which the invitation could
    // be revoked between the lookup and the claim.
    const accepted = await withCredentialResolvedTenant(
      this.pool,
      CREDENTIAL_SETTINGS.invitation,
      credentialHash,
      async (client) => {
        // Only `invitations` is readable here: the carve-out is one row wide
        // and the tenant context is not set yet, so `tenants` is still hidden.
        // The company's own status is checked below, once we are inside it.
        //
        // `FOR UPDATE` locks the row for the rest of the transaction, so a
        // second person racing the same link blocks here, re-evaluates against
        // the committed row, and finds it is no longer pending. Locking during
        // resolution also means the work below already has the row and never
        // has to look it up again.
        const found = await asExecutor(client).query<{
          id: string;
          tenant_id: string;
          email: string;
          role_id: string;
        }>(
          `SELECT id::text, tenant_id::text, email::text AS email, role_id::text AS role_id
             FROM invitations
            WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
              FOR UPDATE`,
          [credentialHash],
        );
        const row = found.rows[0];
        return row === undefined ? null : { tenantId: row.tenant_id, value: row };
      },
      async (client, { tenantId, value: invitation }) => {
        const sql = asExecutor(client);

        // The company has to be live. A suspended or deleted company must not
        // gain members through a link issued while it was healthy.
        const tenant = await sql.query<{ status: string }>(
          'SELECT status FROM tenants WHERE id = $1',
          [tenantId],
        );
        if (tenant.rows[0]?.status !== 'active') {
          return null;
        }

        const user = await sql.query<{
          id: string;
          password_hash: string | null;
          status: string;
        }>('SELECT id::text, password_hash, status FROM users WHERE email = $1', [
          invitation.email,
        ]);
        const existing = user.rows[0];

        let userId: string;
        if (existing === undefined) {
          const hash = await this.hasher.hash(parsed.value.password);
          const created = await sql.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active')
             RETURNING id::text`,
            [invitation.email, hash],
          );
          userId = created.rows[0]?.id as string;
        } else {
          // An established identity has to prove itself. A wrong password is
          // reported exactly like a dead token, and the transaction rolls back,
          // so a guess neither succeeds nor burns the invitation.
          const ok =
            existing.status === 'active' &&
            existing.password_hash !== null &&
            (await this.hasher.verify(existing.password_hash, parsed.value.password));
          if (!ok) {
            // Nothing has been written yet — only a row lock was taken — so
            // reporting the refusal is enough. Unwinding through a sentinel
            // exception would add a rethrow path nothing else can reach.
            return null;
          }
          userId = existing.id;
        }

        const membership = await sql.query<{ id: string }>(
          `INSERT INTO memberships (tenant_id, user_id, role_id, status)
           VALUES ($1, $2, $3, 'active')
           RETURNING id::text`,
          [tenantId, userId, invitation.role_id],
        );
        const membershipId = requireRow(membership.rows, 'membership insert returned no id').id;

        // Exactly the scopes recorded at creation. Reading them from the
        // invitation rather than the request is what stops the grant widening
        // between the invite and the click.
        await sql.query(
          `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
           SELECT tenant_id, $2, scope_type, scope_id
             FROM invitation_scopes WHERE invitation_id = $1`,
          [invitation.id, membershipId],
        );

        // Status and membership move together, so the invitation is never
        // "accepted by nobody" — not even inside this transaction.
        const settled = await sql.query<{ id: string }>(
          `UPDATE invitations
              SET status = 'accepted', accepted_at = now(), accepted_membership = $2
            WHERE id = $1 AND status = 'pending'
            RETURNING id::text`,
          [invitation.id, membershipId],
        );
        requireRow(settled.rows, 'invitation changed state while it was locked');

        return { tenantId, membershipId, userId };
      },
    );

    if (accepted === null) {
      // Hash a throwaway password when nothing was accepted, so a dead token
      // and a wrong password cost the same. Skipping the work is what turns a
      // constant answer into a timing oracle.
      await this.hasher.hash(parsed.value.password);
      throw invalidInvitation();
    }

    // A successful accept clears the attempt counter: a company onboarding ten
    // people from one office must not lock itself out, while a guessing run —
    // which never succeeds — keeps counting.
    await this.limiter.reset('invitation:accept', ip);
    return accepted;
  }

  private fingerprint(token: string): string {
    return tokenFingerprint(this.config.secrets.authHash, TOKEN_PURPOSE, token);
  }
}

async function grantsOfRole(sql: SqlExecutor, roleId: string): Promise<GrantMap> {
  const rows = await sql.query<{
    permission_key: string;
    scope_level: ScopeLevel;
  }>('SELECT permission_key, scope_level FROM role_permissions WHERE role_id = $1', [roleId]);
  const grants: Partial<Record<PermissionKey, ScopeLevel>> = {};
  for (const row of rows.rows) {
    if (isPermissionKey(row.permission_key)) {
      grants[row.permission_key] = row.scope_level;
    }
  }
  return grants;
}

async function readInvitations(
  sql: SqlExecutor,
  only?: string,
): Promise<readonly InvitationSummary[]> {
  const rows = await sql.query<{
    id: string;
    email: string;
    status: InvitationSummary['status'];
    role_id: string;
    role_key: string;
    role_name: string;
    created_at: Date;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT i.id::text, i.email::text AS email, i.status,
            r.id::text AS role_id, r.key AS role_key, r.name AS role_name,
            i.created_at, i.expires_at, i.accepted_at, i.revoked_at
       FROM invitations i
       JOIN roles r ON r.tenant_id = i.tenant_id AND r.id = i.role_id
      WHERE ($1::uuid IS NULL OR i.id = $1)
      ORDER BY i.created_at DESC`,
    [only ?? null],
  );

  const scopes = await sql.query<{
    invitation_id: string;
    scope_type: string;
    scope_id: string | null;
  }>(
    `SELECT invitation_id::text, scope_type, scope_id::text AS scope_id
       FROM invitation_scopes ORDER BY invitation_id, scope_type`,
  );

  return rows.rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    accepted_at: row.accepted_at === null ? null : row.accepted_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    scopes: scopes.rows
      .filter((scope) => scope.invitation_id === row.id)
      .map((scope) => ({ type: scope.scope_type, id: scope.scope_id })),
  }));
}

/**
 * Unknown, expired, revoked, already accepted, and wrong password are one
 * answer. Any difference between them tells a stranger holding a link
 * something about the person it was sent to.
 */
function invalidInvitation(): ApiHttpError {
  return new ApiHttpError(
    400,
    'invalid_input',
    'This invitation is no longer valid. Ask for a new one.',
    [
      {
        field: 'invitation',
        code: 'invalid_or_expired',
        message: 'Unknown, expired, revoked, already used, or the password did not match.',
      },
    ],
  );
}
