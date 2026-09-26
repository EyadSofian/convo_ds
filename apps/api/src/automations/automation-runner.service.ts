import { Inject, Injectable } from '@nestjs/common';
import { asExecutor, withTenant } from '@convo/database';
import { filterFromConditions, filterParts, nextScheduledAt, normalizeSearchText, parseTemplateBindings, type AutomationStep, type AutomationTrigger, type AutomationWorkflow, type ConditionDocument, type ScheduleDefinition, type SqlExecutor } from '@convo/domain';
import type { Pool } from 'pg';
import { prepareTemplate, templateValuesFor } from '../channels/template-send.js';
import { API_POOL } from '../tokens.js';

interface DueAutomation { readonly id:string; readonly workflow:AutomationWorkflow; readonly timezone:string; readonly next_run_at:Date }
interface RunRow { readonly id:string; readonly status:string; readonly workflow_snapshot:AutomationWorkflow; readonly trigger_payload:Readonly<Record<string,unknown>> }
interface ActionRow { readonly id:string; readonly recipient_id:string; readonly customer_id:string; readonly identity_id:string|null; readonly external_id:string|null; readonly step_index:number; readonly state:string }

/** Durable trigger materialization, recipient planning, and ordered execution. */
@Injectable()
export class AutomationRunnerService {
  constructor(@Inject(API_POOL) private readonly pool:Pool) {}

  async pendingTenants(limit=100):Promise<readonly string[]> {
    const rows=await asExecutor(this.pool).query<{tenant_id:string}>(
      `SELECT tenant_id::text FROM (
         SELECT tenant_id,due_at AS available_at FROM automation_schedule_queue WHERE due_at<=now()
         UNION ALL SELECT tenant_id,available_at FROM automation_work_queue WHERE available_at<=now()
       ) work GROUP BY tenant_id ORDER BY min(available_at) LIMIT $1`,[limit]);
    return rows.rows.map((row)=>row.tenant_id);
  }

  async enqueueDue(tenantId:string,now:Date,limit=100):Promise<number>{
    return withTenant(this.pool,tenantId,async(client)=>{
      const sql=asExecutor(client);
      const due=await sql.query<DueAutomation>(
        `SELECT a.id::text,a.workflow,a.timezone,q.due_at AS next_run_at
           FROM automation_schedule_queue q JOIN automations a ON a.tenant_id=q.tenant_id AND a.id=q.automation_id
          WHERE q.tenant_id=$1 AND a.state='active' AND q.due_at<=$2
          ORDER BY q.due_at,a.id LIMIT $3 FOR UPDATE OF q SKIP LOCKED`,[tenantId,now,limit]);
      let inserted=0;
      for(const automation of due.rows){
        const key=`schedule:${automation.next_run_at.toISOString()}`;
        const run=await sql.query<{id:string}>(
          `INSERT INTO automation_runs(tenant_id,automation_id,status,scheduled_for,trigger_type,trigger_payload,workflow_snapshot,idempotency_key)
           VALUES($1,$2,'queued',$3,'schedule','{}'::jsonb,$4::jsonb,$5)
           ON CONFLICT(tenant_id,automation_id,idempotency_key) DO NOTHING RETURNING id::text`,
          [tenantId,automation.id,automation.next_run_at,JSON.stringify(automation.workflow),key]);
        if(run.rows[0]!==undefined){await queueRun(sql,tenantId,run.rows[0].id,now);inserted+=1;}
        const next=nextScheduledAt(automation.workflow.schedule as unknown as ScheduleDefinition,automation.next_run_at,automation.timezone);
        await sql.query(`UPDATE automations SET last_run_at=$2,next_run_at=$3,updated_at=now() WHERE id=$1`,[automation.id,automation.next_run_at,next]);
        if(next===null)await sql.query(`DELETE FROM automation_schedule_queue WHERE tenant_id=$1 AND automation_id=$2`,[tenantId,automation.id]);
        else await sql.query(`UPDATE automation_schedule_queue SET due_at=$3 WHERE tenant_id=$1 AND automation_id=$2`,[tenantId,automation.id,next]);
      }
      return inserted;
    });
  }

  async enqueueEvent(tenantId:string,event:{readonly type:AutomationTrigger;readonly payload:Readonly<Record<string,unknown>>;readonly payloadHash:string;readonly idempotencyKey:string;readonly occurredAt:Date}):Promise<{readonly eventId:string;readonly runs:number}>{
    return withTenant(this.pool,tenantId,async(client)=>{
      const sql=asExecutor(client);
      const prior=await sql.query<{id:string;payload_hash:string}>(`SELECT id::text,payload_hash FROM automation_events WHERE tenant_id=$1 AND type=$2 AND idempotency_key=$3`,[tenantId,event.type,event.idempotencyKey]);
      if(prior.rows[0]!==undefined){if(prior.rows[0].payload_hash!==event.payloadHash)throw new Error('automation_idempotency_conflict');return{eventId:prior.rows[0].id,runs:0};}
      const created=await sql.query<{id:string}>(`INSERT INTO automation_events(tenant_id,type,payload,payload_hash,idempotency_key,occurred_at) VALUES($1,$2,$3::jsonb,$4,$5,$6) RETURNING id::text`,[tenantId,event.type,JSON.stringify(event.payload),event.payloadHash,event.idempotencyKey,event.occurredAt]);
      const eventId=created.rows[0]!.id;
      const runs=await sql.query<{id:string}>(
        `INSERT INTO automation_runs(tenant_id,automation_id,status,scheduled_for,trigger_type,trigger_payload,workflow_snapshot,idempotency_key)
         SELECT tenant_id,id,'queued',$3,$2,$4::jsonb,workflow,$5 FROM automations
          WHERE tenant_id=$1 AND state='active' AND workflow->'trigger'->>'type'=$2
         ON CONFLICT(tenant_id,automation_id,idempotency_key) DO NOTHING RETURNING id::text`,
        [tenantId,event.type,event.occurredAt,JSON.stringify(event.payload),`event:${eventId}`]);
      for(const run of runs.rows)await queueRun(sql,tenantId,run.id,event.occurredAt);
      return{eventId,runs:runs.rows.length};
    });
  }

  /** Executes bounded work; each call is one tenant transaction and is restart-safe. */
  async execute(tenantId:string,limit=100):Promise<number>{
    return withTenant(this.pool,tenantId,async(client)=>{
      const sql=asExecutor(client);
      const queued=await sql.query<{automation_run_id:string}>(`SELECT automation_run_id::text FROM automation_work_queue WHERE tenant_id=$1 AND available_at<=now() ORDER BY available_at,automation_run_id LIMIT 1 FOR UPDATE SKIP LOCKED`,[tenantId]);
      const runId=queued.rows[0]?.automation_run_id;if(runId===undefined)return 0;
      const run=(await sql.query<RunRow>(`SELECT id::text,status,workflow_snapshot,trigger_payload FROM automation_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
      if(run===undefined||terminalRun(run.status)){await sql.query(`DELETE FROM automation_work_queue WHERE automation_run_id=$1`,[runId]);return 1;}
      if(run.status==='queued'){await plan(sql,tenantId,run);await scheduleNext(sql,runId);return 1;}
      await reconcileOutbound(sql,runId);
      let handled=0;
      for(let count=0;count<limit;count+=1){
        const action=await nextAction(sql,runId);if(action===undefined)break;
        const step=run.workflow_snapshot.steps[action.step_index];
        if(step===undefined)await failAction(sql,runId,action,'automation_step_missing','The frozen workflow step is missing.');
        else await executeAction(sql,tenantId,runId,action,step);
        handled+=1;
      }
      await finalize(sql,runId,run.workflow_snapshot.steps.length);
      await scheduleNext(sql,runId);
      return Math.max(handled,1);
    });
  }
}

async function plan(sql:SqlExecutor,tenantId:string,run:RunRow):Promise<void>{
  const contacts=await resolveContacts(sql,run.workflow_snapshot,run.trigger_payload);
  if(contacts===null){await sql.query(`UPDATE automation_runs SET status='failed',completed_at=now(),error=$2::jsonb WHERE id=$1`,[run.id,JSON.stringify({code:'automation_target_unsupported'})]);await log(sql,tenantId,run.id,null,'error','planning_failed',{code:'automation_target_unsupported'});return;}
  const templateId=firstTemplateId(run.workflow_snapshot.steps);
  for(const contactId of contacts){
    const identity=templateId===null?null:(await sql.query<{id:string}>(`SELECT i.id::text FROM whatsapp_templates t JOIN contact_identities i ON i.scope_id=t.connection_id AND i.contact_id=$2 AND i.kind='whatsapp' AND i.valid_to IS NULL WHERE t.id=$1 AND t.status='approved'`,[templateId,contactId])).rows[0]?.id??null;
    const recipient=await sql.query<{id:string}>(`INSERT INTO automation_recipients(tenant_id,automation_run_id,customer_id,identity_id,template_id,status) VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING RETURNING id::text`,[tenantId,run.id,contactId,identity,templateId]);
    const recipientId=recipient.rows[0]?.id;if(recipientId===undefined)continue;
    for(const [index,step] of run.workflow_snapshot.steps.entries())await sql.query(`INSERT INTO automation_action_executions(tenant_id,automation_run_id,automation_recipient_id,step_index,step_id,step_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[tenantId,run.id,recipientId,index,step.id,step.type]);
  }
  const audience=Number((await sql.query<{count:string}>(`SELECT count(*)::text AS count FROM automation_recipients WHERE automation_run_id=$1`,[run.id])).rows[0]!.count);
  await sql.query(`UPDATE automation_runs SET status=$2,started_at=coalesce(started_at,now()),completed_at=CASE WHEN $3=0 THEN now() END,audience_count=$3,queued_count=$3 WHERE id=$1`,[run.id,audience===0?'completed':'running',audience]);
  await log(sql,tenantId,run.id,null,'info','recipients_planned',{count:audience});
}

async function resolveContacts(sql:SqlExecutor,workflow:AutomationWorkflow,payload:Readonly<Record<string,unknown>>):Promise<readonly string[]|null>{
  const customerId=str(payload['contactId'])??str(payload['customerId'])??str(workflow.target.config['customerId']);
  if(customerId!==null)return(await sql.query<{id:string}>(`SELECT id::text FROM contacts WHERE id=$1 AND deleted_at IS NULL`,[customerId])).rows.map((row)=>row.id);
  const labelId=str(workflow.target.config['labelId']);
  if(workflow.target.type==='label'&&labelId!==null)return(await sql.query<{id:string}>(`SELECT c.id::text FROM contacts c JOIN contact_labels l ON l.contact_id=c.id WHERE l.label_id=$1 AND l.removed_at IS NULL AND c.deleted_at IS NULL ORDER BY c.id`,[labelId])).rows.map((row)=>row.id);
  const audienceId=str(workflow.target.config['audienceId']);
  if(workflow.target.type==='dynamic_audience'&&audienceId!==null)return audienceMembers(sql,audienceId);
  return null;
}

/**
 * The contacts a saved audience names at the moment the run starts — the same
 * narrowing a broadcast applies, across every channel. An audience that is
 * gone, retired or says something a filter cannot express reaches nobody
 * rather than an approximation of it.
 */
async function audienceMembers(sql:SqlExecutor,audienceId:string):Promise<readonly string[]|null>{
  const saved=(await sql.query<{conditions:ConditionDocument}>(`SELECT conditions FROM audiences WHERE id=$1 AND state='active'`,[audienceId])).rows[0];
  const filter=saved===undefined?null:filterFromConditions(saved.conditions);
  if(filter===null)return null;
  const parts=filterParts(filter);
  const rows=await sql.query<{id:string}>(
    `SELECT c.id::text FROM contacts c
      WHERE c.deleted_at IS NULL
        AND ($1::text='' OR c.search_name LIKE '%' || $1 || '%')
        AND (cardinality($2::uuid[])=0 OR NOT EXISTS (
          SELECT 1 FROM unnest($2::uuid[]) wanted(label_id)
           WHERE NOT EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=c.id AND cl.label_id=wanted.label_id AND cl.removed_at IS NULL)))
        AND (cardinality($3::uuid[])=0 OR EXISTS (
          SELECT 1 FROM conversations v JOIN conversation_labels vl ON vl.conversation_id=v.id AND vl.removed_at IS NULL
           WHERE v.contact_id=c.id AND vl.label_id=ANY($3::uuid[])))
        AND (cardinality($4::uuid[])=0 OR c.id=ANY($4::uuid[]))
      ORDER BY c.id`,
    [normalizeSearchText(parts.search),parts.labelIds,parts.conversationLabelIds,parts.contactIds]);
  return rows.rows.map((row)=>row.id);
}

async function nextAction(sql:SqlExecutor,runId:string):Promise<ActionRow|undefined>{
  return(await sql.query<ActionRow>(`SELECT a.id::text,a.automation_recipient_id::text AS recipient_id,r.customer_id::text,r.identity_id::text,i.external_id,a.step_index,a.state FROM automation_action_executions a JOIN automation_recipients r ON r.id=a.automation_recipient_id LEFT JOIN contact_identities i ON i.id=r.identity_id WHERE a.automation_run_id=$1 AND a.state IN ('pending','waiting') AND a.available_at<=now() AND NOT EXISTS(SELECT 1 FROM automation_action_executions p WHERE p.automation_recipient_id=a.automation_recipient_id AND p.step_index<a.step_index AND p.state NOT IN ('completed','skipped')) ORDER BY a.available_at,a.automation_recipient_id,a.step_index LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,[runId])).rows[0];
}

async function executeAction(sql:SqlExecutor,tenantId:string,runId:string,action:ActionRow,step:AutomationStep):Promise<void>{
  await sql.query(`UPDATE automation_action_executions SET state='running',attempts=attempts+1,started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1`,[action.id]);
  if(step.type==='delay'){
    const seconds=int(step.config['seconds']);
    if(seconds===null||seconds<1||seconds>31_536_000){await failAction(sql,runId,action,'automation_delay_invalid','Delay seconds must be from 1 to 31536000.');return;}
    if(action.state!=='waiting'){await sql.query(`UPDATE automation_action_executions SET state='waiting',available_at=now()+($2::text||' seconds')::interval,updated_at=now() WHERE id=$1`,[action.id,seconds]);await log(sql,tenantId,runId,step.id,'info','delay_scheduled',{seconds});return;}
  }else if(step.type==='send_whatsapp_template'){
    // Each variable is filled for this recipient now, from the same bindings
    // a broadcast uses; a recipient the template cannot be filled for fails
    // on its own rather than receiving a half-empty message.
    const templateId=str(step.config['templateId']);
    const bindings=parseTemplateBindings(step.config['variableMapping']??{});
    const values=templateId===null||bindings===null||action.external_id===null?null:await templateValuesFor(sql,bindings,action.customer_id,action.external_id);
    const template=values===null?null:await prepareTemplate(sql,templateId!,values);
    if(template===null||action.identity_id===null){await failAction(sql,runId,action,'automation_template_unavailable','The approved template or recipient identity is unavailable.');return;}
    const message=await sql.query<{id:string}>(`INSERT INTO outbound_messages(tenant_id,connection_id,peer_identity,message_type,template_name,template_language,template_provider_id,template_components,template_preview,client_message_id) VALUES($1,$2,$3,'template',$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(tenant_id,client_message_id) DO UPDATE SET client_message_id=excluded.client_message_id RETURNING id::text`,[tenantId,template.connectionId,action.external_id,template.name,template.language,template.providerId,JSON.stringify(template.components),template.preview,`automation:${action.recipient_id}:${step.id}`]);
    const messageId=message.rows[0]!.id;
    await sql.query(`INSERT INTO outbox(message_id,tenant_id,connection_id,peer_identity,traffic_class) VALUES($1,$2,$3,$4,'bulk') ON CONFLICT(message_id) DO NOTHING`,[messageId,tenantId,template.connectionId,action.external_id]);
    await sql.query(`UPDATE automation_recipients SET outbound_command_id=$2,status='queued',queued_at=coalesce(queued_at,now()) WHERE id=$1`,[action.recipient_id,messageId]);
    await sql.query(`UPDATE automation_action_executions SET outbound_message_id=$2 WHERE id=$1`,[action.id,messageId]);
  }else if(step.type==='add_label'||step.type==='remove_label'){
    const labelId=str(step.config['labelId']);if(labelId===null){await failAction(sql,runId,action,'automation_label_required','The action does not name a label.');return;}
    if(step.type==='add_label')await sql.query(`INSERT INTO contact_labels(tenant_id,contact_id,label_id) SELECT $1,$2,id FROM labels WHERE id=$3 AND state='active' ON CONFLICT(tenant_id,contact_id,label_id) WHERE removed_at IS NULL DO NOTHING`,[tenantId,action.customer_id,labelId]);
    else await sql.query(`UPDATE contact_labels SET removed_at=now() WHERE contact_id=$1 AND label_id=$2 AND removed_at IS NULL`,[action.customer_id,labelId]);
  }else if(step.type==='update_customer_field'){
    const fieldId=str(step.config['fieldId']);const value=step.config['value'];if(fieldId===null||value===undefined){await failAction(sql,runId,action,'automation_field_invalid','The field action is incomplete.');return;}
    await sql.query(`INSERT INTO contact_custom_field_values(tenant_id,contact_id,field_id,value_json,search_value) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(tenant_id,contact_id,field_id) DO UPDATE SET value_json=excluded.value_json,search_value=excluded.search_value,updated_at=now()`,[tenantId,action.customer_id,fieldId,JSON.stringify(value),String(value).slice(0,2000)]);
  }else if(!(step.type==='condition'&&step.conditions===undefined)){await failAction(sql,runId,action,'automation_action_not_supported',`The ${step.type} action is not implemented in the MVP executor.`);return;}
  await sql.query(`UPDATE automation_action_executions SET state='completed',completed_at=now(),updated_at=now() WHERE id=$1`,[action.id]);
  await sql.query(`UPDATE automation_recipients SET current_step=$2 WHERE id=$1`,[action.recipient_id,action.step_index+1]);
  await log(sql,tenantId,runId,step.id,'info','action_completed',{type:step.type,recipient_id:action.recipient_id});
}

async function failAction(sql:SqlExecutor,runId:string,action:ActionRow,code:string,message:string):Promise<void>{await sql.query(`UPDATE automation_action_executions SET state='failed',completed_at=now(),error_code=$2,error_message=$3,updated_at=now() WHERE id=$1`,[action.id,code,message]);await sql.query(`UPDATE automation_recipients SET status='failed',failed_at=now(),error_code=$2,error_message=$3 WHERE id=$1`,[action.recipient_id,code,message]);await sql.query(`UPDATE automation_runs SET failed_count=failed_count+1 WHERE id=$1`,[runId]);}

async function reconcileOutbound(sql:SqlExecutor,runId:string):Promise<void>{await sql.query(`UPDATE automation_recipients r SET status=CASE WHEN m.delivery_state='read' THEN 'read' WHEN m.delivery_state='delivered' THEN 'delivered' WHEN m.command_state='provider_accepted' THEN 'sent' WHEN m.command_state='outcome_unknown' THEN 'outcome_unknown' WHEN m.command_state IN ('rejected','failed','cancelled','skipped') THEN 'failed' ELSE r.status END,provider_message_id=m.provider_message_id,sent_at=CASE WHEN m.command_state='provider_accepted' THEN coalesce(r.sent_at,m.settled_at,now()) ELSE r.sent_at END,delivered_at=CASE WHEN m.delivery_state IN ('delivered','read') THEN coalesce(r.delivered_at,m.delivery_state_at,now()) ELSE r.delivered_at END,failed_at=CASE WHEN m.command_state IN ('rejected','failed','cancelled','skipped') THEN coalesce(r.failed_at,m.settled_at,now()) ELSE r.failed_at END,error_code=CASE WHEN m.command_state IN ('rejected','failed','cancelled','skipped','outcome_unknown') THEN m.state_reason ELSE r.error_code END FROM outbound_messages m WHERE r.automation_run_id=$1 AND r.outbound_command_id=m.id AND r.status IN ('queued','sent','delivered')`,[runId]);}

async function finalize(sql:SqlExecutor,runId:string,stepCount:number):Promise<void>{
  await sql.query(`UPDATE automation_recipients SET status='completed',completed_at=now() WHERE automation_run_id=$1 AND outbound_command_id IS NULL AND status IN ('pending','running') AND current_step >= $2`,[runId,stepCount]);
  const c=(await sql.query<{active:string;completed:string;sent:string;delivered:string;failed:string;skipped:string}>(`SELECT count(*) FILTER(WHERE status IN ('pending','running','queued'))::text AS active,count(*) FILTER(WHERE status='completed')::text AS completed,count(*) FILTER(WHERE status='sent')::text AS sent,count(*) FILTER(WHERE status IN ('delivered','read'))::text AS delivered,count(*) FILTER(WHERE status IN ('failed','outcome_unknown'))::text AS failed,count(*) FILTER(WHERE status IN ('skipped','cancelled'))::text AS skipped FROM automation_recipients WHERE automation_run_id=$1`,[runId])).rows[0]!;
  if(Number(c.active)!==0)return;const failed=Number(c.failed);const successful=Number(c.completed)+Number(c.sent)+Number(c.delivered);const status=failed===0?'completed':successful===0?'failed':'partially_completed';
  await sql.query(`UPDATE automation_runs SET status=$2,completed_at=now(),sent_count=$3,delivered_count=$4,failed_count=$5,skipped_count=$6 WHERE id=$1`,[runId,status,Number(c.sent)+Number(c.delivered),Number(c.delivered),failed,Number(c.skipped)]);
}

async function scheduleNext(sql:SqlExecutor,runId:string):Promise<void>{const state=(await sql.query<{status:string}>(`SELECT status FROM automation_runs WHERE id=$1`,[runId])).rows[0]?.status;if(state===undefined||terminalRun(state)){await sql.query(`DELETE FROM automation_work_queue WHERE automation_run_id=$1`,[runId]);return;}const due=await sql.query<{at:Date|null}>(`SELECT min(available_at) AS at FROM automation_action_executions WHERE automation_run_id=$1 AND state IN ('pending','waiting')`,[runId]);await sql.query(`UPDATE automation_work_queue SET available_at=coalesce($2,now()+interval '1 second') WHERE automation_run_id=$1`,[runId,due.rows[0]?.at??null]);}
async function queueRun(sql:SqlExecutor,tenantId:string,runId:string,at:Date):Promise<void>{await sql.query(`INSERT INTO automation_work_queue(automation_run_id,tenant_id,available_at) VALUES($1,$2,$3) ON CONFLICT(automation_run_id) DO NOTHING`,[runId,tenantId,at]);}
async function log(sql:SqlExecutor,tenantId:string,runId:string,stepId:string|null,level:'info'|'warning'|'error',event:string,details:Readonly<Record<string,unknown>>):Promise<void>{await sql.query(`INSERT INTO automation_logs(tenant_id,automation_run_id,step_id,level,event,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[tenantId,runId,stepId,level,event,JSON.stringify(details)]);}
function firstTemplateId(steps:readonly AutomationStep[]):string|null{for(const step of steps)if(step.type==='send_whatsapp_template')return str(step.config['templateId']);return null;}
function terminalRun(status:string):boolean{return['completed','partially_completed','failed','cancelled'].includes(status);}
function str(value:unknown):string|null{return typeof value==='string'&&value!==''?value:null;}
function int(value:unknown):number|null{return typeof value==='number'&&Number.isInteger(value)?value:null;}
