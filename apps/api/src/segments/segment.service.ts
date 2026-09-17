import { Inject, Injectable } from '@nestjs/common';
import type { ConditionDocument, PermissionKey, Principal, SqlExecutor } from '@convo/domain';
import { reachFor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import type { AudienceInput, SavedViewInput, ViewResource, ViewVisibility } from './segment-request.js';

export interface SavedView {
  readonly id: string;
  readonly ownerMembershipId: string;
  readonly teamId: string | null;
  readonly name: string;
  readonly resource: ViewResource;
  readonly visibility: ViewVisibility;
  readonly conditions: ConditionDocument;
  readonly version: number;
}

export interface Audience {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly conditions: ConditionDocument;
  readonly state: 'active' | 'retired';
  readonly version: number;
}

interface RawView {
  readonly id: string; readonly owner_membership_id: string; readonly team_id: string | null;
  readonly name: string; readonly resource: ViewResource; readonly visibility: ViewVisibility;
  readonly conditions: ConditionDocument; readonly version: number;
}
interface RawAudience {
  readonly id: string; readonly name: string; readonly description: string | null;
  readonly conditions: ConditionDocument; readonly state: 'active' | 'retired'; readonly version: number;
}

@Injectable()
export class SegmentService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  listViews(session: AuthenticatedSession, tenantId: string, resource: ViewResource): Promise<readonly SavedView[]> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      requireGrant(principal, readPermission(resource));
      // The membership_scopes constraint makes an id mandatory for team
      // scopes; tenant is the only scope allowed to carry null.
      const teams = principal.scopes.flatMap((scope) => scope.type === 'team' ? [scope.id as string] : []);
      const rows = await sql.query<RawView>(
        `SELECT id::text,owner_membership_id::text,team_id::text,name,resource,visibility,conditions,version
           FROM saved_views
          WHERE resource=$1 AND state='active' AND
                (owner_membership_id=$2 OR visibility='workspace' OR
                 (visibility='team' AND team_id=ANY($3::uuid[])))
          ORDER BY lower(name),id`,
        [resource, principal.membershipId, teams],
      );
      return rows.rows.map(viewOf);
    });
  }

  createView(session: AuthenticatedSession, tenantId: string, input: SavedViewInput): Promise<SavedView> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      requireGrant(principal, input.visibility === 'private' ? readPermission(input.resource) : 'catalog.manage');
      if (input.visibility === 'team') {
        await requireTeam(sql, input.teamId as string);
      }
      const rows = await sql.query<RawView>(
        `INSERT INTO saved_views(tenant_id,owner_membership_id,team_id,name,resource,visibility,conditions)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         RETURNING id::text,owner_membership_id::text,team_id::text,name,resource,visibility,conditions,version`,
        [tenantId, principal.membershipId, input.teamId, input.name, input.resource, input.visibility, JSON.stringify(input.conditions)],
      );
      return viewOf(requireRow(rows.rows, 'saved view insert returned no row'));
    });
  }

  updateView(session: AuthenticatedSession, tenantId: string, id: string, version: number, input: SavedViewInput): Promise<SavedView> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const existing = await viewRow(sql, id);
      requireViewOwnerOrManager(principal, existing);
      if (input.visibility === 'team') {
        await requireTeam(sql, input.teamId as string);
      }
      const rows = await sql.query<RawView>(
        `UPDATE saved_views SET team_id=$3,name=$4,resource=$5,visibility=$6,conditions=$7::jsonb,
                 version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND state='active'
          RETURNING id::text,owner_membership_id::text,team_id::text,name,resource,visibility,conditions,version`,
        [id, version, input.teamId, input.name, input.resource, input.visibility, JSON.stringify(input.conditions)],
      );
      return viewOf(versioned(rows.rows, 'saved_view_version_conflict'));
    });
  }

  retireView(session: AuthenticatedSession, tenantId: string, id: string, version: number): Promise<void> {
    return this.authorization.withPrincipal(session, tenantId, async ({ sql, principal }) => {
      const existing = await viewRow(sql, id);
      requireViewOwnerOrManager(principal, existing);
      const result = await sql.query(`UPDATE saved_views SET state='retired',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND state='active'`, [id, version]);
      if (result.rowCount !== 1) throw conflict('saved_view_version_conflict');
    });
  }

  listAudiences(session: AuthenticatedSession, tenantId: string): Promise<readonly Audience[]> {
    return this.authorization.authorized(session, tenantId, 'campaign.read', async ({ sql }) => {
      const rows = await sql.query<RawAudience>(`SELECT id::text,name,description,conditions,state,version FROM audiences WHERE state='active' ORDER BY lower(name),id`);
      return rows.rows.map(audienceOf);
    });
  }

  createAudience(session: AuthenticatedSession, tenantId: string, input: AudienceInput): Promise<Audience> {
    return this.authorization.authorized(session, tenantId, 'campaign.draft', ({ sql, principal }) =>
      unlessConstraint('audiences_name_uq', conflict('audience_exists'), async () => {
        const rows = await sql.query<RawAudience>(
          `INSERT INTO audiences(tenant_id,name,description,conditions,created_by_membership_id,updated_by_membership_id)
           VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING id::text,name,description,conditions,state,version`,
          [tenantId, input.name, input.description, JSON.stringify(input.conditions), principal.membershipId],
        );
        return audienceOf(requireRow(rows.rows, 'audience insert returned no row'));
      }),
    );
  }

  updateAudience(session: AuthenticatedSession, tenantId: string, id: string, version: number, input: AudienceInput): Promise<Audience> {
    return this.authorization.authorized(session, tenantId, 'campaign.draft', ({ sql, principal }) =>
      unlessConstraint('audiences_name_uq', conflict('audience_exists'), async () => {
        const rows = await sql.query<RawAudience>(
          `UPDATE audiences SET name=$3,description=$4,conditions=$5::jsonb,updated_by_membership_id=$6,
                   version=version+1,updated_at=now()
            WHERE id=$1 AND version=$2 AND state='active'
            RETURNING id::text,name,description,conditions,state,version`,
          [id, version, input.name, input.description, JSON.stringify(input.conditions), principal.membershipId],
        );
        return audienceOf(versioned(rows.rows, 'audience_version_conflict'));
      }),
    );
  }

  retireAudience(session: AuthenticatedSession, tenantId: string, id: string, version: number): Promise<void> {
    return this.authorization.authorized(session, tenantId, 'campaign.draft', async ({ sql, principal }) => {
      const result = await sql.query(
        `UPDATE audiences SET state='retired',updated_by_membership_id=$3,version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND state='active'`,
        [id, version, principal.membershipId],
      );
      if (result.rowCount !== 1) throw conflict('audience_version_conflict');
    });
  }
}

function readPermission(resource: ViewResource): PermissionKey { return resource === 'contacts' ? 'contact.read' : 'conversation.read'; }
function requireGrant(principal: Principal, permission: PermissionKey): void { if (reachFor(principal, permission) === 'none') throw denied(); }
function requireViewOwnerOrManager(principal: Principal, view: RawView): void {
  if (view.owner_membership_id === principal.membershipId && view.visibility === 'private') return;
  requireGrant(principal, 'catalog.manage');
}
async function viewRow(sql: SqlExecutor, id: string): Promise<RawView> {
  const rows = await sql.query<RawView>(`SELECT id::text,owner_membership_id::text,team_id::text,name,resource,visibility,conditions,version FROM saved_views WHERE id=$1 AND state='active'`, [id]);
  const row = rows.rows[0];
  if (row === undefined) throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
  return row;
}
async function requireTeam(sql: SqlExecutor, id: string): Promise<void> {
  const rows = await sql.query<{ found: boolean }>('SELECT true AS found FROM teams WHERE id=$1 AND archived_at IS NULL', [id]);
  if (rows.rows[0] === undefined) throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
}
function viewOf(row: RawView): SavedView { return { id: row.id, ownerMembershipId: row.owner_membership_id, teamId: row.team_id, name: row.name, resource: row.resource, visibility: row.visibility, conditions: row.conditions, version: row.version }; }
function audienceOf(row: RawAudience): Audience { return { id: row.id, name: row.name, description: row.description, conditions: row.conditions, state: row.state, version: row.version }; }
function versioned<T>(rows: readonly T[], code: string): T { const row = rows[0]; if (row === undefined) throw conflict(code); return row; }
function denied(): ApiHttpError { return new ApiHttpError(403, 'permission_denied', 'You do not have permission to perform this action.'); }
function conflict(code: string): ApiHttpError { return new ApiHttpError(409, code, 'The resource changed or conflicts with an existing resource.'); }
