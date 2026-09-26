import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance,LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createApiApplication } from '../../apps/api/src/app.js';
import { AutomationRunnerService } from '../../apps/api/src/automations/automation-runner.service.js';
import { parseApiConfig } from '../../apps/api/src/config.js';
import { asExecutor,withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import type { DatabaseNames } from '../../packages/database/src/types.js';
import { clusterCredentials,createScratchDatabase,migrateScratch,scratchRuntimePool } from '../support/scratch.js';
const TOKEN='automation-bootstrap-token-value-0001',PASSWORD='automation owner password';
const workflow={version:1,trigger:{type:'manual',config:{}},target:{type:'single_customer',config:{}},steps:[{id:'notify',type:'delay',config:{seconds:60}}],safety:{approvalRequired:false,duplicateWindowSeconds:60}};
interface Harness{app:NestFastifyApplication;pool:Pool;server:FastifyInstance;tenantId:string;cookie:string;csrf:string}
async function setup():Promise<Harness>{const names:DatabaseNames=await createScratchDatabase('convo_automations');await migrateScratch(names);const pool=scratchRuntimePool(names,5);await applyInstallationConfig(asExecutor(pool),'saas');const c=clusterCredentials();const app=await createApiApplication(parseApiConfig({CONVO_DEPLOYMENT_MODE:'saas',CONVO_INSTALLATION_NAME:'Automation Test',CONVO_PUBLIC_BASE_URL:'https://automation.test',CONVO_PROCESS_ROLE:'api',CONVO_AUTH_HASH_SECRET:'automation-auth-hash-secret-value-001',CONVO_BOOTSTRAP_TOKEN:TOKEN,CONVO_IDEMPOTENCY_HASH_SECRET:'automation-idempotency-secret-001',CONVO_API_PORT:'0',CONVO_PG_HOST:c.host,CONVO_PG_PORT:String(c.port),CONVO_PG_DATABASE:names.database,CONVO_PG_RUNTIME_ROLE:names.runtimeRole,CONVO_PG_RUNTIME_PASSWORD:names.runtimePassword}),pool);const server=app.getHttpAdapter().getInstance() as unknown as FastifyInstance;const boot=await server.inject({method:'POST',url:'/api/v1/instance/bootstrap',headers:{'x-bootstrap-token':TOKEN,'idempotency-key':'auto-bootstrap'},payload:{companyName:'Digital School',companySlug:`auto-${randomUUID().slice(0,8)}`,ownerEmail:'owner@automation.test',ownerPassword:PASSWORD}});const tenantId=(boot.json() as {data:{tenantId:string}}).data.tenantId;const login=await server.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'owner@automation.test',password:PASSWORD}});const lines=Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']??''];const cookie=lines.map(x=>x.split(';')[0]).join('; ');const csrf=cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('convo_csrf='))?.slice(11)??'';return{app,pool,server,tenantId,cookie,csrf};}
function send(h:Harness,method:'GET'|'POST'|'PATCH'|'DELETE',path:string,payload?:Record<string,unknown>):Promise<LightMyRequestResponse>{return h.server.inject({method,url:`/api/v1/tenants/${h.tenantId}${path}`,headers:{cookie:h.cookie,'x-csrf-token':h.csrf},...(payload===undefined?{}:{payload})});}

async function seedRun(h:Harness, frozen: Record<string, unknown>): Promise<string> {
 const id=await withTenant(h.pool,h.tenantId,async(client)=>{
  const automation=await client.query<{id:string}>(`INSERT INTO automations(tenant_id,name,description,workflow,timezone) VALUES($1,$2,'executor test',$3::jsonb,'UTC') RETURNING id::text`,[h.tenantId,`Executor ${randomUUID()}`,JSON.stringify(frozen)]);
  const run=await client.query<{id:string}>(`INSERT INTO automation_runs(tenant_id,automation_id,status,scheduled_for,trigger_type,workflow_snapshot,idempotency_key) VALUES($1,$2,'queued',now(),'manual',$3::jsonb,$4) RETURNING id::text`,[h.tenantId,automation.rows[0]!.id,JSON.stringify(frozen),randomUUID()]);
  await client.query(`UPDATE automation_work_queue SET available_at=now()+interval '1 day' WHERE tenant_id=$1`,[h.tenantId]);
  await client.query(`INSERT INTO automation_work_queue(automation_run_id,tenant_id,available_at) VALUES($1,$2,now()-interval '1 second')`,[run.rows[0]!.id,h.tenantId]);
  return run.rows[0]!.id;
 });
 return id;
}

async function runState(h:Harness,id:string):Promise<Record<string,unknown>>{
 return withTenant(h.pool,h.tenantId,async(client)=>(await client.query<Record<string,unknown>>(`SELECT * FROM automation_runs WHERE id=$1`,[id])).rows[0]??{});
}
describe('automation product API',()=>{let h:Harness;beforeAll(async()=>{h=await setup();},120_000);afterAll(async()=>{if(h!==undefined)await h.app.close();});
 it('exposes 19 editable starters and creates an isolated draft',async()=>{const list=await send(h,'GET','/automation-templates');expect(list.statusCode).toBe(200);expect((list.json() as {data:unknown[]}).data).toHaveLength(19);expect((await send(h,'GET','/whatsapp-templates')).json()).toMatchObject({data:[]});const used=await send(h,'POST','/automation-templates/new_lead_welcome/use',{name:'Lead Welcome'});expect(used.statusCode,used.body).toBe(201);expect((used.json() as {data:{state:string;templateKey:string}}).data).toMatchObject({state:'draft',templateKey:'new_lead_welcome'});expect((await send(h,'POST','/automation-templates/missing/use',{name:'Missing'})).statusCode).toBe(404);});
 it('creates, edits and version-fences lifecycle controls',async()=>{const created=await send(h,'POST','/automations',{name:'Internal alert',description:'Ops',timezone:'Africa/Cairo',workflow});expect(created.statusCode,created.body).toBe(201);const a=(created.json() as {data:{id:string;version:number}}).data;const updated=await send(h,'PATCH',`/automations/${a.id}`,{version:a.version,name:'Internal alert v2',timezone:'UTC',workflow});expect(updated.statusCode).toBe(200);const v=(updated.json() as {data:{version:number}}).data.version;expect((await send(h,'PATCH',`/automations/${a.id}`,{version:a.version,name:'Stale',timezone:'UTC',workflow})).statusCode).toBe(409);const active=await send(h,'POST',`/automations/${a.id}/activate`,{version:v});expect(active.statusCode,active.body).toBe(200);const av=(active.json() as {data:{version:number}}).data.version;const paused=await send(h,'POST',`/automations/${a.id}/pause`,{version:av});expect(paused.statusCode).toBe(200);const pv=(paused.json() as {data:{version:number}}).data.version;expect((await send(h,'POST',`/automations/${a.id}/resume`,{version:pv})).statusCode).toBe(200);expect((await send(h,'GET','/automations')).statusCode).toBe(200);expect((await send(h,'GET','/automation-runs')).statusCode).toBe(200);});
 it('pages automation definitions and run history with bound cursors',async()=>{
  for(const name of ['Cursor Alpha','Cursor Bravo','Cursor Charlie']) expect((await send(h,'POST','/automations',{name,timezone:'UTC',workflow})).statusCode).toBe(201);
  const first=await send(h,'GET','/automations?search=Cursor&sort=name_asc&limit=2');expect(first.statusCode,first.body).toBe(200);
  const page=(first.json() as {data:{name:string}[];page:{next_cursor:string|null;has_more:boolean}});expect(page.data.map((item)=>item.name)).toEqual(['Cursor Alpha','Cursor Bravo']);expect(page.page.has_more).toBe(true);
  const second=await send(h,'GET',`/automations?search=Cursor&sort=name_asc&limit=2&cursor=${encodeURIComponent(page.page.next_cursor??'')}`);expect((second.json() as {data:{name:string}[]}).data.map((item)=>item.name)).toEqual(['Cursor Charlie']);
  const rebound=await send(h, 'GET', `/automations?search=Other&sort=name_asc&limit=2&cursor=${encodeURIComponent(page.page.next_cursor??'')}`);expect(rebound.statusCode).toBe(400);expect((rebound.json() as {error:{code:string}}).error.code).toBe('cursor_invalid');
  await withTenant(h.pool,h.tenantId,async(client)=>{const automation=(await client.query<{id:string}>(`SELECT id::text FROM automations WHERE name='Cursor Alpha'`)).rows[0]!.id;for(const offset of [1,2])await client.query(`INSERT INTO automation_runs(tenant_id,automation_id,status,scheduled_for,trigger_type,workflow_snapshot,idempotency_key) VALUES($1,$2,'cancelled',now()+($3::text||' seconds')::interval,'manual',$4::jsonb,$5)`,[h.tenantId,automation,offset,JSON.stringify(workflow),randomUUID()]);});
  const runs=await send(h,'GET','/automation-runs?limit=1');expect(runs.statusCode).toBe(200);expect((runs.json() as {page:{has_more:boolean}}).page.has_more).toBe(true);
 });
 it('deletes only a versioned draft with no execution history',async()=>{
  const created=await send(h,'POST','/automations',{name:`Delete me ${randomUUID()}`,timezone:'UTC',workflow});const draft=(created.json() as {data:{id:string;version:number}}).data;
  const deleted=await send(h,'DELETE',`/automations/${draft.id}`,{version:draft.version});expect(deleted.statusCode,deleted.body).toBe(200);expect((await send(h,'GET','/automations')).json()).not.toMatchObject({data:[expect.objectContaining({id:draft.id})]});
  const activeCreated=await send(h,'POST','/automations',{name:`Active ${randomUUID()}`,timezone:'UTC',workflow});const active=(activeCreated.json() as {data:{id:string;version:number}}).data;const activated=await send(h,'POST',`/automations/${active.id}/activate`,{version:active.version});const refused=await send(h,'DELETE',`/automations/${active.id}`,{version:(activated.json() as {data:{version:number}}).data.version});expect(refused.statusCode).toBe(409);expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_not_deletable_in_state');
  const historical=await send(h,'POST','/automations',{name:`History ${randomUUID()}`,timezone:'UTC',workflow});const history=(historical.json() as {data:{id:string;version:number}}).data;await withTenant(h.pool,h.tenantId,(client)=>client.query(`INSERT INTO automation_runs(tenant_id,automation_id,status,scheduled_for,trigger_type,workflow_snapshot,idempotency_key) VALUES($1,$2,'cancelled',now(),'manual',$3::jsonb,$4)`,[h.tenantId,history.id,JSON.stringify(workflow),randomUUID()]));const protectedDraft=await send(h,'DELETE',`/automations/${history.id}`,{version:history.version});expect(protectedDraft.statusCode).toBe(409);expect((protectedDraft.json() as {error:{code:string}}).error.code).toBe('automation_has_execution_history');
 });
 it('turns an idempotent business event into one run per matching active automation',async()=>{const eventWorkflow={...workflow,trigger:{type:'student_enrolled',config:{}}};const created=await send(h,'POST','/automations',{name:'Enrollment event',timezone:'UTC',workflow:eventWorkflow});const a=(created.json() as {data:{id:string;version:number}}).data;expect((await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version})).statusCode).toBe(200);const payload={type:'student_enrolled',payload:{studentId:'external-1'},idempotencyKey:'enrolment-1',occurredAt:'2026-09-17T08:00:00.000Z'};const first=await send(h,'POST','/automation-events',payload);expect(first.statusCode,first.body).toBe(201);expect((first.json() as {data:{runs:number}}).data.runs).toBe(1);const duplicate=await send(h,'POST','/automation-events',payload);expect((duplicate.json() as {data:{runs:number}}).data.runs).toBe(0);const conflict=await send(h,'POST','/automation-events',{...payload,payload:{studentId:'external-2'}});expect(conflict.statusCode).toBe(409);expect(((await send(h,'GET','/automation-runs')).json() as {data:{trigger_type:string}[]}).data.some((run)=>run.trigger_type==='student_enrolled')).toBe(true);});
 it('materializes a due schedule once and advances its durable cursor',async()=>{const scheduled={...workflow,trigger:{type:'schedule',config:{}},schedule:{kind:'one_time',at:'2030-01-01T09:00:00.000Z'}};const created=await send(h,'POST','/automations',{name:'Scheduled once',timezone:'UTC',workflow:scheduled});const a=(created.json() as {data:{id:string;version:number}}).data;const active=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});expect(active.statusCode,active.body).toBe(200);await withTenant(h.pool,h.tenantId,async(client)=>{await client.query(`UPDATE automations SET next_run_at=now()-interval '1 minute' WHERE id=$1`,[a.id]);await client.query(`UPDATE automation_schedule_queue SET due_at=now()-interval '1 minute' WHERE automation_id=$1`,[a.id]);});const runner=h.app.get(AutomationRunnerService);expect(await runner.pendingTenants()).toContain(h.tenantId);expect(await runner.enqueueDue(h.tenantId,new Date(),10)).toBe(1);expect(await runner.enqueueDue(h.tenantId,new Date(),10)).toBe(0);});
 it('refuses activation when an approved WhatsApp template and mappings are absent',async()=>{const sendWorkflow={...workflow,steps:[{id:'send',type:'send_whatsapp_template',config:{}}]};const created=await send(h,'POST','/automations',{name:'Unsafe send',timezone:'UTC',workflow:sendWorkflow});const a=(created.json() as {data:{id:string;version:number}}).data;const refused=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});expect(refused.statusCode).toBe(409);expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_template_required');expect((await send(h,'POST',`/automations/${a.id}/dance`,{version:a.version})).statusCode).toBe(400);});

 it('refuses activation until every step is executable, configured and names live resources',async()=>{
  const label=((await send(h,'POST','/labels',{name:`Activation ${randomUUID().slice(0,8)}`,color:'#2563eb'})).json() as {data:{id:string;version:number}}).data;
  const field=((await send(h,'POST','/custom-fields',{target:'contact',key:`level_${randomUUID().slice(0,8).replace(/-/g,'')}`,name:'Level',type:'text',options:[]})).json() as {data:{id:string}}).data;
  const retired=((await send(h,'POST','/labels',{name:`Retired ${randomUUID().slice(0,8)}`,color:'#64748b'})).json() as {data:{id:string;version:number}}).data;
  expect((await send(h,'DELETE',`/labels/${retired.id}`,{version:retired.version})).statusCode).toBe(200);
  const attempt=async(changes:Record<string,unknown>)=>{
   const created=await send(h,'POST','/automations',{name:`Activation ${randomUUID()}`,timezone:'UTC',workflow:{...workflow,...changes}});
   expect(created.statusCode,created.body).toBe(201);
   const a=(created.json() as {data:{id:string;version:number}}).data;
   const result=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});
   return {status:result.statusCode,code:(result.json() as {error?:{code:string}}).error?.code};
  };
  const step=(type:string,config:Record<string,unknown>)=>({steps:[{id:'only',type,config}]});
  for(const [changes,code] of [
   [step('create_internal_notification',{}),'automation_action_not_supported'],
   [step('webhook',{url:'https://example.test'}),'automation_action_not_supported'],
   [step('delay',{}),'automation_step_incomplete'],
   [step('delay',{seconds:1.5}),'automation_step_incomplete'],
   [step('delay',{seconds:0}),'automation_step_incomplete'],
   [step('delay',{seconds:31_536_001}),'automation_step_incomplete'],
   [step('add_label',{}),'automation_step_incomplete'],
   [step('add_label',{labelId:randomUUID()}),'automation_step_incomplete'],
   [step('remove_label',{labelId:retired.id}),'automation_step_incomplete'],
   [step('update_customer_field',{}),'automation_step_incomplete'],
   [step('update_customer_field',{fieldId:field.id}),'automation_step_incomplete'],
   [step('update_customer_field',{fieldId:randomUUID(),value:'B1'}),'automation_step_incomplete'],
   [step('send_whatsapp_template',{templateId:''}),'automation_template_required'],
   [{target:{type:'label',config:{}}},'automation_step_incomplete'],
  ] as const){
   expect(await attempt(changes),JSON.stringify(changes)).toEqual({status:409,code});
  }
  for(const changes of [
   step('add_label',{labelId:label.id}),
   step('remove_label',{labelId:label.id}),
   step('update_customer_field',{fieldId:field.id,value:'B1'}),
   {target:{type:'label',config:{labelId:label.id}}},
  ]){
   expect(await attempt(changes),JSON.stringify(changes)).toEqual({status:200,code:undefined});
  }
 });
 it('refuses a transition the state machine does not allow',async()=>{
  // `draft:pause` is not a transition. The refusal is a 409 rather than a
  // 404, because the automation exists and the *act* is what is wrong.
  const created=await send(h,'POST','/automations',{name:'Transition guard',timezone:'UTC',workflow});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  const refused=await send(h,'POST',`/automations/${a.id}/pause`,{version:a.version});
  expect(refused.statusCode,refused.body).toBe(409);
  expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_transition_refused');
 });
 it('refuses an unknown act outright',async()=>{
  const created=await send(h,'POST','/automations',{name:'Unknown act',timezone:'UTC',workflow});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  expect((await send(h,'POST',`/automations/${a.id}/detonate`,{version:a.version})).statusCode).toBe(400);
 });
 it('reports a missing automation as not found',async()=>{
  const missing=await send(h,'POST',`/automations/${randomUUID()}/activate`,{version:1});
  expect(missing.statusCode).toBe(404);
 });
 it('fences a transition on the version the operator saw',async()=>{
  const created=await send(h,'POST','/automations',{name:'Version fence',timezone:'UTC',workflow});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  const stale=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version+5});
  expect(stale.statusCode).toBe(409);
  expect((stale.json() as {error:{code:string}}).error.code).toBe('automation_version_conflict');
 });
 it('refuses an edit to an automation that is already active',async()=>{
  const created=await send(h,'POST','/automations',{name:'Active edit',timezone:'UTC',workflow});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  const active=(await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version})).json() as {data:{version:number}};
  const refused=await send(h,'PATCH',`/automations/${a.id}`,{version:active.data.version,name:'Active edit v2',timezone:'UTC',workflow});
  expect(refused.statusCode).toBe(409);
 });
 it('refuses a schedule trigger whose schedule has no future instant',async()=>{
  // Activation computes the first run; a one-time schedule already in the past
  // has none, and that must fail at activation rather than silently never run.
  const exhausted={...workflow,trigger:{type:'schedule',config:{}},schedule:{kind:'one_time',at:'2020-01-01T00:00:00.000Z'}};
  const created=await send(h,'POST','/automations',{name:'Exhausted schedule',timezone:'UTC',workflow:exhausted});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  const refused=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});
  expect(refused.statusCode,refused.body).toBe(409);
  expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_schedule_exhausted');
 });
 it('refuses a template step naming a template that is not approved',async()=>{
  const sendWorkflow={...workflow,steps:[{id:'send',type:'send_whatsapp_template',config:{templateId:randomUUID(),variableMapping:{}}}]};
  const created=await send(h,'POST','/automations',{name:'Unknown template',timezone:'UTC',workflow:sendWorkflow});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  const refused=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});
  expect(refused.statusCode).toBe(409);
  expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_template_unavailable');
 });
 it('refuses a duplicate name, and a template key that does not exist',async()=>{
  await send(h,'POST','/automations',{name:'Only once',timezone:'UTC',workflow});
  expect((await send(h,'POST','/automations',{name:'Only once',timezone:'UTC',workflow})).statusCode).toBe(409);
  expect((await send(h,'POST','/automation-templates/no_such_template/use',{name:'Nope'})).statusCode).toBe(404);
  expect((await send(h,'POST','/automation-templates/blank/use',{name:'   '})).statusCode).toBe(400);
 });
 it('refuses the same idempotency key carrying a different event',async()=>{
  // Two different facts under one key is a client bug, and answering 200 to the
  // second would silently drop it.
  const first={type:'course_completed',payload:{courseId:'a'},idempotencyKey:'dup-key-1',occurredAt:new Date().toISOString()};
  expect((await send(h,'POST','/automation-events',first)).statusCode).toBe(201);
  const second={...first,payload:{courseId:'b'}};
  const conflict=await send(h,'POST','/automation-events',second);
  expect(conflict.statusCode,conflict.body).toBe(409);
  expect((conflict.json() as {error:{code:string}}).error.code).toBe('automation_idempotency_conflict');
 });
 it('drops a one-time schedule from the queue once it has fired',async()=>{
  // A one-time schedule has no next instant, so the cursor is removed rather
  // than left due forever.
  const once={...workflow,trigger:{type:'schedule',config:{}},schedule:{kind:'one_time',at:'2031-01-01T09:00:00.000Z'}};
  const created=await send(h,'POST','/automations',{name:'Fires once',timezone:'UTC',workflow:once});
  const a=(created.json() as {data:{id:string;version:number}}).data;
  expect((await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version})).statusCode).toBe(200);
  // The cursor sits exactly on the scheduled instant, which is the only state
  // production ever produces. Dragging it earlier would model a moment that
  // cannot occur, and the schedule would legitimately still have that instant
  // ahead of it.
  await withTenant(h.pool,h.tenantId,async(client)=>{
   await client.query(
    `UPDATE automation_schedule_queue q SET due_at=a.next_run_at
       FROM automations a WHERE a.id=q.automation_id AND q.automation_id=$1`,[a.id]);
  });
  const runner=h.app.get(AutomationRunnerService);
  // Evaluated from a moment after the instant has passed. Other schedules this
  // suite activated are due by then too, so the count is "at least this one".
  expect(await runner.enqueueDue(h.tenantId,new Date('2031-06-01T00:00:00.000Z'),10)).toBeGreaterThanOrEqual(1);
  const remaining=await withTenant(h.pool,h.tenantId,(client)=>
   client.query('SELECT 1 FROM automation_schedule_queue WHERE automation_id=$1',[a.id]));
  expect(remaining.rowCount).toBe(0);
 });

 it('checks the variable map against the template it names',async()=>{
  // With an approved template in place, activation stops failing on
  // availability and starts failing on the mapping — three distinct ways.
  const templateId=await withTenant(h.pool,h.tenantId,async(client)=>{
   const connection=await client.query<{id:string}>(
    `SELECT id::text FROM channel_connections WHERE tenant_id=$1 LIMIT 1`,[h.tenantId]);
   let connectionId=connection.rows[0]?.id;
   if(connectionId===undefined){
    const created=await client.query<{id:string}>(
     `INSERT INTO channel_connections (tenant_id,kind,external_asset_id,display_name,status)
      VALUES ($1,'whatsapp',$2,'Automation template test','healthy') RETURNING id::text`,
     [h.tenantId,`asset-${randomUUID()}`]);
    connectionId=created.rows[0]?.id;
   }
   const template=await client.query<{id:string}>(
    `INSERT INTO whatsapp_templates
       (tenant_id,connection_id,provider_template_id,template_name,language,category,status,
        components,variables,last_synced_at)
     VALUES ($1,$2,$3,'enrollment_confirmation','ar','UTILITY','approved',
             '[{"type":"BODY","text":"أهلًا {{1}}، موعدك {{2}}"}]'::jsonb,'["{{1}}","{{2}}"]'::jsonb,now())
     RETURNING id::text`,[h.tenantId,connectionId,`ptid-${randomUUID()}`]);
   return template.rows[0]?.id ?? '';
  });
  expect(templateId).not.toBe('');

  const activateWith=async(config:Record<string,unknown>)=>{
   const created=await send(h,'POST','/automations',
    {name:`Mapping ${randomUUID()}`,timezone:'UTC',
     workflow:{...workflow,steps:[{id:'send',type:'send_whatsapp_template',config}]}});
   const a=(created.json() as {data:{id:string;version:number}}).data;
   return send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});
  };

  // No map at all, a map that is not an object, an old-style map, a map
  // missing a variable, and one reading a field that does not exist.
  for (const config of [
   {templateId},
   {templateId,variableMapping:'not-an-object'},
   {templateId,variableMapping:{'1':{type:'static',value:'x'},'2':{type:'static',value:'y'}}},
   {templateId,variableMapping:{'body:1':{source:'display_name'}}},
   {templateId,variableMapping:{'body:1':{source:'display_name'},'body:2':{source:'field',fieldId:randomUUID()}}},
  ]) {
   const refused=await activateWith(config);
   expect(refused.statusCode,refused.body).toBe(409);
   expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_variables_incomplete');
  }

  // Complete map: the template check passes and activation succeeds.
  const ok=await activateWith({templateId,variableMapping:{'body:1':{source:'display_name',fallback:'there'},'body:2':{source:'static',value:'Sunday'}}});
  expect(ok.statusCode,ok.body).toBe(200);
 });
 it('re-raises an ingest failure that is not an idempotency conflict',async()=>{
  // The service translates one named error and must not swallow the rest.
  const runner=h.app.get(AutomationRunnerService);
  const original=runner.enqueueEvent.bind(runner);
  (runner as unknown as {enqueueEvent:unknown}).enqueueEvent=():Promise<never>=>
   Promise.reject(new Error('database is on fire'));
  try {
   const failed=await send(h,'POST','/automation-events',
    {type:'course_completed',payload:{},idempotencyKey:`raise-${randomUUID()}`,occurredAt:new Date().toISOString()});
   expect(failed.statusCode).toBe(500);
  } finally {
   (runner as unknown as {enqueueEvent:unknown}).enqueueEvent=original;
  }
 });

 it('plans a label audience and executes ordered condition, label, field and removal actions',async()=>{
  const fixture=await withTenant(h.pool,h.tenantId,async(client)=>{
   const contact=await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Automation Student') RETURNING id::text`,[h.tenantId]);
   const source=await client.query<{id:string}>(`INSERT INTO labels(tenant_id,name,color) VALUES($1,$2,'#123456') RETURNING id::text`,[h.tenantId,`Source ${randomUUID()}`]);
   const added=await client.query<{id:string}>(`INSERT INTO labels(tenant_id,name,color) VALUES($1,$2,'#654321') RETURNING id::text`,[h.tenantId,`Added ${randomUUID()}`]);
   const field=await client.query<{id:string}>(`INSERT INTO custom_fields(tenant_id,target,key,name,type) VALUES($1,'contact',$2,'Automation value','text') RETURNING id::text`,[h.tenantId,`auto_${randomUUID().replaceAll('-','').slice(0,16)}`]);
   await client.query(`INSERT INTO contact_labels(tenant_id,contact_id,label_id) VALUES($1,$2,$3)`,[h.tenantId,contact.rows[0]!.id,source.rows[0]!.id]);
   return{contactId:contact.rows[0]!.id,sourceId:source.rows[0]!.id,addedId:added.rows[0]!.id,fieldId:field.rows[0]!.id};
  });
  const frozen={...workflow,target:{type:'label',config:{labelId:fixture.sourceId}},steps:[
   {id:'check',type:'condition',config:{}},
   {id:'add',type:'add_label',config:{labelId:fixture.addedId}},
   {id:'field',type:'update_customer_field',config:{fieldId:fixture.fieldId,value:'active'}},
   {id:'remove',type:'remove_label',config:{labelId:fixture.sourceId}},
  ]};
  const id=await seedRun(h,frozen);const runner=h.app.get(AutomationRunnerService);
  expect(await runner.execute(h.tenantId)).toBe(1);
  expect(await runner.execute(h.tenantId)).toBe(4);
  expect(await runState(h,id)).toMatchObject({status:'completed',audience_count:1});
  const effects=await withTenant(h.pool,h.tenantId,async(client)=>({
   labels:(await client.query(`SELECT label_id::text FROM contact_labels WHERE contact_id=$1 AND removed_at IS NULL`,[fixture.contactId])).rows,
   field:(await client.query(`SELECT value_json FROM contact_custom_field_values WHERE contact_id=$1 AND field_id=$2`,[fixture.contactId,fixture.fieldId])).rows[0],
  }));
  expect(effects.labels).toEqual([{label_id:fixture.addedId}]);expect(effects.field).toMatchObject({value_json:'active'});
 });

 it('persists a delay, resumes it, and fails malformed or unsupported actions without retrying forever',async()=>{
  const contactId=await withTenant(h.pool,h.tenantId,async(client)=>(await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Delayed Student') RETURNING id::text`,[h.tenantId])).rows[0]!.id);
  const runner=h.app.get(AutomationRunnerService);
  const delayed=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[{id:'wait',type:'delay',config:{seconds:1}}]});
  await runner.execute(h.tenantId);await runner.execute(h.tenantId);
  expect((await runState(h,delayed))['status']).toBe('running');
  await withTenant(h.pool,h.tenantId,async(client)=>{await client.query(`UPDATE automation_action_executions SET available_at=now()-interval '1 second' WHERE automation_run_id=$1`,[delayed]);await client.query(`UPDATE automation_work_queue SET available_at=now()-interval '1 second' WHERE automation_run_id=$1`,[delayed]);});
  expect(await runner.execute(h.tenantId)).toBe(1);expect((await runState(h,delayed))['status']).toBe('completed');

  for(const step of [
   {id:'bad_delay',type:'delay',config:{seconds:0}},
   {id:'fractional_delay',type:'delay',config:{seconds:1.5}},
   {id:'unsupported',type:'create_internal_notification',config:{}},
   {id:'bad_label',type:'add_label',config:{}},
   {id:'bad_field',type:'update_customer_field',config:{fieldId:''}},
   {id:'bad_template',type:'send_whatsapp_template',config:{}},
  ]){
   const id=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[step]});
   await runner.execute(h.tenantId);await runner.execute(h.tenantId);
   expect((await runState(h,id))['status']).toBe('failed');
  }
 });

 it('queues an approved template idempotently, reconciles provider acceptance, and contains missing identity failures',async()=>{
  const fixture=await withTenant(h.pool,h.tenantId,async(client)=>{
   const connection=await client.query<{id:string}>(`INSERT INTO channel_connections(tenant_id,kind,external_asset_id,display_name,status) VALUES($1,'whatsapp',$2,'Executor WhatsApp','healthy') RETURNING id::text`,[h.tenantId,`asset-${randomUUID()}`]);
   const template=await client.query<{id:string}>(`INSERT INTO whatsapp_templates(tenant_id,connection_id,provider_template_id,template_name,language,category,status,components,variables,last_synced_at) VALUES($1,$2,$3,'welcome','en','utility','approved','[]','[]',now()) RETURNING id::text`,[h.tenantId,connection.rows[0]!.id,randomUUID()]);
   const reachable=await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Reachable') RETURNING id::text`,[h.tenantId]);
   const unreachable=await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Unreachable') RETURNING id::text`,[h.tenantId]);
   await client.query(`INSERT INTO contact_identities(tenant_id,contact_id,kind,scope_id,external_id) VALUES($1,$2,'whatsapp',$3,'201000000001')`,[h.tenantId,reachable.rows[0]!.id,connection.rows[0]!.id]);
   return{templateId:template.rows[0]!.id,reachableId:reachable.rows[0]!.id,unreachableId:unreachable.rows[0]!.id};
  });
  const runner=h.app.get(AutomationRunnerService);const step={id:'send',type:'send_whatsapp_template',config:{templateId:fixture.templateId}};
  const sent=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:fixture.reachableId}},steps:[step]});
  await runner.execute(h.tenantId);await runner.execute(h.tenantId);
  await withTenant(h.pool,h.tenantId,async(client)=>{await client.query(`UPDATE outbound_messages SET command_state='provider_accepted',settled_at=now(),provider_message_id='wamid.executor' WHERE id=(SELECT outbound_command_id FROM automation_recipients WHERE automation_run_id=$1)`,[sent]);await client.query(`UPDATE automation_work_queue SET available_at=now()-interval '1 second' WHERE automation_run_id=$1`,[sent]);});
  await runner.execute(h.tenantId);expect(await runState(h,sent)).toMatchObject({status:'completed',sent_count:1});

  const failed=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:fixture.unreachableId}},steps:[step]});
  await runner.execute(h.tenantId);await runner.execute(h.tenantId);expect((await runState(h,failed))['status']).toBe('failed');
 });

 it('sends a filled template to a saved audience when its schedule comes due',async()=>{
  const fixture=await withTenant(h.pool,h.tenantId,async(client)=>{
   const connection=await client.query<{id:string}>(`INSERT INTO channel_connections(tenant_id,kind,external_asset_id,display_name,status) VALUES($1,'whatsapp',$2,'Broadcast WhatsApp','healthy') RETURNING id::text`,[h.tenantId,`asset-${randomUUID()}`]);
   const template=await client.query<{id:string}>(`INSERT INTO whatsapp_templates(tenant_id,connection_id,provider_template_id,template_name,language,category,status,components,variables,last_synced_at) VALUES($1,$2,$3,'class_reminder','en','marketing','approved','[{"type":"BODY","text":"Hi {{1}}, your level is {{2}}."}]','["{{1}}","{{2}}"]',now()) RETURNING id::text`,[h.tenantId,connection.rows[0]!.id,randomUUID()]);
   const vip=await client.query<{id:string}>(`INSERT INTO labels(tenant_id,name,color) VALUES($1,$2,'#2563eb') RETURNING id::text`,[h.tenantId,`VIP ${randomUUID()}`]);
   const level=await client.query<{id:string}>(`INSERT INTO custom_fields(tenant_id,target,key,name,type,options) VALUES($1,'contact',$2,'Level','multi_select','["B1","IELTS"]'::jsonb) RETURNING id::text`,[h.tenantId,`level_${randomUUID().replaceAll('-','').slice(0,12)}`]);
   const people:string[]=[];
   for(const [name,phone,labelled] of [['Mona','201000000101',true],['Sara','201000000102',true],['Omar','201000000103',false]] as const){
    const contact=await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,$2) RETURNING id::text`,[h.tenantId,name]);
    await client.query(`INSERT INTO contact_identities(tenant_id,contact_id,kind,scope_id,external_id) VALUES($1,$2,'whatsapp',$3,$4)`,[h.tenantId,contact.rows[0]!.id,connection.rows[0]!.id,phone]);
    if(labelled)await client.query(`INSERT INTO contact_labels(tenant_id,contact_id,label_id) VALUES($1,$2,$3)`,[h.tenantId,contact.rows[0]!.id,vip.rows[0]!.id]);
    people.push(contact.rows[0]!.id);
   }
   await client.query(`INSERT INTO contact_custom_field_values(tenant_id,contact_id,field_id,value_json,search_value) VALUES($1,$2,$3,'["B1","IELTS"]','b1 ielts')`,[h.tenantId,people[0],level.rows[0]!.id]);
   const audience=await client.query<{id:string}>(`INSERT INTO audiences(tenant_id,name,conditions) VALUES($1,$2,$3::jsonb) RETURNING id::text`,[h.tenantId,`VIPs ${randomUUID()}`,JSON.stringify({version:1,root:{kind:'group',match:'all',conditions:[{kind:'predicate',field:'label_id',operator:'eq',value:vip.rows[0]!.id}]}})]);
   const vague=await client.query<{id:string}>(`INSERT INTO audiences(tenant_id,name,conditions) VALUES($1,$2,$3::jsonb) RETURNING id::text`,[h.tenantId,`Vague ${randomUUID()}`,JSON.stringify({version:1,root:{kind:'group',match:'any',conditions:[]}})]);
   return{templateId:template.rows[0]!.id,levelId:level.rows[0]!.id,audienceId:audience.rows[0]!.id,vagueId:vague.rows[0]!.id};
  });
  const step={id:'send',type:'send_whatsapp_template',config:{templateId:fixture.templateId,variableMapping:{'body:1':{source:'display_name'},'body:2':{source:'field',fieldId:fixture.levelId,fallback:'to be confirmed'}}}};
  const at5pm={...workflow,trigger:{type:'schedule',config:{}},schedule:{kind:'one_time',at:'2030-01-01T17:00:00.000Z'},steps:[step]};
  const create=async(target:Record<string,unknown>)=>(await send(h,'POST','/automations',{name:`Broadcast ${randomUUID()}`,timezone:'Africa/Cairo',workflow:{...at5pm,target}})).json() as {data:{id:string;version:number}};
  // A saved audience a filter cannot express, or none at all, is refused before it runs.
  for(const config of [{},{audienceId:fixture.vagueId},{audienceId:randomUUID()}]){
   const draft=(await create({type:'dynamic_audience',config})).data;
   const refused=await send(h,'POST',`/automations/${draft.id}/activate`,{version:draft.version});
   expect(refused.statusCode,refused.body).toBe(409);
   expect((refused.json() as {error:{code:string}}).error.code).toBe('automation_step_incomplete');
  }
  const a=(await create({type:'dynamic_audience',config:{audienceId:fixture.audienceId}})).data;
  const active=await send(h,'POST',`/automations/${a.id}/activate`,{version:a.version});
  expect(active.statusCode,active.body).toBe(200);
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`UPDATE automation_schedule_queue SET due_at=now()-interval '1 minute' WHERE automation_id=$1`,[a.id]));
  const runner=h.app.get(AutomationRunnerService);
  expect(await runner.enqueueDue(h.tenantId,new Date(),10)).toBe(1);
  for(let pass=0;pass<4;pass+=1)await runner.execute(h.tenantId);
  const sent=await withTenant(h.pool,h.tenantId,(client)=>client.query<{peer_identity:string;template_name:string;template_preview:string;template_components:unknown}>(
   `SELECT m.peer_identity,m.template_name,m.template_preview,m.template_components FROM outbound_messages m
     JOIN automation_recipients r ON r.outbound_command_id=m.id JOIN automation_runs run ON run.id=r.automation_run_id
    WHERE run.automation_id=$1 ORDER BY m.peer_identity`,[a.id]));
  // Only the audience, each filled with their own values or the fallback.
  expect(sent.rows).toEqual([
   {peer_identity:'201000000101',template_name:'class_reminder',template_preview:'Hi Mona, your level is B1, IELTS.',template_components:[{type:'body',parameters:[{type:'text',text:'Mona'},{type:'text',text:'B1, IELTS'}]}]},
   {peer_identity:'201000000102',template_name:'class_reminder',template_preview:'Hi Sara, your level is to be confirmed.',template_components:[{type:'body',parameters:[{type:'text',text:'Sara'},{type:'text',text:'to be confirmed'}]}]},
  ]);
  // A retired audience reaches nobody rather than everybody.
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`UPDATE audiences SET state='retired' WHERE id=$1`,[fixture.audienceId]));
  const retired=await seedRun(h,{...at5pm,target:{type:'dynamic_audience',config:{audienceId:fixture.audienceId}}});
  await runner.execute(h.tenantId);await runner.execute(h.tenantId);
  expect((await runState(h,retired))['status']).toBe('failed');
 });

 it('finishes empty audiences, records unsupported targets, and contains a frozen-step mismatch',async()=>{
  const runner=h.app.get(AutomationRunnerService);
  const empty=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:randomUUID()}},steps:[{id:'noop',type:'condition',config:{}}]});
  await runner.execute(h.tenantId);expect((await runState(h,empty))['status']).toBe('completed');
  const unsupported=await seedRun(h,{...workflow,target:{type:'matching_conditions',config:{}},steps:[{id:'noop',type:'condition',config:{}}]});
  await runner.execute(h.tenantId);expect((await runState(h,unsupported))['status']).toBe('failed');

  const contactId=await withTenant(h.pool,h.tenantId,async(client)=>(await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Mismatch') RETURNING id::text`,[h.tenantId])).rows[0]!.id);
  const mismatch=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[{id:'gone',type:'condition',config:{}}]});
  await runner.execute(h.tenantId);
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`UPDATE automation_runs SET workflow_snapshot=jsonb_set(workflow_snapshot,'{steps}','[]'::jsonb) WHERE id=$1`,[mismatch]));
  await runner.execute(h.tenantId);expect((await runState(h,mismatch))['status']).toBe('failed');

  const terminal=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[{id:'noop',type:'condition',config:{}}]});
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`UPDATE automation_runs SET status='cancelled',completed_at=now() WHERE id=$1`,[terminal]));
  expect(await runner.execute(h.tenantId)).toBe(1);

  const conflict=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[{id:'noop',type:'condition',config:{}}]});
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`INSERT INTO automation_recipients(tenant_id,automation_run_id,customer_id,status) VALUES($1,$2,$3,'pending')`,[h.tenantId,conflict,contactId]));
  expect(await runner.execute(h.tenantId)).toBe(1);
  await withTenant(h.pool,h.tenantId,(client)=>client.query(`UPDATE automation_runs SET status='failed',completed_at=now() WHERE id=$1`,[conflict]));

  const partial=await seedRun(h,{...workflow,target:{type:'single_customer',config:{customerId:contactId}},steps:[{id:'noop',type:'condition',config:{}}]});
  await runner.execute(h.tenantId);
  const other=await withTenant(h.pool,h.tenantId,async(client)=>{
   const row=await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,display_name) VALUES($1,'Partial failure') RETURNING id::text`,[h.tenantId]);
   await client.query(`UPDATE automation_recipients SET status='completed',current_step=1,completed_at=now() WHERE automation_run_id=$1`,[partial]);
   await client.query(`UPDATE automation_action_executions SET state='completed',completed_at=now() WHERE automation_run_id=$1`,[partial]);
   await client.query(`INSERT INTO automation_recipients(tenant_id,automation_run_id,customer_id,status,failed_at) VALUES($1,$2,$3,'failed',now())`,[h.tenantId,partial,row.rows[0]!.id]);
   await client.query(`UPDATE automation_work_queue SET available_at=now()-interval '1 second' WHERE automation_run_id=$1`,[partial]);
   return row.rows[0]!.id;
  });
  expect(other).not.toBe('');await runner.execute(h.tenantId);expect((await runState(h,partial))['status']).toBe('partially_completed');
  expect(await runner.execute(h.tenantId)).toBe(0);
 });
});
