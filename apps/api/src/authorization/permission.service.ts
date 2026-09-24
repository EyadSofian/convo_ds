import { Inject, Injectable } from '@nestjs/common';
import type { ScopeLevel } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from './authorization.service.js';

export interface PermissionDescriptor {
  readonly key: string;
  readonly description: string;
  readonly delegable: boolean;
}

export interface RoleSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly is_builtin: boolean;
  /** What the role is for, as its author wrote it. Empty for built-ins. */
  readonly description: string;
  /** When the role's name, description or grants last changed. */
  readonly updated_at: string;
  /** Grants by key with the scope each reaches. Denial is an absent key. */
  readonly grants: readonly { readonly permission_key: string; readonly scope_level: ScopeLevel }[];
}

export interface PersonSummary {
  readonly membership_id: string;
  readonly email: string;
  readonly status: string;
  readonly role: { readonly id: string; readonly key: string; readonly name: string };
  readonly scopes: readonly { readonly type: string; readonly id: string | null }[];
}

export interface TeamMember {
  readonly membership_id: string;
  readonly email: string;
}

export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly member_count: number;
  readonly archived: boolean;
  /**
   * Who is in the team. Returned with the team rather than behind a second
   * endpoint because a count alone gives an administrator no way to see or
   * undo a membership they just added.
   */
  readonly members: readonly TeamMember[];
}

/**
 * Read models for the People, Roles and Teams screens.
 *
 * Every method goes through `AuthorizationService.authorized`, so the decision
 * is made by permission key in one place. None of these methods knows what a
 * role is called.
 */
@Injectable()
export class PermissionService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  async listCatalogue(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly PermissionDescriptor[]> {
    return this.authorization.authorized(session, tenantId, 'role.manage', async ({ sql }) => {
      const permissions = await sql.query<PermissionDescriptor>(
        'SELECT key, description, delegable FROM permissions ORDER BY key',
      );
      return permissions.rows;
    });
  }

  /**
   * The tenant's roles with their grants — the data behind an effective-access
   * preview. Requires `role.manage`: knowing exactly what every role can do is
   * itself administrative information.
   */
  async listRoles(session: AuthenticatedSession, tenantId: string): Promise<readonly RoleSummary[]> {
    return this.authorization.authorized(session, tenantId, 'role.manage', async ({ sql }) => {
      const roles = await sql.query<{
        id: string;
        key: string;
        name: string;
        is_builtin: boolean;
        description: string;
        updated_at: string;
      }>(
        `SELECT id::text, key, name, is_builtin, description,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
           FROM roles ORDER BY key`,
      );

      const grants = await sql.query<{
        role_id: string;
        permission_key: string;
        scope_level: ScopeLevel;
      }>(
        `SELECT role_id::text, permission_key, scope_level
           FROM role_permissions ORDER BY role_id, permission_key`,
      );

      return roles.rows.map((role) => ({
        ...role,
        grants: grants.rows
          .filter((grant) => grant.role_id === role.id)
          .map((grant) => ({ permission_key: grant.permission_key, scope_level: grant.scope_level })),
      }));
    });
  }

  /**
   * The people in this tenant. Requires `member.manage`.
   *
   * Only the membership's own fields and the identity's email are returned:
   * this is an administrative list, not a directory of everything known about
   * a person.
   */
  async listPeople(
    session: AuthenticatedSession,
    tenantId: string,
  ): Promise<readonly PersonSummary[]> {
    return this.authorization.authorized(session, tenantId, 'member.manage', async ({ sql }) => {
      const people = await sql.query<{
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
          ORDER BY u.email`,
      );

      const scopes = await sql.query<{
        membership_id: string;
        scope_type: string;
        scope_id: string | null;
      }>(
        `SELECT membership_id::text, scope_type, scope_id::text AS scope_id
           FROM membership_scopes ORDER BY membership_id, scope_type`,
      );

      return people.rows.map((person) => ({
        membership_id: person.membership_id,
        email: person.email,
        status: person.status,
        role: { id: person.role_id, key: person.role_key, name: person.role_name },
        scopes: scopes.rows
          .filter((scope) => scope.membership_id === person.membership_id)
          .map((scope) => ({ type: scope.scope_type, id: scope.scope_id })),
      }));
    });
  }

  /**
   * Teams in this tenant. Requires `member.manage` — team composition decides
   * who sees which work, so it is a membership-administration question.
   */
  async listTeams(session: AuthenticatedSession, tenantId: string): Promise<readonly TeamSummary[]> {
    return this.authorization.authorized(session, tenantId, 'member.manage', async ({ sql }) => {
      const teams = await sql.query<{
        id: string;
        name: string;
        archived: boolean;
      }>(
        `SELECT t.id::text, t.name, (t.archived_at IS NOT NULL) AS archived
           FROM teams t
          ORDER BY (t.archived_at IS NOT NULL), t.name`,
      );
      // One query for every team's members rather than one per team: the list
      // is small, but a per-row query is how a screen with twenty teams starts
      // taking a second to open.
      const members = await sql.query<{ team_id: string; membership_id: string; email: string }>(
        `SELECT tm.team_id::text, tm.membership_id::text, u.email
           FROM team_members tm
           JOIN memberships m ON m.id = tm.membership_id
           JOIN users u ON u.id = m.user_id
          ORDER BY u.email`,
      );
      return teams.rows.map((team) => {
        const own = members.rows.filter((member) => member.team_id === team.id);
        return {
          id: team.id,
          name: team.name,
          member_count: own.length,
          archived: team.archived,
          members: own.map((member) => ({
            membership_id: member.membership_id,
            email: member.email,
          })),
        };
      });
    });
  }
}
