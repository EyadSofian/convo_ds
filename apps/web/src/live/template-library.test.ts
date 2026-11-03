import { describe,expect,it,vi } from 'vitest';
import { createState } from '../state.js';
import { ready,failed } from './store.js';
import type { LiveContext } from './actions.js';
import { openTemplateLibrary,saveTemplateAccess,pickLibraryResults,editTemplateAccess } from './template-library.js';
const error={status:503,code:'unavailable',message:'Try again',requestId:null,details:[]};
const item={id:'tpl',connectionId:'cn',connectionName:'Sales',name:'followup',language:'ar',category:'utility',status:'approved',body:'hello',visibility:'teams' as const,version:2,teamIds:['sales']};
const library={templates:[item],teams:[{id:'sales',name:'Sales'}]};
function setup(){const state=createState(new Date());state.lang='en';state.live.session={status:'signed_in',email:'admin@test',tenantId:'tenant',memberships:[]};const list=vi.fn().mockResolvedValue({ok:true,data:library});const update=vi.fn().mockResolvedValue({ok:true,data:{updated:1}});Object.assign(state.live,{channels:{templateLibrary:list,updateTemplateAccess:update}});const context={state,live:state.live,refresh:vi.fn(),now:()=>1}as unknown as LiveContext;return{state,context,list,update};}
describe('template library actions',()=>{
 it('loads and reloads without losing the admin’s current search',async()=>{
  const ctx=setup();expect(await openTemplateLibrary(ctx.context)).toBe(true);expect(ctx.state.dialog?.kind).toBe('template-library');ctx.state.dialogForm={librarySearch:'follow'};expect(await openTemplateLibrary(ctx.context,true)).toBe(true);expect(ctx.state.dialogForm.librarySearch).toBe('follow');ctx.list.mockResolvedValueOnce({ok:false,error});expect(await openTemplateLibrary(ctx.context,true)).toBe(false);expect(ctx.state.live.templateLibrary).toEqual(failed(error));ctx.state.live.busy='other';expect(await openTemplateLibrary(ctx.context)).toBe(false);
 });
 it('selects results, edits existing access and clears selections',()=>{
  const ctx=setup();expect(pickLibraryResults(ctx.context)).toBe(false);expect(editTemplateAccess(ctx.context,'tpl')).toBe(false);ctx.state.dialog={kind:'template-library',arg:''};ctx.state.live.templateLibrary=ready(library,1);expect(editTemplateAccess(ctx.context,'missing')).toBe(false);expect(editTemplateAccess(ctx.context,'tpl')).toBe(true);expect(ctx.state.dialogForm).toMatchObject({libraryPick_tpl:'true',libraryTeam_sales:'true',libraryVisibility:'teams',libraryPreview:'tpl'});expect(pickLibraryResults(ctx.context,true)).toBe(true);expect(ctx.state.dialogForm.libraryPick_tpl).toBe('false');expect(pickLibraryResults(ctx.context)).toBe(true);ctx.state.live.busy='saving';expect(pickLibraryResults(ctx.context)).toBe(false);expect(editTemplateAccess(ctx.context,'tpl')).toBe(false);
 });
 it('saves exactly the selected templates with expected versions and selected teams',async()=>{
  const ctx=setup();expect(await saveTemplateAccess(ctx.context)).toBe(false);await openTemplateLibrary(ctx.context);expect(await saveTemplateAccess(ctx.context)).toBe(false);editTemplateAccess(ctx.context,'tpl');ctx.state.lang='ar';ctx.state.dialogForm.libraryTeam_sales='false';expect(await saveTemplateAccess(ctx.context)).toBe(false);ctx.state.dialogForm.libraryTeam_sales='true';expect(await saveTemplateAccess(ctx.context)).toBe(true);expect(ctx.update).toHaveBeenCalledWith('tenant',{templates:[{id:'tpl',version:2}],visibility:'teams',teamIds:['sales']});expect(ctx.state.dialogForm.libraryPick_tpl).toBeUndefined();ctx.state.lang='ar';ctx.state.dialogForm={libraryPick_tpl:'true',libraryVisibility:'all'};expect(await saveTemplateAccess(ctx.context)).toBe(true);expect(ctx.update.mock.calls[1]?.[1].teamIds).toEqual([]);
 });
 it('retains edits after a refusal and refuses oversized or busy writes',async()=>{
  const ctx=setup();await openTemplateLibrary(ctx.context);editTemplateAccess(ctx.context,'tpl');ctx.update.mockResolvedValueOnce({ok:false,error});expect(await saveTemplateAccess(ctx.context)).toBe(false);expect(ctx.state.live.error).toEqual(error);expect(ctx.state.dialogForm.libraryPick_tpl).toBe('true');ctx.state.live.busy='other';expect(await saveTemplateAccess(ctx.context)).toBe(false);ctx.state.live.busy=null;ctx.state.live.templateLibrary=ready({teams:[],templates:Array.from({length:201},(_,i)=>({...item,id:String(i)}))},1);for(let i=0;i<201;i++)ctx.state.dialogForm[`libraryPick_${i}`]='true';expect(await saveTemplateAccess(ctx.context)).toBe(false);ctx.state.live.session={status:'signed_out',error:null};expect(await openTemplateLibrary(ctx.context)).toBe(false);
 });
});
