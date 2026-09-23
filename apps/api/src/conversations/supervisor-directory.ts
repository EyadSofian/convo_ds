import type { Principal, SqlExecutor } from '@convo/domain';
import { reachFor } from '@convo/domain';
import { readableScope } from './inbox-query-compiler.js';
import { ApiHttpError } from '../http-error.js';

export interface ScopedSupervisorAgent {
  readonly membershipId: string;
  readonly name: string;
  readonly email: string;
  readonly teams: readonly string[];
}

/** A supervisor is a reader with a scope wider than their own work. */
export function assertSupervisor(principal: Principal): void {
  const reach = reachFor(principal, 'conversation.read');
  if (reach === 'none' || reach === 'own') throw new ApiHttpError(403, 'permission_denied', 'This action is not allowed.');
}

/**
 * One canonical staff directory for all supervisor products. It starts from
 * the caller's principal and never evaluates the selected member's grants.
 */
export async function scopedSupervisorAgents(sql: SqlExecutor, principal: Principal): Promise<readonly ScopedSupervisorAgent[]> {
  assertSupervisor(principal);
  return scopedAgents(sql, principal);
}

/** Report readers with own-only Inbox reach can inspect only themselves. */
export async function scopedReportableAgents(sql: SqlExecutor, principal: Principal): Promise<readonly ScopedSupervisorAgent[]> {
  if (reachFor(principal, 'conversation.read') === 'own') {
    const rows = await sql.query<{ membership_id: string; name: string; email: string; teams: readonly string[] }>(
      `SELECT m.id::text AS membership_id,m.display_name AS name,u.email::text AS email,
              coalesce(array_agg(DISTINCT t.name) FILTER (WHERE t.archived_at IS NULL), '{}') AS teams
         FROM memberships m JOIN users u ON u.id=m.user_id
         JOIN role_permissions read_grant ON read_grant.role_id=m.role_id AND read_grant.permission_key='conversation.read'
         LEFT JOIN team_members tm ON tm.membership_id=m.id LEFT JOIN teams t ON t.id=tm.team_id
        WHERE m.id=$1::uuid AND m.status='active' GROUP BY m.id,m.display_name,u.email`, [principal.membershipId],
    );
    return rows.rows.map((row) => ({ membershipId: row.membership_id, name: row.name, email: row.email, teams: row.teams }));
  }
  if (reachFor(principal, 'conversation.read') === 'none') return [];
  return scopedAgents(sql, principal);
}

/** Teams whose identity is visible under the caller's own Inbox scope. */
export async function scopedReportableTeams(sql: SqlExecutor, principal: Principal): Promise<readonly { readonly teamId: string; readonly name: string }[]> {
  const tenantReach = principal.grants['conversation.read'] === 'tenant' || principal.scopes.some((entry) => entry.type === 'tenant');
  if (tenantReach) {
    const rows = await sql.query<{ team_id: string; name: string }>(
      'SELECT id::text AS team_id,name FROM teams WHERE archived_at IS NULL ORDER BY lower(name),id',
    );
    return rows.rows.map((row) => ({ teamId: row.team_id, name: row.name }));
  }
  const values: unknown[] = [];
  const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const scope = readableScope(principal, add);
  const rows = await sql.query<{ team_id: string; name: string }>(
    `SELECT t.id::text AS team_id,t.name FROM teams t
      WHERE t.archived_at IS NULL AND EXISTS (SELECT 1 FROM conversations c WHERE c.team_id=t.id AND ${scope})
      ORDER BY lower(t.name),t.id`, values,
  );
  return rows.rows.map((row) => ({ teamId: row.team_id, name: row.name }));
}

async function scopedAgents(sql: SqlExecutor, principal: Principal): Promise<readonly ScopedSupervisorAgent[]> {
  const values: unknown[] = [];
  const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const scope = readableScope(principal, add);
  const teams = principal.scopes.filter((entry) => entry.type === 'team').map((entry) => entry.id);
  const inboxes = principal.scopes.filter((entry) => entry.type === 'inbox').map((entry) => entry.id);
  const tenantReach = principal.grants['conversation.read'] === 'tenant' || principal.scopes.some((entry) => entry.type === 'tenant');
  const relationship = tenantReach ? 'TRUE' : `(
    EXISTS (SELECT 1 FROM team_members agent_team WHERE agent_team.membership_id=m.id AND agent_team.team_id=ANY(${add(teams)}::uuid[]))
    OR EXISTS (SELECT 1 FROM membership_scopes agent_inbox WHERE agent_inbox.membership_id=m.id AND agent_inbox.scope_type='inbox' AND agent_inbox.scope_id=ANY(${add(inboxes)}::uuid[]))
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.assignee_membership_id=m.id AND c.status <> 'archived' AND ${scope})
  )`;
  const rows = await sql.query<{ membership_id: string; name: string; email: string; teams: readonly string[] }>(
    `SELECT m.id::text AS membership_id, m.display_name AS name, u.email::text AS email,
            coalesce(array_agg(DISTINCT t.name) FILTER (WHERE t.archived_at IS NULL), '{}') AS teams
       FROM memberships m JOIN users u ON u.id=m.user_id
       JOIN role_permissions read_grant ON read_grant.role_id=m.role_id AND read_grant.permission_key='conversation.read'
       LEFT JOIN team_members tm ON tm.membership_id=m.id
       LEFT JOIN teams t ON t.id=tm.team_id
      WHERE m.status='active' AND ${relationship}
      GROUP BY m.id,m.display_name,u.email ORDER BY lower(m.display_name),m.id`, values,
  );
  return rows.rows.map((row) => ({ membershipId: row.membership_id, name: row.name, email: row.email, teams: row.teams }));
}

export async function requireScopedSupervisorAgent(sql: SqlExecutor, principal: Principal, membershipId: string): Promise<ScopedSupervisorAgent> {
  const found = (await scopedSupervisorAgents(sql, principal)).find((agent) => agent.membershipId === membershipId);
  if (found === undefined) throw new ApiHttpError(404, 'resource_not_found', 'The selected agent is not available in this supervisor scope.');
  return found;
}
