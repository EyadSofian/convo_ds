// @vitest-environment happy-dom
import { describe,expect,it } from 'vitest';
import { createState } from '../state.js';
import { ready, failed, LOADING } from '../live/store.js';
import { templateLibraryDialog,filterLibrary } from './template-library.js';
import { renderDialog } from './dialogs.js';
import type { TemplateLibraryItem } from '../api/channels.js';
const item:TemplateLibraryItem={id:'tpl',connectionId:'cn',connectionName:'Sales line',name:'course_followup',language:'ar_EG',category:'utility',status:'approved',body:'أهلاً بحضرتك بخصوص التسجيل',visibility:'teams',version:2,teamIds:['sales']};
function setup(){const state=createState(new Date());state.lang='en';state.dialog={kind:'template-library',arg:''};state.live.templateLibrary=ready({templates:[item,{...item,id:'other',name:'promo',language:'en',category:'marketing',visibility:'all',status:'paused'}],teams:[{id:'sales',name:'Sales'}]},1);return state;}
describe('template library administration UI',()=>{
 it('renders library search, counts, preview, team badges and filters inside the real dialog',()=>{
  const state=setup();const dialog=renderDialog(state)!;
  expect(dialog.textContent).toContain('Template library & teams');expect(dialog.textContent).toContain('2 of 2 templates');expect(dialog.textContent).toContain('Sales');
  expect(dialog.querySelector('[data-form="librarySearch"]')).not.toBeNull();
  expect(dialog.querySelector('[data-act="live-template-library-save"]')?.hasAttribute('disabled')).toBe(true);
  state.dialogForm={libraryPick_tpl:'true',libraryVisibility:'teams',libraryTeam_sales:'true'};
  expect(templateLibraryDialog(state).querySelector('[data-act="live-template-library-save"]')?.hasAttribute('disabled')).toBe(false);
 });
 it('searches Arabic text, template names and sending lines, and combines filters',()=>{
  const state=setup();const templates=state.live.templateLibrary.status==='ready'?state.live.templateLibrary.value.templates:[];
  for(const search of ['اهلا','course','Sales line','ar_EG','utility']){state.dialogForm={librarySearch:search};expect(filterLibrary(state,templates).map(x=>x.id)).toContain('tpl');}
  state.dialogForm={libraryFilter_language:'en',libraryFilter_category:'marketing',libraryFilter_connectionId:'cn',libraryFilter_visibility:'all'};
  expect(filterLibrary(state,templates).map(x=>x.id)).toEqual(['other']);
  state.dialogForm={librarySearch:'missing'};expect(templateLibraryDialog(state).textContent).toContain('No matches');
 });
 it('handles loading, errors, missing teams, unavailable mappings, and busy states',()=>{
  const state=setup();state.live.templateLibrary=LOADING;expect(templateLibraryDialog(state).textContent).toContain('Loading library');
  const error={status:503,code:'unavailable',message:'Try again',requestId:null,details:[]};state.live.templateLibrary=failed(error);expect(templateLibraryDialog(state).textContent).toContain('server');
  state.live.templateLibrary=ready({templates:[],teams:[]},1);state.dialogForm={libraryVisibility:'teams'};expect(templateLibraryDialog(state).textContent).toContain('Create a team');
  state.live.templateLibrary=ready({templates:[{...item,teamIds:['retired']},{...item,id:'empty',teamIds:[]}],teams:[]},1);state.dialogForm={libraryVisibility:'teams',libraryPick_tpl:'true',libraryPreview:'empty',libraryFilter_visibility:'teams'};
  expect(templateLibraryDialog(state).textContent).toContain('Archived team');expect(templateLibraryDialog(state).textContent).toContain('No active team');
  state.live.busy='template-access-save';state.live.error=error;state.formErrors={templateLibrary:'Choose a team'};expect(templateLibraryDialog(state).textContent).toContain('Choose a team');
  state.lang='ar';expect(templateLibraryDialog(state).textContent).toContain('مكتبة القوالب');
 });
});
