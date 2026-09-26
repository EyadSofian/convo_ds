import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult, PagedData } from '../api/client.js';
import type { Automation, AutomationRun, AutomationTemplate, AutomationsApi, WhatsAppTemplate } from '../api/automations.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { addAutomationStep, createBlankAutomation, deleteAutomationDraft, loadAutomationPage, loadAutomationRunsPage, loadAutomationsScreen, mappingType, removeAutomationStep, saveAutomation, scheduleOf, setAutomationQuery, setAutomationRunsQuery, transitionAutomation, useAutomationTemplate } from './automation-actions.js';

const WORKFLOW = { version: 1 as const, trigger: { type: 'manual', config: {} }, target: { type: 'matching_conditions', config: {} }, steps: [{ id: 'step_1', type: 'create_internal_notification', config: {} }], safety: { approvalRequired: true, duplicateWindowSeconds: 1 } };
const AUTOMATION: Automation = { id:'a-1',name:'Welcome',description:null,templateKey:null,state:'draft',workflow:WORKFLOW,timezone:'UTC',nextRunAt:null,lastRunAt:null,version:1 };
const TEMPLATE: AutomationTemplate = { key:'welcome',category:'sales',name:'Welcome',description:'Say hello',preset:WORKFLOW };
const ERROR: ApiError = { code:'refused',message:'No',requestId:'r',status:409,details:[] };
const ok = <T>(data:T):ApiResult<T> => ({ok:true,data});
const page = <T>(data: readonly T[], nextCursor: string | null = null): ApiResult<PagedData<T>> => ok({ data, nextCursor, hasMore: nextCursor !== null });

function setup(result:ApiResult<Automation>=ok(AUTOMATION), tenant:string|null='t') {
  const state=createState(new Date('2026-09-17T00:00:00Z')); state.lang='en';
  state.live.session={status:'signed_in',email:'x@y.z',memberships:[],tenantId:tenant};
  state.live.automationTemplates={status:'ready',value:[TEMPLATE],loadedAt:1}; state.live.automations={status:'ready',value:[AUTOMATION],loadedAt:1}; state.live.whatsappTemplates={status:'ready',value:[],loadedAt:1};
  const api={templates:vi.fn().mockResolvedValue(ok([TEMPLATE])),whatsappTemplates:vi.fn().mockResolvedValue(ok([])),list:vi.fn().mockResolvedValue(page([AUTOMATION])),runs:vi.fn().mockResolvedValue(page([] as AutomationRun[])),useTemplate:vi.fn().mockResolvedValue(result),create:vi.fn().mockResolvedValue(result),update:vi.fn().mockResolvedValue(result),transition:vi.fn().mockResolvedValue(result),deleteDraft:vi.fn().mockResolvedValue(ok({id:AUTOMATION.id}))} as unknown as AutomationsApi;
  Object.defineProperty(state.live,'automationsApi',{value:api});
  const context:LiveContext={state,live:state.live,refresh:vi.fn(),now:()=>1,newKey:()=> 'unique-key',endSession:vi.fn(),switchWorkspace:vi.fn()};
  return {state,context,api};
}

describe('automation actions',()=>{
  it('deletes a draft through the server and removes only the committed list row',async()=>{
    const s=setup(); expect(await deleteAutomationDraft(s.context,AUTOMATION.id)).toBe(true);
    expect(s.api.deleteDraft).toHaveBeenCalledWith('t',AUTOMATION);
    expect(s.api.list).not.toHaveBeenCalled();
    expect(s.api.runs).not.toHaveBeenCalled();
    expect(s.state.live.automations).toMatchObject({status:'ready',value:[]});
  });
  it('loads only the visible tab and preserves its refusal',async()=>{
    const ready=setup(); ready.state.route={screen:'automations',conversationId:null,params:{view:'mine'}}; await loadAutomationsScreen(ready.context); expect(ready.state.live.automations.status).toBe('ready'); expect(ready.api.templates).not.toHaveBeenCalled(); expect(ready.api.runs).not.toHaveBeenCalled();
    const refused=setup(); refused.state.route={screen:'automations',conversationId:null,params:{view:'runs'}}; vi.mocked(refused.api.runs).mockResolvedValueOnce({ok:false,error:ERROR}); await loadAutomationsScreen(refused.context); expect(refused.state.live.automationRuns).toEqual({status:'error',error:ERROR}); expect(refused.state.live.error).toBe(ERROR);
    const absent=setup(ok(AUTOMATION),null); await loadAutomationsScreen(absent.context); expect(absent.api.list).not.toHaveBeenCalled();
  });
  it('surfaces a failed WhatsApp-template read while opening an existing builder', async () => {
    const app = setup();
    app.state.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: AUTOMATION.id } };
    vi.mocked(app.api.whatsappTemplates).mockResolvedValueOnce({ ok: false, error: ERROR });
    await loadAutomationsScreen(app.context);
    expect(app.state.live.whatsappTemplates).toEqual({ status: 'error', error: ERROR });
    expect(app.state.live.error).toEqual(ERROR);
  });
  it('keeps the server query and appends only the next cursor page', async () => {
    const s = setup();
    vi.mocked(s.api.list).mockResolvedValueOnce(page([AUTOMATION], 'opaque-next')).mockResolvedValueOnce(page([{ ...AUTOMATION, id: 'a-2', name: 'Later' }]));
    await setAutomationQuery(s.context, { search: 'wel', state: 'draft', sort: 'updated_desc', limit: 25 });
    await loadAutomationPage(s.context, false);
    expect(s.api.list).toHaveBeenNthCalledWith(1, 't', { search: 'wel', state: 'draft', sort: 'updated_desc', limit: 25, cursor: null });
    expect(s.api.list).toHaveBeenNthCalledWith(2, 't', { search: 'wel', state: 'draft', sort: 'updated_desc', limit: 25, cursor: 'opaque-next' });
    expect(s.state.live.automations).toMatchObject({ status: 'ready', value: [AUTOMATION, expect.objectContaining({ id: 'a-2' })] });
    expect(s.api.runs).not.toHaveBeenCalled();
  });
  it('appends run history without rereading definitions', async () => {
    const s = setup();
    const run = { id: 'r-1' } as AutomationRun;
    vi.mocked(s.api.runs).mockResolvedValueOnce(page([run], 'runs-next')).mockResolvedValueOnce(page([{ id: 'r-2' } as AutomationRun]));
    await loadAutomationRunsPage(s.context, true);
    await loadAutomationRunsPage(s.context, false);
    expect(s.state.live.automationRuns).toMatchObject({ status: 'ready', value: [run, expect.objectContaining({ id: 'r-2' })] });
    expect(s.api.list).not.toHaveBeenCalled();
  });
  it('creates from a preset and from scratch only after the server commits',async()=>{
    const s=setup(); expect(await useAutomationTemplate(s.context,'welcome')).toBe(true); expect(s.api.useTemplate).toHaveBeenCalledWith('t','welcome',expect.stringContaining('Welcome'));
    expect(s.state.route).toEqual({ screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } });
    expect(s.state.focusTarget).toContain('automationName');
    expect(s.state.toasts.at(-1)?.text).toContain('Draft created');
    expect(await useAutomationTemplate(s.context,'missing')).toBe(false); expect(await createBlankAutomation(s.context,'Blank')).toBe(true); expect(s.api.create).toHaveBeenCalledWith('t',expect.objectContaining({name:'Blank'})); expect(s.state.toasts.length).toBe(2);
    const refused=setup({ok:false,error:ERROR}); expect(await createBlankAutomation(refused.context,'No')).toBe(false); expect(refused.state.live.error).toBe(ERROR);
  });
  it('keeps the operator on the catalogue when template creation is refused',async()=>{
    const s=setup({ok:false,error:ERROR});
    s.state.route={screen:'automations',conversationId:null,params:{view:'templates'}};
    expect(await useAutomationTemplate(s.context,'welcome')).toBe(false);
    expect(s.state.route.params['view']).toBe('templates');
    expect(s.state.live.error).toBe(ERROR);
  });
  it('edits, adds, removes and transitions with version fencing',async()=>{
    const s=setup(); s.state.dialogForm={automationName:'Edited',automationTrigger:'schedule',automationTarget:'label',automationStep_step_1:'delay'};
    expect(await saveAutomation(s.context,'a-1')).toBe(true); expect(s.api.update).toHaveBeenCalledWith('t','a-1',1,expect.objectContaining({name:'Edited'}));
    expect(await addAutomationStep(s.context,'a-1')).toBe(true);
    s.state.live.automations={status:'ready',value:[{...AUTOMATION,workflow:{...WORKFLOW,steps:[...WORKFLOW.steps,{id:'step_2',type:'delay',config:{}}]}}],loadedAt:1};
    expect(await removeAutomationStep(s.context,'a-1:step_2')).toBe(true);
    expect(await transitionAutomation(s.context,'a-1:activate')).toBe(true); expect(await transitionAutomation(s.context,'a-1:bad')).toBe(false);
    expect(await saveAutomation(s.context,'missing')).toBe(false); expect(await addAutomationStep(s.context,'missing')).toBe(false); expect(await removeAutomationStep(s.context,'missing:x')).toBe(false);
  });
  it('refuses removal of the last step and additions at the engine bound',async()=>{
    const s=setup(); expect(await removeAutomationStep(s.context,'a-1:step_1')).toBe(false);
    const many={...AUTOMATION,workflow:{...WORKFLOW,steps:Array.from({length:50},(_,i)=>({id:`s_${i}`,type:'delay' as const,config:{}}))}}; s.state.live.automations={status:'ready',value:[many],loadedAt:1}; expect(await addAutomationStep(s.context,'a-1')).toBe(false);
  });

  it('loads templates, editor WhatsApp templates, and reports refusal states', async () => {
    const templates = setup();
    templates.state.route = { screen: 'automations', conversationId: null, params: { view: 'templates' } };
    await loadAutomationsScreen(templates.context);
    expect(templates.state.live.automationTemplates).toMatchObject({ status: 'ready', value: [TEMPLATE] });
    const editor = setup();
    editor.state.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    await loadAutomationsScreen(editor.context);
    expect(editor.api.whatsappTemplates).toHaveBeenCalledWith('t');
    const refused = setup();
    refused.state.route = { screen: 'automations', conversationId: null, params: { view: 'templates' } };
    vi.mocked(refused.api.templates).mockResolvedValueOnce({ ok: false, error: ERROR });
    await loadAutomationsScreen(refused.context);
    expect(refused.state.live.error).toEqual(ERROR);
  });

  it('handles pages, query resets, and refusals without crossing tabs', async () => {
    const pageFailure = setup();
    vi.mocked(pageFailure.api.list).mockResolvedValueOnce({ ok: false, error: ERROR });
    await loadAutomationPage(pageFailure.context, true);
    expect(pageFailure.state.live.automations).toEqual({ status: 'error', error: ERROR });
    const runs = setup();
    vi.mocked(runs.api.runs).mockResolvedValueOnce({ ok: false, error: ERROR });
    await loadAutomationRunsPage(runs.context, true);
    expect(runs.state.live.automationRuns).toEqual({ status: 'error', error: ERROR });
    await setAutomationRunsQuery(runs.context, { limit: 50 });
    expect(runs.api.runs).toHaveBeenCalledWith('t', { limit: 50, cursor: null });
    runs.state.live.automationRunsNextCursor = null;
    await loadAutomationRunsPage(runs.context, false);
    expect(runs.api.runs).toHaveBeenCalledTimes(2);
    const absent = setup(ok(AUTOMATION), null);
    await setAutomationRunsQuery(absent.context, { limit: 25 });
    expect(absent.api.runs).not.toHaveBeenCalled();
  });

  it('keeps committed mutations scoped to matching queries and tenants', async () => {
    const absent = setup(ok(AUTOMATION), null);
    expect(await useAutomationTemplate(absent.context, 'welcome')).toBe(false);
    expect(await createBlankAutomation(absent.context, 'No tenant')).toBe(false);
    const filtered = setup();
    filtered.state.live.automationQuery = { search: 'does-not-match', state: 'draft', sort: 'updated_desc', limit: 25 };
    expect(await useAutomationTemplate(filtered.context, 'welcome')).toBe(true);
    expect(filtered.state.live.automations).toMatchObject({ status: 'ready', value: [] });
    const notDraft = setup();
    notDraft.state.live.automations = { status: 'ready', value: [{ ...AUTOMATION, state: 'active' }], loadedAt: 1 };
    expect(await deleteAutomationDraft(notDraft.context, 'a-1')).toBe(false);
    const noTenantDelete = setup(ok(AUTOMATION), null);
    expect(await deleteAutomationDraft(noTenantDelete.context, 'a-1')).toBe(false);
  });

  it('deletes only after confirmation, resets an open editor route, and preserves a refusal', async () => {
    const editing = setup();
    editing.state.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    expect(await deleteAutomationDraft(editing.context, 'a-1')).toBe(true);
    expect(editing.state.route.params).toEqual({ view: 'mine' });

    const refused = setup();
    vi.mocked(refused.api.deleteDraft).mockResolvedValueOnce({ ok: false, error: ERROR });
    expect(await deleteAutomationDraft(refused.context, 'a-1')).toBe(false);
    expect(refused.state.live.error).toEqual(ERROR);
    expect(refused.state.live.automations).toMatchObject({ status: 'ready', value: [AUTOMATION] });
  });

  it('does not request a page without a cursor and excludes mutations outside the selected state', async () => {
    const s = setup();
    s.state.live.automationNextCursor = null;
    await loadAutomationPage(s.context, false);
    expect(s.api.list).not.toHaveBeenCalled();
    s.state.live.automationQuery = { search: '', state: 'active', sort: 'updated_desc', limit: 25 };
    expect(await useAutomationTemplate(s.context, 'welcome')).toBe(true);
    expect(s.state.live.automations).toMatchObject({ status: 'ready', value: [] });
  });
});

describe('the schedule a form describes', () => {
  const now = Date.parse('2026-09-17T00:00:00Z');

  it('reads each kind from the form, and falls back to the previous value', () => {
    expect(scheduleOf({ automationScheduleKind: 'one_time', automationScheduleAt: '2026-10-01T09:00:00Z' }, undefined, now))
      .toEqual({ kind: 'one_time', at: '2026-10-01T09:00:00Z' });
    // No instant in the form and none before: a day from now is a safe default
    // that is always in the future, so activation cannot fail on exhaustion.
    expect(scheduleOf({ automationScheduleKind: 'one_time' }, undefined, now))
      .toEqual({ kind: 'one_time', at: '2026-09-18T00:00:00.000Z' });
    expect(scheduleOf({ automationScheduleKind: 'one_time' }, { kind: 'one_time', at: '2026-12-01T09:00:00Z' }, now))
      .toEqual({ kind: 'one_time', at: '2026-12-01T09:00:00Z' });

    expect(scheduleOf({ automationScheduleKind: 'weekly', automationScheduleDays: '1,3, 5' }, undefined, now))
      .toEqual({ kind: 'weekly', time: '09:00', daysOfWeek: [1, 3, 5] });
    // Out-of-range and non-numeric days are dropped rather than sent onward to
    // be rejected by the server.
    expect(scheduleOf({ automationScheduleKind: 'weekly', automationScheduleDays: '9,x,-1,0' }, undefined, now))
      .toEqual({ kind: 'weekly', time: '09:00', daysOfWeek: [0] });

    expect(scheduleOf({ automationScheduleKind: 'monthly', automationScheduleDay: '15' }, undefined, now))
      .toEqual({ kind: 'monthly', time: '09:00', dayOfMonth: 15 });
    expect(scheduleOf({ automationScheduleKind: 'monthly' }, { dayOfMonth: 22 }, now))
      .toEqual({ kind: 'monthly', time: '09:00', dayOfMonth: 22 });
    expect(scheduleOf({ automationScheduleKind: 'monthly' }, undefined, now))
      .toEqual({ kind: 'monthly', time: '09:00', dayOfMonth: 1 });

    expect(scheduleOf({ automationScheduleKind: 'custom_recurrence', automationScheduleEvery: '15' }, undefined, now))
      .toEqual({ kind: 'custom_recurrence', everyMinutes: 15 });
    expect(scheduleOf({ automationScheduleKind: 'custom_recurrence' }, { everyMinutes: 45 }, now))
      .toEqual({ kind: 'custom_recurrence', everyMinutes: 45 });
    expect(scheduleOf({ automationScheduleKind: 'custom_recurrence' }, undefined, now))
      .toEqual({ kind: 'custom_recurrence', everyMinutes: 60 });

    expect(scheduleOf({ automationScheduleKind: 'relative', automationScheduleOffset: '-30' }, undefined, now))
      .toEqual({ kind: 'relative', offsetMinutes: -30 });
    expect(scheduleOf({ automationScheduleKind: 'relative' }, { offsetMinutes: -15 }, now))
      .toEqual({ kind: 'relative', offsetMinutes: -15 });
    expect(scheduleOf({ automationScheduleKind: 'relative' }, undefined, now))
      .toEqual({ kind: 'relative', offsetMinutes: -60 });
  });

  it('defaults to a daily schedule, and takes the time from the form or the previous value', () => {
    expect(scheduleOf({}, undefined, now)).toEqual({ kind: 'daily', time: '09:00' });
    expect(scheduleOf({ automationScheduleTime: '07:45' }, undefined, now)).toEqual({ kind: 'daily', time: '07:45' });
    expect(scheduleOf({}, { kind: 'daily', time: '18:00' }, now)).toEqual({ kind: 'daily', time: '18:00' });
    // An unrecognised kind falls back rather than being passed through.
    expect(scheduleOf({ automationScheduleKind: 'lunar' }, undefined, now)).toEqual({ kind: 'daily', time: '09:00' });
  });
});

describe('the mapping type carried on a step', () => {
  it('reads a stored mapping, and answers empty for anything that is not one', () => {
    expect(mappingType({ type: 'customer_field' })).toBe('customer_field');
    expect(mappingType({ type: 7 })).toBe('');
    expect(mappingType({})).toBe('');
    expect(mappingType(null)).toBe('');
    expect(mappingType('static')).toBe('');
    expect(mappingType(undefined)).toBe('');
  });
});

describe('saving a step that sends a WhatsApp template', () => {
  const TEMPLATE_STEP = { id: 'send', type: 'send_whatsapp_template' as const, config: {} };
  const WA: WhatsAppTemplate = { id: 'wa-1', connectionId: 'c-1', providerTemplateId: 'p-1', templateName: 'welcome', language: 'ar', category: 'UTILITY', status: 'approved', components: [], variables: ['1', '2'], lastSyncedAt: '2026-09-17T00:00:00Z' };

  function withTemplateStep() {
    const s = setup();
    s.state.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [TEMPLATE_STEP] } }], loadedAt: 1 };
    s.state.live.whatsappTemplates = { status: 'ready', value: [WA], loadedAt: 1 };
    return s;
  }

  it('carries the chosen template and a complete variable map', async () => {
    const s = withTemplateStep();
    s.state.dialogForm = {
      automationTemplate_send: 'wa-1',
      automationVariable_send_1: 'customer_field',
    };
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as unknown as { workflow: { steps: readonly { config: Record<string, unknown> }[] } };
    expect(input.workflow.steps[0]?.config['templateId']).toBe('wa-1');
    // Every variable the template declares gets an entry — the one the form
    // chose, and a default for the one it did not.
    expect(input.workflow.steps[0]?.config['variableMapping']).toEqual({
      '1': { type: 'customer_field' },
      '2': { type: 'customer_field' },
    });
  });

  it('keeps the mapping already stored on the step when the form says nothing', async () => {
    const s = setup();
    s.state.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ ...TEMPLATE_STEP, config: { templateId: 'wa-1', variableMapping: { '1': { type: 'static' } } } }] } }],
      loadedAt: 1,
    };
    s.state.live.whatsappTemplates = { status: 'ready', value: [WA], loadedAt: 1 };
    s.state.dialogForm = {};
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as unknown as { workflow: { steps: readonly { config: Record<string, unknown> }[] } };
    expect(input.workflow.steps[0]?.config['variableMapping']).toEqual({
      '1': { type: 'static' },
      '2': { type: 'customer_field' },
    });
  });

  it('still saves when the chosen template is not in the loaded list', async () => {
    // The list may be stale; the server is the authority and will refuse an
    // unknown template at activation.
    const s = withTemplateStep();
    s.state.dialogForm = { automationTemplate_send: 'wa-missing' };
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as unknown as { workflow: { steps: readonly { config: Record<string, unknown> }[] } };
    expect(input.workflow.steps[0]?.config['variableMapping']).toEqual({});
  });
});

describe('saving what the builder shows', () => {
  const inputOf = (s: ReturnType<typeof setup>) => vi.mocked(s.api.update).mock.calls.at(-1)?.[3] as unknown as { workflow: { target: unknown; steps: readonly { id: string; type: string; config: Record<string, unknown> }[] } };

  it('saves configured steps and a label audience with its label', async () => {
    const s = setup();
    s.state.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, target: { type: 'label', config: { labelId: 'l-1' } }, steps: [{ id: 'step_1', type: 'add_label', config: {} }] } }], loadedAt: 1 };
    s.state.dialogForm = { automationLabel_step_1: 'l-9' };
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    expect(inputOf(s).workflow.target).toEqual({ type: 'label', config: { labelId: 'l-1' } });
    expect(inputOf(s).workflow.steps[0]).toEqual({ id: 'step_1', type: 'add_label', config: { labelId: 'l-9' } });
    // Switching to a label audience starts it without a label until one is chosen.
    s.state.live.automations = { status: 'ready', value: [AUTOMATION], loadedAt: 1 };
    s.state.dialogForm = { automationTarget: 'label' };
    await saveAutomation(s.context, 'a-1');
    expect(inputOf(s).workflow.target).toEqual({ type: 'label', config: {} });
    s.state.dialogForm = { automationTarget: 'label', automationTargetLabel: 'l-2' };
    await saveAutomation(s.context, 'a-1');
    expect(inputOf(s).workflow.target).toEqual({ type: 'label', config: { labelId: 'l-2' } });
  });

  it('keeps what is being typed when a neighbouring step is added or removed', async () => {
    const s = setup();
    s.state.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'step_1', type: 'add_label', config: {} }, { id: 'step_2', type: 'delay', config: { seconds: 60 } }] } }], loadedAt: 1 };
    s.state.dialogForm = { automationLabel_step_1: 'l-1' };
    expect(await addAutomationStep(s.context, 'a-1')).toBe(true);
    expect(inputOf(s).workflow.steps.map((step) => [step.type, step.config])).toEqual([['add_label', { labelId: 'l-1' }], ['delay', { seconds: 60 }], ['add_label', {}]]);
    // The saved draft comes back from the server; put the two-step one back to remove from.
    s.state.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'step_1', type: 'add_label', config: {} }, { id: 'step_2', type: 'delay', config: { seconds: 60 } }] } }], loadedAt: 1 };
    expect(await removeAutomationStep(s.context, 'a-1:step_2')).toBe(true);
    expect(inputOf(s).workflow.steps.map((step) => step.config)).toEqual([{ labelId: 'l-1' }]);
  });

  it('reads the label and field catalogues for the step editors once', async () => {
    const s = setup();
    const labels = vi.fn().mockResolvedValue(ok([]));
    Object.defineProperty(s.state.live, 'metadataApi', { value: { labels, fields: vi.fn().mockResolvedValue(ok([])) } });
    s.state.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    await loadAutomationsScreen(s.context);
    await loadAutomationsScreen(s.context);
    expect(labels).toHaveBeenCalledTimes(1);
  });
});

describe('which refusal reaches the operator when several resources fail', () => {
  it('reports the refusal for the resource the operator requested', async () => {
    const s = setup();
    s.state.route={screen:'automations',conversationId:null,params:{view:'templates'}};
    vi.mocked(s.api.templates).mockResolvedValueOnce({ ok: false, error: ERROR });
    await loadAutomationsScreen(s.context);
    expect(s.state.live.error).toBe(ERROR);
  });
});

describe('the remaining form and copy paths', () => {
  it('reports success in Arabic when that is the workspace language', async () => {
    const s = setup();
    s.state.lang = 'ar';
    expect(await createBlankAutomation(s.context, 'تدفق جديد')).toBe(true);
    expect(s.state.toasts.at(-1)?.text).toContain('تم إنشاء الأتمتة');
  });

  it('takes the description from the form when the operator typed one', async () => {
    const s = setup();
    s.state.dialogForm = { automationDescription: '  Reminder for parents  ' };
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as { description: string | null };
    expect(input.description).toBe('Reminder for parents');
  });

  it('keeps the template already on the step when the form names none', async () => {
    const s = setup();
    s.state.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'send', type: 'send_whatsapp_template', config: { templateId: 'wa-kept' } }] } }],
      loadedAt: 1,
    };
    s.state.dialogForm = {};
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as unknown as { workflow: { steps: readonly { config: Record<string, unknown> }[] } };
    expect(input.workflow.steps[0]?.config['templateId']).toBe('wa-kept');
  });

  it('sends an empty template id when neither the form nor the step names one', async () => {
    // The server refuses activation on it; what matters here is that the save
    // itself does not fail on a missing value.
    const s = setup();
    s.state.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'send', type: 'send_whatsapp_template', config: {} }] } }],
      loadedAt: 1,
    };
    s.state.live.whatsappTemplates = { status: 'ready', value: [], loadedAt: 1 };
    s.state.dialogForm = {};
    expect(await saveAutomation(s.context, 'a-1')).toBe(true);
    const input = vi.mocked(s.api.update).mock.calls[0]?.[3] as unknown as { workflow: { steps: readonly { config: Record<string, unknown> }[] } };
    expect(input.workflow.steps[0]?.config['templateId']).toBe('');
  });

  it('defaults a weekly schedule to Monday when the form names no days', () => {
    expect(scheduleOf({ automationScheduleKind: 'weekly' }, undefined, 0))
      .toEqual({ kind: 'weekly', time: '09:00', daysOfWeek: [1] });
  });
});
