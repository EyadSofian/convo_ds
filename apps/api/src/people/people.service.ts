import { Inject, Injectable } from '@nestjs/common';
import type { GrantMap, PermissionKey, Principal, ScopeLevel, SqlExecutor } from '@convo/domain';
import { canAssignRole, canAuthorRole, canGrantScopes, isPermissionKey } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { PersonSummary, RoleSummary, TeamSummary } from '../authorization/permission.service.js';
import { ApiHttpError } from '../http-error.js';
import { requireRow } from '../require-row.js';
import type {
  RoleGrantInput,
  ScopeInput,
  UpdateMembershipRequest,
  WriteRoleRequest,
  WriteTeamRequest,
} from './people-request.js';
import {
  parseMembershipRef,
  parseUpdateMembership,
  parseWriteRole,
  parseWriteTeam,
} from './people-request.js';

/** Twelve hours. An ownership offer is a decision, not a standing option. */
const TRANSFER_TTL_SECONDS = 12 * 60 * 60;

export interface OwnershipTransferSummary {
  readonly id: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  readonly from_membership: string;
  readonly to_membership: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly settled_at: string | null;
}

/**
 * The People, Roles and Teams mutation surface.
 *
 * One rule governs every method here: **an actor can never produce access they
 * do not have.** Every change that grants something is checked against the
 * actor's own grants and scopes by the pure functions in `@convo/domain`, and
 * the database backs the same rules up where a service bug would otherwise be
 * the only thing standing between a caller and an escalation:
 *
 * - built-in roles and their grants are immutable (triggers, migration 0009);
 * - a company always keeps an active Owner (deferred trigger, migration 0007);
 * - every row read or written is inside the tenant's RLS context.
 *
 * Every mutation writes an audit row in the same transaction as its effect, so
 * the record and the change cannot disagree.
 */
@Injectable()
export class PeopleService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  /* ------------------------------------------------------------ people -- */

  /**
   * Changes a membership's role, status or scopes.
   *
   * The delegation ceiling applies to the *target* role, not to the act: an
   * Admin may change anyone's role to anything an Admin could hold. Removing
   * the last Owner is refused by the database, not by a count here, because two
   * concurrent transactions each demoting "the other" Owner would both pass an
   * application check.
   */
  async updateMembership(
    session: AuthenticatedSession,
    tenantId: string,
    membershipId: string,
    body: unknown,
  ): Promise<PersonSummary> {
    const parsed = parseUpdateMembership(body);
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    const request: UpdateMembershipRequest = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const target = await sql.query<{ id: string; user_id: string }>(
          'SELECT id::text, user_id::text FROM memberships WHERE id = $1',
          [membershipId],
        );
        if (target.rows.length === 0) {
          throw notFound();
        }

        if (request.roleId !== undefined) {
          await this.assertCanGiveRole(sql, principal, request.roleId);
          await sql.query('UPDATE memberships SET role_id = $2 WHERE id = $1', [
            membershipId,
            request.roleId,
          ]);
        }

        if (request.status !== undefined) {
          // Someone must not be able to lock themselves out and leave a company
          // with no administrator; the Owner guard covers the dangerous case,
          // and self-suspension is refused outright because it has no purpose.
          if (membershipId === principal.membershipId && request.status !== 'active') {
            throw new ApiHttpError(
              409,
              'cannot_change_own_status',
              'You cannot suspend or revoke your own membership.',
            );
          }
          await sql.query(
            `UPDATE memberships
                SET status = $2, revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END
              WHERE id = $1`,
            [membershipId, request.status],
          );
        }

        if (request.scopes !== undefined) {
          const check = canGrantScopes(principal.scopes, request.scopes);
          if (!check.allowed) {
            throw ceiling(check.refusals);
          }
          await sql.query('DELETE FROM membership_scopes WHERE membership_id = $1', [membershipId]);
          await insertScopes(sql, tenantId, membershipId, request.scopes);
        }

        await audit(sql, tenantId, principal, session, {
          action: 'membership.update',
          subjectType: 'membership',
          subjectId: membershipId,
          detail: {
            role_changed: request.roleId !== undefined,
            status: request.status ?? null,
            scopes_changed: request.scopes !== undefined,
          },
        });

        return readPerson(sql, membershipId);
      },
    );
  }

  /* ------------------------------------------------------------- roles -- */

  /**
   * Creates a custom role.
   *
   * `canAuthorRole` applies the stricter of the two delegation rules: subset of
   * what the actor holds, **and** delegable. That is what stops someone with
   * `role.manage` minting "Support Admin" carrying `credential.rotate` and then
   * assigning it to themselves.
   */
  async createRole(
    session: AuthenticatedSession,
    tenantId: string,
    body: unknown,
  ): Promise<RoleSummary> {
    const parsed = parseWriteRole(body);
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    const request: WriteRoleRequest = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'role.manage',
      async ({ sql, principal }) => {
        assertAuthorable(principal, request.grants);

        const created = await sql.query<{ id: string }>(
          `INSERT INTO roles (tenant_id, key, name, description, is_builtin)
           VALUES ($1, $2, $3, $4, false)
           ON CONFLICT (tenant_id, key) DO NOTHING
           RETURNING id::text`,
          [tenantId, keyFor(request.name), request.name, request.description],
        );
        if (created.rows.length === 0) {
          throw new ApiHttpError(409, 'role_exists', 'A role with that name already exists.');
        }
        const roleId = requireRow(created.rows, 'role insert returned no id').id;

        await writeGrants(sql, tenantId, roleId, request.grants);
        await audit(sql, tenantId, principal, session, {
          action: 'role.create',
          subjectType: 'role',
          subjectId: roleId,
          detail: { name: request.name, grants: request.grants.length },
        });
        return readRole(sql, roleId);
      },
    );
  }

  /** Replaces a custom role's name, description and grants. Built-ins refuse. */
  async updateRole(
    session: AuthenticatedSession,
    tenantId: string,
    roleId: string,
    body: unknown,
  ): Promise<RoleSummary> {
    const parsed = parseWriteRole(body);
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    const request: WriteRoleRequest = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'role.manage',
      async ({ sql, principal }) => {
        await assertCustomRole(sql, roleId);
        assertAuthorable(principal, request.grants);

        await sql.query(
          'UPDATE roles SET name = $2, description = $3, updated_at = now() WHERE id = $1',
          [roleId, request.name, request.description],
        );
        await sql.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
        await writeGrants(sql, tenantId, roleId, request.grants);
        await audit(sql, tenantId, principal, session, {
          action: 'role.update',
          subjectType: 'role',
          subjectId: roleId,
          detail: { name: request.name, grants: request.grants.length },
        });
        return readRole(sql, roleId);
      },
    );
  }

  /** Deletes a custom role that nobody holds. */
  async deleteRole(session: AuthenticatedSession, tenantId: string, roleId: string): Promise<void> {
    await this.authorization.authorized(
      session,
      tenantId,
      'role.manage',
      async ({ sql, principal }) => {
        await assertCustomRole(sql, roleId);
        const held = await sql.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM memberships WHERE role_id = $1 AND status <> 'revoked'",
          [roleId],
        );
        if (Number(requireRow(held.rows, 'count returned nothing').count) > 0) {
          // Deleting it would leave those memberships pointing at nothing, or
          // silently move people to another role. Both are worse than a refusal.
          throw new ApiHttpError(
            409,
            'role_in_use',
            'Move the people holding this role before deleting it.',
          );
        }
        await sql.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
        await sql.query('DELETE FROM roles WHERE id = $1', [roleId]);
        await audit(sql, tenantId, principal, session, {
          action: 'role.delete',
          subjectType: 'role',
          subjectId: roleId,
          detail: {},
        });
      },
    );
  }

  /* ------------------------------------------------------------- teams -- */

  async createTeam(
    session: AuthenticatedSession,
    tenantId: string,
    body: unknown,
  ): Promise<TeamSummary> {
    const parsed = parseWriteTeam(body);
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    const request: WriteTeamRequest = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const created = await sql.query<{ id: string }>(
          `INSERT INTO teams (tenant_id, name) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING id::text`,
          [tenantId, request.name],
        );
        if (created.rows.length === 0) {
          throw new ApiHttpError(409, 'team_exists', 'A live team with that name already exists.');
        }
        const teamId = requireRow(created.rows, 'team insert returned no id').id;
        await audit(sql, tenantId, principal, session, {
          action: 'team.create',
          subjectType: 'team',
          subjectId: teamId,
          detail: { name: request.name },
        });
        return readTeam(sql, teamId);
      },
    );
  }

  /** Renames a team, or archives it. Archiving keeps its history. */
  async updateTeam(
    session: AuthenticatedSession,
    tenantId: string,
    teamId: string,
    body: unknown,
  ): Promise<TeamSummary> {
    const parsed = parseWriteTeam(body);
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    const request: WriteTeamRequest = parsed.value;

    return this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const updated = await sql.query<{ id: string }>(
          `UPDATE teams
              SET name = $2,
                  archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END
            WHERE id = $1
            RETURNING id::text`,
          [teamId, request.name, request.archived],
        );
        if (updated.rows.length === 0) {
          throw notFound();
        }
        await audit(sql, tenantId, principal, session, {
          action: request.archived ? 'team.archive' : 'team.update',
          subjectType: 'team',
          subjectId: teamId,
          detail: { name: request.name, archived: request.archived },
        });
        return readTeam(sql, teamId);
      },
    );
  }

  async addTeamMember(
    session: AuthenticatedSession,
    tenantId: string,
    teamId: string,
    body: unknown,
  ): Promise<TeamSummary> {
    const parsed = parseMembershipRef(body, 'membershipId');
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    return this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const live = await sql.query<{ id: string }>(
          'SELECT id::text FROM teams WHERE id = $1 AND archived_at IS NULL',
          [teamId],
        );
        if (live.rows.length === 0) {
          throw notFound();
        }
        // The composite foreign key already refuses a membership from another
        // tenant; RLS refuses it before that. This turns the resulting error
        // into the 404 the caller is entitled to instead of a 500.
        const member = await sql.query<{ id: string }>(
          'SELECT id::text FROM memberships WHERE id = $1',
          [parsed.value.membershipId],
        );
        if (member.rows.length === 0) {
          throw notFound();
        }
        await sql.query(
          `INSERT INTO team_members (tenant_id, team_id, membership_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [tenantId, teamId, parsed.value.membershipId],
        );
        await audit(sql, tenantId, principal, session, {
          action: 'team.member.add',
          subjectType: 'team',
          subjectId: teamId,
          detail: { membership: parsed.value.membershipId },
        });
        return readTeam(sql, teamId);
      },
    );
  }

  async removeTeamMember(
    session: AuthenticatedSession,
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<TeamSummary> {
    return this.authorization.authorized(
      session,
      tenantId,
      'member.manage',
      async ({ sql, principal }) => {
        const removed = await sql.query<{ membership_id: string }>(
          `DELETE FROM team_members WHERE team_id = $1 AND membership_id = $2
           RETURNING membership_id::text`,
          [teamId, membershipId],
        );
        if (removed.rows.length === 0) {
          throw notFound();
        }
        await audit(sql, tenantId, principal, session, {
          action: 'team.member.remove',
          subjectType: 'team',
          subjectId: teamId,
          detail: { membership: membershipId },
        });
        return readTeam(sql, teamId);
      },
    );
  }

  /* --------------------------------------------------------- ownership -- */

  /**
   * Offers ownership to another membership.
   *
   * An offer, not an act: the recipient accepts it. `tenant.delete` is the key
   * that distinguishes Owner from Admin, so requiring it here is what makes
   * "only an Owner may transfer ownership" true without naming the role.
   */
  async offerOwnership(
    session: AuthenticatedSession,
    tenantId: string,
    body: unknown,
  ): Promise<OwnershipTransferSummary> {
    const parsed = parseMembershipRef(body, 'membershipId');
    if (!parsed.ok) {
      throw invalid(parsed.details);
    }
    return this.authorization.authorized(
      session,
      tenantId,
      'tenant.delete',
      async ({ sql, principal }) => {
        if (parsed.value.membershipId === principal.membershipId) {
          throw new ApiHttpError(
            409,
            'cannot_transfer_to_self',
            'Choose someone else to receive ownership.',
          );
        }
        const recipient = await sql.query<{ id: string }>(
          "SELECT id::text FROM memberships WHERE id = $1 AND status = 'active'",
          [parsed.value.membershipId],
        );
        if (recipient.rows.length === 0) {
          throw notFound();
        }

        const offered = await sql.query<{ id: string }>(
          `INSERT INTO ownership_transfers (tenant_id, from_membership, to_membership, expires_at)
           VALUES ($1, $2, $3, now() + $4 * interval '1 second')
           ON CONFLICT DO NOTHING
           RETURNING id::text`,
          [tenantId, principal.membershipId, parsed.value.membershipId, TRANSFER_TTL_SECONDS],
        );
        if (offered.rows.length === 0) {
          // The partial unique index allows one live offer per company: two
          // pending transfers would race to decide who ends up Owner.
          throw new ApiHttpError(
            409,
            'transfer_already_pending',
            'An ownership transfer is already awaiting a decision.',
          );
        }
        const transferId = requireRow(offered.rows, 'transfer insert returned no id').id;
        await audit(sql, tenantId, principal, session, {
          action: 'ownership.offer',
          subjectType: 'ownership',
          subjectId: transferId,
          detail: { to: parsed.value.membershipId },
        });
        return readTransfer(sql, transferId);
      },
    );
  }

  /**
   * Accepts the offer: the recipient becomes Owner and the outgoing Owner
   * becomes an Admin, in one transaction.
   *
   * The company is briefly Owner-less between the two updates, which is exactly
   * why the last-Owner trigger from migration 0007 is DEFERRABLE INITIALLY
   * DEFERRED — it checks at commit, when there is again exactly one.
   */
  async settleOwnership(
    session: AuthenticatedSession,
    tenantId: string,
    transferId: string,
    decision: 'accepted' | 'declined' | 'cancelled',
  ): Promise<OwnershipTransferSummary> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const found = await sql.query<{
        id: string;
        from_membership: string;
        to_membership: string;
      }>(
        `SELECT id::text, from_membership::text, to_membership::text
           FROM ownership_transfers
          WHERE id = $1 AND status = 'pending' AND expires_at > now()
            FOR UPDATE`,
        [transferId],
      );
      const transfer = found.rows[0];
      if (transfer === undefined) {
        throw notFound();
      }

      // Only the recipient may accept or decline; only the offerer may cancel.
      // Anyone else is told the offer does not exist, because whether one is
      // outstanding is not their business.
      const allowed =
        decision === 'cancelled'
          ? transfer.from_membership === principal.membershipId
          : transfer.to_membership === principal.membershipId;
      if (!allowed) {
        throw notFound();
      }

      await sql.query(
        'UPDATE ownership_transfers SET status = $2, settled_at = now() WHERE id = $1',
        [transferId, decision],
      );

      if (decision === 'accepted') {
        // Both roles are seeded at company creation and cannot be deleted
        // (migration 0009), so the guard lives in the shared total function
        // rather than as a branch here that nothing can reach.
        const ownerRole = requireRow(
          (await sql.query<{ id: string }>("SELECT id::text FROM roles WHERE key = 'owner'")).rows,
          'the built-in Owner role is missing',
        ).id;
        const adminRole = requireRow(
          (await sql.query<{ id: string }>("SELECT id::text FROM roles WHERE key = 'admin'")).rows,
          'the built-in Admin role is missing',
        ).id;
        // Demote first, promote second: the deferred constraint tolerates the
        // gap and refuses only a commit that leaves nobody in charge.
        await sql.query('UPDATE memberships SET role_id = $2 WHERE id = $1', [
          transfer.from_membership,
          adminRole,
        ]);
        await sql.query('UPDATE memberships SET role_id = $2 WHERE id = $1', [
          transfer.to_membership,
          ownerRole,
        ]);
      }

      await audit(sql, tenantId, principal, session, {
        action: `ownership.${decision}`,
        subjectType: 'ownership',
        subjectId: transferId,
        detail: {},
      });
      return readTransfer(sql, transferId);
    });
  }

  async listOwnershipTransfers(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly OwnershipTransferSummary[]> {
    return this.authorization.authorized(session, tenantId, 'member.manage', async ({ sql }) => {
      const rows = await sql.query<TransferRow>(
        `SELECT id::text, status, from_membership::text, to_membership::text,
                created_at, expires_at, settled_at
           FROM ownership_transfers ORDER BY created_at DESC`,
      );
      return rows.rows.map(mapTransfer);
    });
  }

  /* ----------------------------------------------------------- helpers -- */

  private async assertCanGiveRole(
    sql: SqlExecutor,
    principal: Principal,
    roleId: string,
  ): Promise<void> {
    const role = await sql.query<{ id: string }>('SELECT id::text FROM roles WHERE id = $1', [
      roleId,
    ]);
    if (role.rows.length === 0) {
      throw notFound();
    }
    const grants = await grantsOfRole(sql, roleId);
    const check = canAssignRole(principal.grants, grants);
    if (!check.allowed) {
      throw ceiling(check.refusals);
    }
  }
}

/* --------------------------------------------------------------- shared -- */

interface AuditEntry {
  readonly action: string;
  readonly subjectType: 'membership' | 'role' | 'team' | 'invitation' | 'ownership';
  readonly subjectId: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * Writes the audit row in the caller's transaction, so the record and the
 * change commit together or not at all. An audit written afterwards is an audit
 * that can be missing exactly when it matters.
 */
async function audit(
  sql: SqlExecutor,
  tenantId: string,
  principal: Principal,
  session: AuthenticatedSession,
  entry: AuditEntry,
): Promise<void> {
  await sql.query(
    `INSERT INTO admin_audit_events
       (tenant_id, actor_membership, actor_email, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      tenantId,
      principal.membershipId,
      session.email,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      JSON.stringify(entry.detail),
    ],
  );
}

function assertAuthorable(principal: Principal, grants: readonly RoleGrantInput[]): void {
  const requested: Partial<Record<PermissionKey, ScopeLevel>> = {};
  for (const grant of grants) {
    requested[grant.permission] = grant.scope;
  }
  const check = canAuthorRole(principal.grants, requested);
  if (!check.allowed) {
    throw ceiling(check.refusals);
  }
}

async function assertCustomRole(sql: SqlExecutor, roleId: string): Promise<void> {
  const role = await sql.query<{ is_builtin: boolean }>(
    'SELECT is_builtin FROM roles WHERE id = $1',
    [roleId],
  );
  const found = role.rows[0];
  if (found === undefined) {
    throw notFound();
  }
  if (found.is_builtin) {
    // The database refuses this too. Checking here turns a constraint violation
    // into the typed answer the caller can act on.
    throw new ApiHttpError(409, 'builtin_role_immutable', 'Built-in roles cannot be changed.');
  }
}

async function writeGrants(
  sql: SqlExecutor,
  tenantId: string,
  roleId: string,
  grants: readonly RoleGrantInput[],
): Promise<void> {
  for (const grant of grants) {
    await sql.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope_level)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, roleId, grant.permission, grant.scope],
    );
  }
}

async function insertScopes(
  sql: SqlExecutor,
  tenantId: string,
  membershipId: string,
  scopes: readonly ScopeInput[],
): Promise<void> {
  for (const scope of scopes) {
    await sql.query(
      `INSERT INTO membership_scopes (tenant_id, membership_id, scope_type, scope_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, membershipId, scope.type, scope.id],
    );
  }
}

async function grantsOfRole(sql: SqlExecutor, roleId: string): Promise<GrantMap> {
  const rows = await sql.query<{ permission_key: string; scope_level: ScopeLevel }>(
    'SELECT permission_key, scope_level FROM role_permissions WHERE role_id = $1',
    [roleId],
  );
  const grants: Partial<Record<PermissionKey, ScopeLevel>> = {};
  for (const row of rows.rows) {
    if (isPermissionKey(row.permission_key)) {
      grants[row.permission_key] = row.scope_level;
    }
  }
  return grants;
}

/**
 * A stable key derived from the name, so authorization can be written against
 * a key even for a role a tenant invented. Collisions are refused by the
 * `(tenant_id, key)` unique constraint rather than silently suffixed.
 */
function keyFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug.length === 0 ? 'custom_role' : `custom_${slug}`;
}

async function readPerson(sql: SqlExecutor, membershipId: string): Promise<PersonSummary> {
  const rows = await sql.query<{
    membership_id: string;
    email: string;
    status: string;
    role_id: string;
    role_key: string;
    role_name: string;
  }>(
    `SELECT m.id::text AS membership_id, u.email::text AS email, m.status,
            r.id::text AS role_id, r.key AS role_key, r.name AS role_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
      WHERE m.id = $1`,
    [membershipId],
  );
  const person = requireRow(rows.rows, 'the membership vanished mid-transaction');
  const scopes = await sql.query<{ scope_type: string; scope_id: string | null }>(
    'SELECT scope_type, scope_id::text AS scope_id FROM membership_scopes WHERE membership_id = $1',
    [membershipId],
  );
  return {
    membership_id: person.membership_id,
    email: person.email,
    status: person.status,
    role: { id: person.role_id, key: person.role_key, name: person.role_name },
    scopes: scopes.rows.map((scope) => ({ type: scope.scope_type, id: scope.scope_id })),
  };
}

async function readRole(sql: SqlExecutor, roleId: string): Promise<RoleSummary> {
  const rows = await sql.query<{
    id: string;
    key: string;
    name: string;
    is_builtin: boolean;
  }>('SELECT id::text, key, name, is_builtin FROM roles WHERE id = $1', [roleId]);
  const role = requireRow(rows.rows, 'the role vanished mid-transaction');
  const grants = await sql.query<{ permission_key: string; scope_level: ScopeLevel }>(
    'SELECT permission_key, scope_level FROM role_permissions WHERE role_id = $1 ORDER BY permission_key',
    [roleId],
  );
  return { ...role, grants: grants.rows };
}

async function readTeam(sql: SqlExecutor, teamId: string): Promise<TeamSummary> {
  const rows = await sql.query<{ id: string; name: string; member_count: string }>(
    `SELECT t.id::text, t.name, count(tm.membership_id)::text AS member_count
       FROM teams t
       LEFT JOIN team_members tm ON tm.tenant_id = t.tenant_id AND tm.team_id = t.id
      WHERE t.id = $1
      GROUP BY t.id, t.name`,
    [teamId],
  );
  const team = requireRow(rows.rows, 'the team vanished mid-transaction');
  return { id: team.id, name: team.name, member_count: Number(team.member_count) };
}

interface TransferRow {
  readonly id: string;
  readonly status: OwnershipTransferSummary['status'];
  readonly from_membership: string;
  readonly to_membership: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly settled_at: Date | null;
}

function mapTransfer(row: TransferRow): OwnershipTransferSummary {
  return {
    id: row.id,
    status: row.status,
    from_membership: row.from_membership,
    to_membership: row.to_membership,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    settled_at: row.settled_at === null ? null : row.settled_at.toISOString(),
  };
}

async function readTransfer(sql: SqlExecutor, id: string): Promise<OwnershipTransferSummary> {
  const rows = await sql.query<TransferRow>(
    `SELECT id::text, status, from_membership::text, to_membership::text,
            created_at, expires_at, settled_at
       FROM ownership_transfers WHERE id = $1`,
    [id],
  );
  return mapTransfer(requireRow(rows.rows, 'the ownership transfer vanished mid-transaction'));
}

function invalid(details: readonly { field: string; code: string; message: string }[]): ApiHttpError {
  return new ApiHttpError(400, 'invalid_input', 'The request is not valid.', details);
}

function notFound(): ApiHttpError {
  return new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}

function ceiling(
  refusals: readonly { permission: string; reason: string }[],
): ApiHttpError {
  return new ApiHttpError(
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
