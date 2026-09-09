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

export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly member_count: number;
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
      }>('SELECT id::text, key, name, is_builtin FROM roles ORDER BY key');

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
        member_count: string;
      }>(
        `SELECT t.id::text, t.name,
                count(tm.membership_id)::text AS member_count
           FROM teams t
           LEFT JOIN team_members tm ON tm.tenant_id = t.tenant_id AND tm.team_id = t.id
          GROUP BY t.id, t.name
          ORDER BY t.name`,
      );
      return teams.rows.map((team) => ({
        id: team.id,
        name: team.name,
        member_count: Number(team.member_count),
      }));
    });
  }
}
