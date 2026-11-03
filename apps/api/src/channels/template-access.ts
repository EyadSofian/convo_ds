import type { Principal, SqlExecutor } from '@convo/domain';
import { ApiHttpError } from '../http-error.js';

/** Roles with tenant-wide channel administration may use every template. */
export function templateAccessPredicate(principal: Principal, add: (value: unknown) => string, alias = 'whatsapp_templates'): string {
  if (principal.grants['channel.manage'] === 'tenant') return 'TRUE';
  const member = add(principal.membershipId);
  return `(${alias}.visibility='all' OR EXISTS (
    SELECT 1 FROM whatsapp_template_teams access
    JOIN team_members tm ON tm.tenant_id=access.tenant_id AND tm.team_id=access.team_id
    JOIN teams team ON team.id=tm.team_id AND team.archived_at IS NULL
    WHERE access.template_id=${alias}.id AND tm.membership_id=${member}))`;
}

export async function requireTemplateAccess(sql: SqlExecutor, principal: Principal, templateId: string): Promise<void> {
  const values: unknown[] = [templateId];
  const predicate = templateAccessPredicate(principal, (value) => { values.push(value); return `$${values.length}`; });
  const found = await sql.query<{ allowed: boolean }>(`SELECT (${predicate}) AS allowed FROM whatsapp_templates WHERE id=$1`, values);
  if (found.rows[0]?.allowed === false) throw new ApiHttpError(403, 'template_access_denied', 'This template is not available to your team. Choose another template.');
}
