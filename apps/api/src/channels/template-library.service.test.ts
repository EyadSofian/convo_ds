import { describe, expect, it, vi } from 'vitest';
import type { Principal, SqlExecutor } from '@convo/domain';
import { TemplateLibraryService } from './template-library.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import { requireTemplateAccess, templateAccessPredicate } from './template-access.js';

const id='aaaaaaaa-1111-4111-8111-111111111111';
const team='bbbbbbbb-2222-4222-8222-222222222222';
const principal:Principal={membershipId:id,membershipStatus:'active',tenantStatus:'active',grants:{'channel.manage':'tenant'},scopes:[],delegationCeiling:null};
const input={templates:[{id,version:1}],visibility:'teams',teamIds:[team]};
function setup(options:{principal?:Principal;missing?:boolean;version?:number;teamMissing?:boolean}={}){
 const query=vi.fn(async<T>(text:string)=>{
  if(text.includes('ORDER BY id FOR UPDATE'))return{rows:(options.missing?[]:[{id,connection_id:id,access_version:options.version??1}]) as T[],rowCount:1};
  if(text.includes('FROM teams WHERE id='))return{rows:(options.teamMissing?[]:[{id:team}])as T[],rowCount:1};
  if(text.includes('FROM teams WHERE archived'))return{rows:[{id:team,name:'Sales'}]as T[],rowCount:1};
  if(text.includes('FROM whatsapp_templates t'))return{rows:[{id,connectionId:id,connectionName:'Admissions',name:'follow_up',language:'ar',category:'utility',status:'approved',visibility:'all',version:1,teamIds:[],components:[{type:'BODY',text:'Hello'},{type:'HEADER',format:'IMAGE'}]}]as T[],rowCount:1};
  return{rows:[]as T[],rowCount:0};
 });
 const sql={query}as unknown as SqlExecutor;
 const auth={authorized:vi.fn(async(_s,_t,_p,work)=>work({sql,principal:options.principal??principal}))}as unknown as AuthorizationService;
 return{service:new TemplateLibraryService(auth),query};
}
describe('template team administration',()=>{
 it('rejects malformed, oversized, duplicate and inconsistent edits',async()=>{
  const {service}=setup();
  for(const body of [null,[],42,{}, {...input,visibility:'bad'}, {...input,teamIds:null}, {...input,teamIds:['bad']}, {...input,teamIds:Array(101).fill(team)}, {...input,templates:null}, {...input,templates:[]}, {...input,templates:Array(201).fill({id,version:1})}, {...input,templates:[null]}, {...input,templates:[{id:'bad',version:1}]}, {...input,templates:[{id,version:0}]}, {...input,templates:[{id,version:1.5}]}, {...input,templates:[{id,version:1},{id,version:1}]}, {...input,templates:[{id,version:1},{id:id.toUpperCase(),version:1}]}, {...input,teamIds:[team,team.toUpperCase()]}, {...input,teamIds:[team,team]}, {...input,teamIds:[]}, {...input,visibility:'all'}])await expect(service.update({}as never,id,body)).rejects.toMatchObject({status:400});
 });
 it('checks resource existence, versions, scoped administration, and active teams before mutation',async()=>{
  await expect(setup({missing:true}).service.update({}as never,id,input)).rejects.toMatchObject({status:404});
  await expect(setup({version:2}).service.update({}as never,id,input)).rejects.toMatchObject({status:409});
  await expect(setup({teamMissing:true}).service.update({}as never,id,input)).rejects.toMatchObject({status:400});
  await expect(setup({principal:{...principal,grants:{}}}).service.update({}as never,id,input)).rejects.toMatchObject({status:403});
  const good=setup();expect(await good.service.update({email:'admin@test'}as never,id,input)).toEqual({updated:1});
  expect(await good.service.update({email:'admin@test'}as never,id,{...input,templates:[{id:id.toUpperCase(),version:1}]})).toEqual({updated:1});
  expect(good.query).toHaveBeenCalledWith(expect.stringContaining('admin_audit_events'),expect.any(Array));
 });
 it('returns safe previews and filters out templates the manager cannot administer',async()=>{
  expect((await setup().service.list({}as never,id)).templates[0]).toMatchObject({body:'Hello',name:'follow_up'});
  expect((await setup({principal:{...principal,grants:{}}}).service.list({}as never,id)).templates).toEqual([]);
 });
 it('checks team access for every non-administrator',async()=>{
  expect(templateAccessPredicate(principal,()=>{throw Error('no binding needed');})).toBe('TRUE');
  const member={...principal,grants:{}};
  expect(templateAccessPredicate(member,()=>'$2','t')).toContain('access.template_id=t.id');
  const denied={query:vi.fn().mockResolvedValue({rows:[{allowed:false}]})}as unknown as SqlExecutor;
  await expect(requireTemplateAccess(denied,member,id)).rejects.toMatchObject({status:403,code:'template_access_denied'});
  const allowed={query:vi.fn().mockResolvedValue({rows:[{}]})}as unknown as SqlExecutor;
  await expect(requireTemplateAccess(allowed,member,id)).resolves.toBeUndefined();
 });
});
