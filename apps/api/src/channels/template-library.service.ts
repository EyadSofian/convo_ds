import { Inject, Injectable } from '@nestjs/common';
import { authorize, defineWhatsAppTemplate } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiHttpError } from '../http-error.js';

interface LibraryRow {
  id: string; connectionId: string; connectionName: string; name: string; language: string;
  category: string; status: string; components: unknown; visibility: 'all' | 'teams'; version: number; teamIds: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TemplateLibraryService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  list(session: AuthenticatedSession, tenantId: string) {
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql, principal }) => {
      const rows = await sql.query<LibraryRow>(`SELECT t.id::text,t.connection_id::text AS "connectionId",n.display_name AS "connectionName",
        t.template_name AS name,t.language,t.category,t.status,t.components,t.visibility,t.access_version AS version,
        coalesce((SELECT array_agg(a.team_id::text ORDER BY a.team_id) FROM whatsapp_template_teams a WHERE a.template_id=t.id),'{}') AS "teamIds"
        FROM whatsapp_templates t JOIN channel_connections n ON n.id=t.connection_id
        WHERE n.disconnected_at IS NULL ORDER BY lower(t.template_name),t.language,t.id`);
      const teams = await sql.query<{ id: string; name: string }>(`SELECT id::text,name FROM teams WHERE archived_at IS NULL ORDER BY lower(name),id`);
      return {
        templates: rows.rows.filter((row) => authorize(principal, 'channel.manage', { inboxId: row.connectionId }).allowed).map((row) => {
          const definition = defineWhatsAppTemplate(row.components);
          const { components, ...safe } = row; void components;
          return { ...safe, body: definition.components.map((part) => part.text ?? '').filter(Boolean).join('\n') };
        }),
        teams: teams.rows,
      };
    });
  }

  async update(session: AuthenticatedSession, tenantId: string, body: unknown) {
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const mode = input['visibility'];
    const teams = input['teamIds'];
    const templates = input['templates'];
    if ((mode !== 'all' && mode !== 'teams') || !Array.isArray(teams) || teams.length > 100 || teams.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      !Array.isArray(templates) || templates.length === 0 || templates.length > 200 || templates.some((item) => item === null || typeof item !== 'object' || !UUID.test(item.id) || !Number.isSafeInteger(item.version) || item.version < 1) ||
      new Set(templates.map((item) => item.id.toLowerCase())).size !== templates.length || new Set(teams.map((id) => id.toLowerCase())).size !== teams.length || (mode === 'teams' && teams.length === 0) || (mode === 'all' && teams.length !== 0)) {
      throw new ApiHttpError(400, 'invalid_input', 'Select 1–200 templates and at least one team, or choose everyone.');
    }
    return this.authorization.authorized(session, tenantId, 'channel.manage', async ({ sql, principal }) => {
      // Deterministic lock order, atomic bulk updates, no silent overwrite of a colleague's changes.
      const ids = templates.map((item) => (item.id as string).toLowerCase()).sort();
      const rows = await sql.query<{ id: string; connection_id: string; access_version: number }>(`SELECT id::text,connection_id::text,access_version FROM whatsapp_templates WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
      if (rows.rows.length !== ids.length) throw new ApiHttpError(404, 'resource_not_found', 'A selected template no longer exists. Reload the library.');
      for (const row of rows.rows) {
        if (!authorize(principal, 'channel.manage', { inboxId: row.connection_id }).allowed) throw new ApiHttpError(403, 'permission_denied', 'You cannot manage templates on this inbox.');
        if (templates.find((item) => item.id.toLowerCase() === row.id).version !== row.access_version) throw new ApiHttpError(409, 'version_conflict', 'Template access changed. Reload the library before saving.');
      }
      const liveTeams = await sql.query(`SELECT id FROM teams WHERE id=ANY($1::uuid[]) AND archived_at IS NULL FOR SHARE`, [teams]);
      if (liveTeams.rows.length !== teams.length) throw new ApiHttpError(400, 'invalid_team', 'A selected team is no longer active. Reload the library.');
      await sql.query(`DELETE FROM whatsapp_template_teams WHERE template_id=ANY($1::uuid[])`, [ids]);
      await sql.query(`INSERT INTO whatsapp_template_teams(tenant_id,template_id,team_id) SELECT $1,t,g FROM unnest($2::uuid[]) t CROSS JOIN unnest($3::uuid[]) g`, [tenantId,ids,teams]);
      await sql.query(`UPDATE whatsapp_templates SET visibility=$2,access_version=access_version+1 WHERE id=ANY($1::uuid[])`, [ids,mode]);
      for (const id of ids) await sql.query(`INSERT INTO admin_audit_events(tenant_id,actor_membership,actor_email,action,subject_type,subject_id,detail) VALUES($1,$2,$3,'template_access.updated','whatsapp_template',$4,$5::jsonb)`, [tenantId,principal.membershipId,session.email,id,JSON.stringify({ visibility: mode, teamIds: teams })]);
      return { updated: ids.length };
    });
  }
}
