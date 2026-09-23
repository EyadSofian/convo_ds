import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { nextScheduledAt, type AutomationWorkflow, type PermissionKey, type ScheduleDefinition, type SqlExecutor } from '@convo/domain';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { ApiHttpError } from '../http-error.js';
import { unlessConstraint } from '../pg-error.js';
import { requireRow } from '../require-row.js';
import { OpaqueCursorCodec } from '../pagination.js';
import { API_CONFIG } from '../tokens.js';
import type { AutomationInput, AutomationListQuery, AutomationRunsQuery } from './automation-request.js';

export interface AutomationTemplate { readonly key: string; readonly category: string; readonly name: string; readonly description: string; readonly preset: AutomationWorkflow }
export interface WhatsAppAutomationTemplate {readonly id:string;readonly connectionId:string;readonly providerTemplateId:string;readonly templateName:string;readonly language:string;readonly category:string;readonly status:string;readonly components:readonly unknown[];readonly variables:readonly string[];readonly lastSyncedAt:string}
export interface AutomationRecord { readonly id: string; readonly name: string; readonly description: string | null; readonly templateKey: string | null; readonly state: 'draft'|'active'|'paused'|'archived'; readonly workflow: AutomationWorkflow; readonly timezone: string; readonly nextRunAt: string|null; readonly lastRunAt: string|null; readonly version: number }
interface RawAutomation { readonly id:string; readonly name:string; readonly description:string|null; readonly template_key:string|null; readonly state:AutomationRecord['state']; readonly workflow:AutomationWorkflow; readonly timezone:string; readonly next_run_at:string|null; readonly last_run_at:string|null; readonly version:number }
export interface AutomationPage { readonly items: readonly AutomationRecord[]; readonly nextCursor: string | null; }
export interface AutomationRunsPage { readonly items: readonly unknown[]; readonly nextCursor: string | null; }

@Injectable()
export class AutomationService {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService,@Inject(API_CONFIG) private readonly config: ApiConfig) {}
  templates(session: AuthenticatedSession, tenantId: string): Promise<readonly AutomationTemplate[]> { return this.authorization.authorized(session,tenantId,'automation.read',async({sql}) => (await sql.query<AutomationTemplate>(`SELECT key,category,name,description,preset FROM automation_templates WHERE state='active' ORDER BY category,name`)).rows); }
  whatsappTemplates(session:AuthenticatedSession,tenantId:string):Promise<readonly WhatsAppAutomationTemplate[]>{return this.authorization.authorized(session,tenantId,'automation.read',async({sql})=>(await sql.query<WhatsAppAutomationTemplate>(`SELECT id::text,connection_id::text AS "connectionId",provider_template_id AS "providerTemplateId",template_name AS "templateName",language,category,status,components,variables,last_synced_at::text AS "lastSyncedAt" FROM whatsapp_templates WHERE status='approved' ORDER BY lower(template_name),language,id`)).rows);}
  list(session: AuthenticatedSession, tenantId: string, query: AutomationListQuery): Promise<AutomationPage> { return this.authorization.authorized(session,tenantId,'automation.read',async({sql}) => {
    const binding = pageBinding(tenantId, query, 'automations'); const codec = new OpaqueCursorCodec(this.config.secrets.idempotencyHash);
    const decoded = decode(codec, query.cursor, binding); const values: unknown[] = []; const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    // Archived definitions stay out of the operational default, but a caller
    // that deliberately filters for them can review durable history.
    const terms: string[] = query.state === null ? ["state <> 'archived'"] : [`state = ${add(query.state)}`];
    if (query.search !== null) terms.push(`lower(name) LIKE ${add(`%${escapeLike(query.search.toLowerCase())}%`)} ESCAPE '\\'`);
    const sort = automationSort(query.sort); if (decoded !== null) terms.push(cursorCondition(sort, add(decoded.value), add(decoded.id)));
    const rows = await sql.query<RawAutomation & { cursor_value: string }>(`SELECT ${COLUMNS}, ${sort.cursor} AS cursor_value FROM automations WHERE ${terms.join(' AND ')} ORDER BY ${sort.order} LIMIT ${add(query.limit + 1)}`, values);
    const page = rows.rows.slice(0, query.limit); const last = page.at(-1);
    return { items: page.map(of), nextCursor: rows.rows.length > query.limit && last !== undefined ? codec.encode(binding, { value: last.cursor_value, id: last.id }, 900) : null };
  }); }
  runs(session: AuthenticatedSession, tenantId: string, query: AutomationRunsQuery): Promise<AutomationRunsPage> { return this.authorization.authorized(session,tenantId,'automation.read',async({sql}) => {
    const binding = pageBinding(tenantId, query, 'automation-runs'); const codec = new OpaqueCursorCodec(this.config.secrets.idempotencyHash); const decoded = decode(codec, query.cursor, binding);
    const values: unknown[] = []; const add = (value: unknown): string => { values.push(value); return `$${values.length}`; }; const terms: string[] = [];
    if (decoded !== null) terms.push(`(scheduled_for,id) < (${add(decoded.value)}::timestamptz,${add(decoded.id)}::uuid)`);
    const rows = await sql.query<Record<string, unknown> & { id: string; cursor_value: string }>(`SELECT id::text,automation_id::text,status,mode,scheduled_for,started_at,completed_at,trigger_type,audience_count,queued_count,sent_count,delivered_count,failed_count,skipped_count,error,scheduled_for::text AS cursor_value FROM automation_runs ${terms.length === 0 ? '' : `WHERE ${terms.join(' AND ')}`} ORDER BY scheduled_for DESC,id DESC LIMIT ${add(query.limit + 1)}`, values);
    const page = rows.rows.slice(0, query.limit); const last = page.at(-1); return { items: page.map((row) => { const { cursor_value, ...run } = row; void cursor_value; return run; }), nextCursor: rows.rows.length > query.limit && last !== undefined ? codec.encode(binding, { value: last.cursor_value, id: last.id }, 900) : null };
  }); }
  create(session: AuthenticatedSession, tenantId:string, input:AutomationInput):Promise<AutomationRecord>{ return this.authorization.authorized(session,tenantId,'automation.create',({sql,principal})=>unlessConstraint('automations_name_uq',conflict('automation_exists'),async()=>{ const rows=await sql.query<RawAutomation>(`INSERT INTO automations(tenant_id,name,description,template_key,workflow,timezone,created_by_membership_id,updated_by_membership_id) VALUES($1,$2,$3,NULL,$4::jsonb,$5,$6,$6) RETURNING ${COLUMNS}`,[tenantId,input.name,input.description,JSON.stringify(input.workflow),input.timezone,principal.membershipId]); return of(requireRow(rows.rows,'automation insert returned no row'));})); }
  async fromTemplate(session:AuthenticatedSession,tenantId:string,key:string,name:string):Promise<AutomationRecord>{ return this.authorization.authorized(session,tenantId,'automation.create',async({sql,principal})=>{ const source=await template(sql,key); return unlessConstraint('automations_name_uq',conflict('automation_exists'),async()=>of(requireRow((await sql.query<RawAutomation>(`INSERT INTO automations(tenant_id,name,description,template_key,workflow,timezone,created_by_membership_id,updated_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,'UTC',$6,$6) RETURNING ${COLUMNS}`,[tenantId,name,source.description,key,JSON.stringify(source.preset),principal.membershipId])).rows,'automation insert returned no row'))); }); }
  update(session:AuthenticatedSession,tenantId:string,id:string,version:number,input:AutomationInput):Promise<AutomationRecord>{ return this.authorization.authorized(session,tenantId,'automation.edit',async({sql,principal})=>{ const rows=await sql.query<RawAutomation>(`UPDATE automations SET name=$3,description=$4,workflow=$5::jsonb,timezone=$6,updated_by_membership_id=$7,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND state IN ('draft','paused') RETURNING ${COLUMNS}`,[id,version,input.name,input.description,JSON.stringify(input.workflow),input.timezone,principal.membershipId]); return of(versioned(rows.rows)); }); }
  transition(session:AuthenticatedSession,tenantId:string,id:string,version:number,act:'activate'|'pause'|'resume'|'archive'):Promise<AutomationRecord>{ const permission:PermissionKey=act==='activate'||act==='resume'?'automation.activate':'automation.pause'; return this.authorization.authorized(session,tenantId,permission,async({sql,principal})=>{ const existing=await row(sql,id); const next=transition(existing.state,act); if(next==='active') await validateTemplates(sql,existing.workflow); const nextRun=next==='active'?scheduledStart(existing.workflow,existing.timezone):null; const rows=await sql.query<RawAutomation>(`UPDATE automations SET state=$3,activated_by_membership_id=CASE WHEN $3='active' THEN $4 ELSE activated_by_membership_id END,activated_at=CASE WHEN $3='active' THEN now() ELSE activated_at END,next_run_at=$5,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING ${COLUMNS}`,[id,version,next,principal.membershipId,nextRun]); const updated=of(versioned(rows.rows));await scheduleQueue(sql,tenantId,id,nextRun);return updated; }); }
  deleteDraft(session: AuthenticatedSession, tenantId: string, id: string, version: number): Promise<{ readonly id: string }> { return this.authorization.authorized(session, tenantId, 'automation.edit', async ({ sql }) => {
    const existing = await rowForUpdate(sql, id);
    if (existing.state !== 'draft') throw new ApiHttpError(409, 'automation_not_deletable_in_state', 'Only a draft automation without execution history can be deleted.');
    if (existing.version !== version) throw conflict('automation_version_conflict');
    const history = await sql.query<{ id: string }>('SELECT id::text FROM automation_runs WHERE automation_id=$1 LIMIT 1', [id]);
    if (history.rows[0] !== undefined) throw new ApiHttpError(409, 'automation_has_execution_history', 'An automation with execution history cannot be deleted.');
    await sql.query('DELETE FROM automation_schedule_queue WHERE tenant_id=$1 AND automation_id=$2', [tenantId, id]);
    const deleted = await sql.query<{ id: string }>("DELETE FROM automations WHERE id=$1 AND version=$2 AND state='draft' RETURNING id::text", [id, version]);
    if (deleted.rows[0] === undefined) throw conflict('automation_version_conflict'); return { id };
  }); }
}
const COLUMNS=`id::text,name,description,template_key,state,workflow,timezone,next_run_at::text,last_run_at::text,version`; const SELECT=`SELECT ${COLUMNS} FROM automations`;
function of(r:RawAutomation):AutomationRecord{return{id:r.id,name:r.name,description:r.description,templateKey:r.template_key,state:r.state,workflow:r.workflow,timezone:r.timezone,nextRunAt:r.next_run_at,lastRunAt:r.last_run_at,version:r.version};}
async function template(sql:SqlExecutor,key:string):Promise<AutomationTemplate>{const r=(await sql.query<AutomationTemplate>(`SELECT key,category,name,description,preset FROM automation_templates WHERE key=$1 AND state='active'`,[key])).rows[0];if(r===undefined)throw new ApiHttpError(404,'resource_not_found','The automation template does not exist.');return r;}
async function row(sql:SqlExecutor,id:string):Promise<RawAutomation>{const r=(await sql.query<RawAutomation>(`${SELECT} WHERE id=$1`,[id])).rows[0];if(r===undefined)throw new ApiHttpError(404,'resource_not_found','The automation does not exist.');return r;}
async function rowForUpdate(sql:SqlExecutor,id:string):Promise<RawAutomation>{const r=(await sql.query<RawAutomation>(`${SELECT} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(r===undefined)throw new ApiHttpError(404,'resource_not_found','The automation does not exist.');return r;}
function transition(state:AutomationRecord['state'],act:string):AutomationRecord['state']{const key=`${state}:${act}`;const next:Record<string,AutomationRecord['state']>={'draft:activate':'active','paused:resume':'active','active:pause':'paused','draft:archive':'archived','paused:archive':'archived'};const value=next[key];if(value===undefined)throw conflict('automation_transition_refused');return value;}
async function validateTemplates(sql:SqlExecutor,workflow:AutomationWorkflow):Promise<void>{for(const step of workflow.steps){if(step.type!=='send_whatsapp_template')continue;const id=step.config['templateId'];if(typeof id!=='string')throw new ApiHttpError(409,'automation_template_required','Choose an approved WhatsApp template before activation.');const found=(await sql.query<{variables:readonly string[]}>(`SELECT variables FROM whatsapp_templates WHERE id=$1 AND status='approved'`,[id])).rows[0];if(found===undefined)throw new ApiHttpError(409,'automation_template_unavailable','The selected WhatsApp template is not approved or available.');const mapping=step.config['variableMapping'];if(typeof mapping!=='object'||mapping===null||found.variables.some((variable)=>!Object.hasOwn(mapping,variable)))throw new ApiHttpError(409,'automation_variables_incomplete','Map every required WhatsApp template variable before activation.');}}
function versioned<T>(rows:readonly T[]):T{const r=rows[0];if(r===undefined)throw conflict('automation_version_conflict');return r;} function conflict(code:string):ApiHttpError{return new ApiHttpError(409,code,'The automation changed or the requested transition is not allowed.');}
/**
 * The first instant an automation should run, or null when it is not scheduled.
 *
 * Written out rather than on one line because one of its guards cannot be
 * reached and that needs to be visible: `validateAutomationWorkflow` already
 * refuses a schedule trigger with no schedule, so by the time a workflow gets
 * here the two always agree. The guard stays because it is the invariant this
 * function depends on, and a future caller that skips validation should get a
 * typed 409 rather than a `TypeError` from inside `nextScheduledAt`.
 */
function scheduledStart(workflow: AutomationWorkflow, timezone: string): Date | null {
  if (workflow.trigger.type !== 'schedule') {
    return null;
  }
  const schedule = workflow.schedule as ScheduleDefinition | undefined;
  /* c8 ignore next 3 -- validateAutomationWorkflow rejects this combination first */
  if (schedule === undefined) {
    throw new ApiHttpError(409, 'automation_schedule_required', 'Configure the schedule before activation.');
  }
  const next = nextScheduledAt(schedule, new Date(), timezone);
  if (next === null) {
    throw new ApiHttpError(409, 'automation_schedule_exhausted', 'The schedule has no future execution time.');
  }
  return next;
}
async function scheduleQueue(sql:SqlExecutor,tenantId:string,id:string,due:Date|null):Promise<void>{if(due===null){await sql.query(`DELETE FROM automation_schedule_queue WHERE tenant_id=$1 AND automation_id=$2`,[tenantId,id]);return;}await sql.query(`INSERT INTO automation_schedule_queue(tenant_id,automation_id,due_at) VALUES($1,$2,$3) ON CONFLICT(tenant_id,automation_id) DO UPDATE SET due_at=excluded.due_at`,[tenantId,id,due]);}
function pageBinding(tenantId: string, query: unknown, sort: string) { const stable = { ...(query as Record<string, unknown>) }; delete stable['cursor']; return { tenantId, filterHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'), sort }; }
function decode(codec: OpaqueCursorCodec, cursor: string | null, binding: ReturnType<typeof pageBinding>) { if (cursor === null) return null; const result = codec.decode(cursor, binding); if (result.status === 'rejected') throw new ApiHttpError(400, result.code, result.message); return result.after; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }
function automationSort(sort: AutomationListQuery['sort']) { if (sort === 'name_desc') return { cursor: 'lower(name)', order: 'lower(name) DESC, id DESC', direction: '<' as const }; if (sort === 'updated_desc') return { cursor: 'updated_at::text', order: 'updated_at DESC, id DESC', direction: '<' as const }; return { cursor: 'lower(name)', order: 'lower(name) ASC, id ASC', direction: '>' as const }; }
function cursorCondition(sort: ReturnType<typeof automationSort>, value: string, id: string): string { return sort.direction === '>' ? `(${sort.cursor},id) > (${value},${id}::uuid)` : `(${sort.cursor},id) < (${value},${id}::uuid)`; }
