import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import type {
  Decision,
  PermissionKey,
  Principal,
  ResourceRef,
  ScopeLevel,
  SqlExecutor,
} from '@convo/domain';
import { authorize, isPermissionKey } from '@convo/domain';
import type { Pool } from 'pg';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { API_POOL } from '../tokens.js';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The one place an HTTP request becomes an authorization decision.
 *
 * It does two things and nothing else:
 *
 *  1. Loads a `Principal` for this session inside the tenant's RLS context —
 *     grants by permission KEY with their scope level, plus the teams and
 *     inboxes the membership holds.
 *  2. Hands it to the pure `authorize` in `@convo/domain`.
 *
 * The decision logic lives in the domain, not here, so it can be exhaustively
 * tested without a database and cannot be quietly re-implemented per endpoint.
 * Before this service, `PermissionService` inlined `SELECT ... WHERE
 * permission_key = 'role.manage'` — correct for that one route, and the start
 * of a per-endpoint copy of the rules.
 *
 * **Non-membership is concealed as 404.** Answering 403 for a tenant the caller
 * has no membership in would confirm that the tenant exists, which is a tenant
 * enumeration oracle. 403 is reserved for "you are a member here, and this
 * particular action is denied".
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  /**
   * Runs `work` inside the tenant's RLS transaction with a loaded principal.
   *
   * The principal is loaded in the *same* transaction the work runs in, so a
   * membership revoked between the check and the write cannot be used: both
   * read the same snapshot, and the write is subject to the same RLS context.
   */
  async withPrincipal<T>(
    session: AuthenticatedSession,
    tenantId: string,
    work: (context: PrincipalContext) => Promise<T>,
  ): Promise<T> {
    this.assertTenantId(tenantId);
    return withTenant(this.pool, tenantId, async (client) => {
      const sql = asExecutor(client);
      return work({ sql, principal: await this.requirePrincipal(sql, session), tenantId });
    });
  }

  /**
   * Loads and authorizes a principal inside a transaction the caller already
   * owns.
   *
   * The idempotency service opens its own transaction, and the effect plus the
   * stored result must commit together. Nesting a second transaction inside it
   * would break that, so an idempotent route authorizes through this method
   * with the executor it was handed instead.
   */
  async requirePrincipal(sql: SqlExecutor, session: AuthenticatedSession): Promise<Principal> {
    const principal = await loadPrincipal(sql, session.userId);
    if (principal === null) {
      // No membership in this tenant — or no such tenant at all. The two are
      // deliberately indistinguishable from outside.
      throw notFound();
    }
    return principal;
  }

  /** Authorizes one key inside a caller-owned transaction. */
  async requirePermission(
    sql: SqlExecutor,
    session: AuthenticatedSession,
    permission: PermissionKey,
    resource: ResourceRef = {},
  ): Promise<Principal> {
    const principal = await this.requirePrincipal(sql, session);
    const decision = authorize(principal, permission, resource);
    if (!decision.allowed) {
      throw denial(decision);
    }
    return principal;
  }

  /** Rejects a tenant id that cannot name a tenant, before any query runs. */
  assertTenantId(tenantId: string): void {
    if (!UUID_PATTERN.test(tenantId)) {
      throw notFound();
    }
  }

  /**
   * Convenience for the common shape: authorize one key, then do the work.
   * Denials become typed HTTP errors that never leak why the tenant exists.
   */
  async authorized<T>(
    session: AuthenticatedSession,
    tenantId: string,
    permission: PermissionKey,
    work: (context: AuthorizedContext) => Promise<T>,
    resource: ResourceRef = {},
  ): Promise<T> {
    return this.withPrincipal(session, tenantId, async (context) => {
      const decision = authorize(context.principal, permission, resource);
      if (!decision.allowed) {
        throw denial(decision);
      }
      return work({ ...context, decision, scope: decision.scope });
    });
  }
}

export interface PrincipalContext {
  readonly sql: SqlExecutor;
  readonly principal: Principal;
  readonly tenantId: string;
}

export interface AuthorizedContext extends PrincipalContext {
  readonly decision: Extract<Decision, { allowed: true }>;
  readonly scope: Exclude<ScopeLevel, 'none'>;
}

/**
 * Builds the principal from what the database actually holds right now.
 *
 * Everything here is read under FORCE RLS in the tenant's context, so a row
 * from another tenant cannot enter the principal even if a predicate were
 * wrong: the policy denies it before this query sees it.
 */
async function loadPrincipal(sql: SqlExecutor, userId: string): Promise<Principal | null> {
  const membership = await sql.query<{
    membership_id: string;
    membership_status: Principal['membershipStatus'];
    tenant_status: Principal['tenantStatus'];
    role_id: string;
  }>(
    `SELECT m.id::text AS membership_id, m.status AS membership_status,
            t.status AS tenant_status, m.role_id::text AS role_id
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1`,
    [userId],
  );
  const row = membership.rows[0];
  if (row === undefined) {
    return null;
  }

  // Grants by KEY with the scope level. The role's display name is never
  // selected, so there is nothing here to branch on by name.
  const grants = await sql.query<{ permission_key: string; scope_level: ScopeLevel }>(
    `SELECT permission_key, scope_level
       FROM role_permissions
      WHERE role_id = $1`,
    [row.role_id],
  );

  const scopes = await sql.query<{ scope_type: 'tenant' | 'team' | 'inbox'; scope_id: string | null }>(
    `SELECT scope_type, scope_id::text AS scope_id
       FROM membership_scopes
      WHERE membership_id = $1`,
    [row.membership_id],
  );

  const map: Partial<Record<PermissionKey, ScopeLevel>> = {};
  for (const grant of grants.rows) {
    // A key the running code does not know about is ignored rather than
    // trusted: a newer database must never grant a permission this build
    // cannot reason about.
    if (isPermissionKey(grant.permission_key)) {
      map[grant.permission_key] = grant.scope_level;
    }
  }

  return {
    membershipId: row.membership_id,
    membershipStatus: row.membership_status,
    tenantStatus: row.tenant_status,
    grants: map,
    scopes: scopes.rows.map((scope) => ({ type: scope.scope_type, id: scope.scope_id })),
    // Session-backed requests are people. API keys carry a ceiling and will
    // populate this when that surface exists (P5).
    delegationCeiling: null,
  };
}

/**
 * Maps a denial to HTTP without telling the caller anything they should not
 * already know.
 *
 * An inactive membership or tenant reads as 404 for the same reason a
 * non-membership does: from outside, "your access was revoked" and "no such
 * company" must look identical. Everything else is an honest 403 — the caller
 * is a member and the action is denied, which they are entitled to be told.
 */
function denial(decision: Extract<Decision, { allowed: false }>): ApiHttpError {
  if (decision.reason === 'membership_inactive' || decision.reason === 'tenant_inactive') {
    return notFound();
  }
  return new ApiHttpError(
    403,
    'permission_denied',
    'You do not have permission to perform this action.',
  );
}

function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}
