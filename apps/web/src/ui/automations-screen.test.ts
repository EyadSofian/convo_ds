/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun, AutomationTemplate } from '../api/automations.js';
import { createState } from '../state.js';
import type { AppState } from '../state.js';
import { renderAutomations } from './automations-screen.js';

const NOW=new Date('2026-09-17T10:00:00Z');
const WORKFLOW={version:1 as const,trigger:{type:'schedule',config:{}},target:{type:'dynamic_audience',config:{}},steps:[{id:'step_1',type:'send_whatsapp_template',config:{}},{id:'step_2',type:'delay',config:{}}],safety:{approvalRequired:true,duplicateWindowSeconds:60}};
const TEMPLATE:AutomationTemplate={key:'class',category:'academic',name:'Class Reminder',description:'Before class',preset:WORKFLOW};
const AUTOMATION:Automation={id:'a-1',name:'Reminder',description:null,templateKey:'class',state:'draft',workflow:WORKFLOW,timezone:'Africa/Cairo',nextRunAt:null,lastRunAt:null,version:1};
const RUN:AutomationRun={id:'r-1',automation_id:'a-1',status:'completed',mode:'test',scheduled_for:NOW.toISOString(),started_at:NOW.toISOString(),completed_at:NOW.toISOString(),trigger_type:'schedule',audience_count:3,queued_count:3,sent_count:3,delivered_count:2,failed_count:0,skipped_count:0,error:null};

function state(view='templates', permissions=['automation.read','automation.create','automation.edit']){
 const state=createState(NOW); state.lang='en'; state.route={screen:'automations',conversationId:null,params:{view}};
 state.live.session={status:'signed_in',email:'a@b.c',tenantId:'t',memberships:[{id:'m',tenant:{id:'t',name:'School',slug:'school'},role:{id:'r',key:'owner',name:'Owner'},permissions}]};
 state.live.automationTemplates={status:'ready',value:[TEMPLATE,{...TEMPLATE,key:'blank',category:'custom',name:'Blank'}],loadedAt:1}; state.live.automations={status:'ready',value:[AUTOMATION],loadedAt:1}; state.live.automationRuns={status:'ready',value:[RUN],loadedAt:1}; return state;
}

describe('automation screen',()=>{
 it('distinguishes loading, refusal and the editable template catalogue',()=>{
  const s=state(); s.live.automationTemplates={status:'loading'}; expect(renderAutomations(s).querySelector('[aria-busy="true"]')).not.toBeNull();
  s.live.automationTemplates={status:'error',error:{code:'x',message:'x',requestId:'req',status:500,details:[]}}; expect(renderAutomations(s).textContent).toContain('req');
  s.live.automationTemplates={status:'ready',value:[TEMPLATE],loadedAt:1}; const root=renderAutomations(s); expect(root.textContent).toContain('Start with a proven flow'); expect(root.querySelector('[data-act="live-automation-use"]')).not.toBeNull(); expect(root.querySelector('[data-act="live-automation-create"]')).not.toBeNull();
  const denied=state('templates',['automation.read']); expect(renderAutomations(denied).querySelector('[data-act="live-automation-use"]')).toBeNull();
 });
 it('shows empty and populated automation lists with state-aware actions',()=>{
  const s=state('mine'); s.live.automations={status:'idle'}; expect(renderAutomations(s).querySelector('[aria-busy="true"]')).not.toBeNull(); s.live.automations={status:'ready',value:[],loadedAt:1}; expect(renderAutomations(s).textContent).toContain('No matching automations');
  s.live.automations={status:'ready',value:[AUTOMATION,{...AUTOMATION,id:'a-2',state:'active',name:'Live'},{...AUTOMATION,id:'a-3',state:'paused',name:'Paused'},{...AUTOMATION,id:'a-4',state:'archived',name:'Old'}],loadedAt:1}; const root=renderAutomations(s); expect(root.textContent).toContain('Editable workflow'); expect(root.querySelector('[data-arg="a-2:pause"]')).not.toBeNull(); expect(root.querySelector('[data-arg="a-3:resume"]')).not.toBeNull(); expect(root.querySelector('[data-arg="a-4:activate"]')).toBeNull();
  s.live.automationNextCursor='next'; expect(renderAutomations(s).querySelector('[data-act="live-automation-load-more"]')).not.toBeNull();
 });
 it('renders the sequential builder without exposing JSON',()=>{
  const s=state('mine'); s.route={screen:'automations',conversationId:null,params:{view:'mine',edit:'a-1'}}; s.live.whatsappTemplates={status:'ready',value:[{id:'wa-1',connectionId:'c',providerTemplateId:'p',templateName:'class_reminder',language:'en',category:'UTILITY',status:'approved',components:[],variables:['1'],lastSyncedAt:NOW.toISOString()}],loadedAt:1}; const root=renderAutomations(s); expect(root.querySelectorAll('.workflow-block').length).toBe(4); expect(root.textContent).toContain('Execution safety'); expect(root.textContent).toContain('class_reminder'); expect(root.textContent).not.toContain('"trigger"'); expect(root.querySelector('[data-act="live-automation-add-step"]')).not.toBeNull();
 });
 it('shows run evidence, empty history and load failures',()=>{
  const s=state('runs'); let root=renderAutomations(s); expect(root.textContent).toContain('TEST'); expect(root.textContent).toContain('Delivered');
  s.live.automationRunsNextCursor='next'; expect(renderAutomations(s).querySelector('[data-act="live-automation-runs-load-more"]')).not.toBeNull();
  s.live.automationRuns={status:'ready',value:[],loadedAt:1}; root=renderAutomations(s); expect(root.textContent).toContain('No runs yet');
  s.live.automationRuns={status:'error',error:{code:'x',message:'x',requestId:'run-req',status:500,details:[]}}; expect(renderAutomations(s).textContent).toContain('run-req');
 });
});

describe('configuring each step', () => {
  function builder(steps: Record<string, unknown>[], form: Record<string, string> = {}, target: Record<string, unknown> = { type: 'dynamic_audience', config: {} }) {
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, target, steps } as never }], loadedAt: 1 };
    s.dialogForm = form;
    return s;
  }
  const LABELS = [{ id: 'l-1', name: 'VIP', color: '#2563eb', state: 'active' as const, version: 1 }, { id: 'l-old', name: 'Old', color: '#000000', state: 'retired' as const, version: 1 }];

  it('edits a wait in a whole unit, as stored or as typed', () => {
    const s = builder([{ id: 's1', type: 'delay', config: { seconds: 172_800 } }]);
    let root = renderAutomations(s);
    expect((root.querySelector('[data-form="automationDelay_s1"]') as HTMLInputElement).value).toBe('2');
    expect((root.querySelector('[data-form="automationDelayUnit_s1"]') as HTMLSelectElement).value).toBe('days');
    expect(root.querySelector('[data-step="s1"] h3')?.textContent).toBe('Wait');
    s.dialogForm = { automationDelay_s1: '30', automationDelayUnit_s1: 'minutes' };
    root = renderAutomations(s);
    expect((root.querySelector('[data-form="automationDelay_s1"]') as HTMLInputElement).value).toBe('30');
    expect((root.querySelector('[data-form="automationDelayUnit_s1"]') as HTMLSelectElement).value).toBe('minutes');
    s.lang = 'ar';
    expect([...renderAutomations(s).querySelectorAll('[data-form="automationDelayUnit_s1"] option')].map((option) => option.textContent)).toEqual(['دقائق', 'ساعات', 'أيام']);
  });

  it('picks a label for a label step, and says when there is none to pick', () => {
    const s = builder([{ id: 's1', type: 'add_label', config: { labelId: 'l-1' } }, { id: 's2', type: 'remove_label', config: {} }]);
    expect(renderAutomations(s).textContent).toContain('Loading labels…');
    s.live.labels = { status: 'ready', value: [LABELS[1]!], loadedAt: 1 };
    expect(renderAutomations(s).textContent).toContain('No labels yet');
    s.live.labels = { status: 'ready', value: LABELS, loadedAt: 1 };
    const root = renderAutomations(s);
    expect((root.querySelector('[data-form="automationLabel_s1"]') as HTMLSelectElement).value).toBe('l-1');
    expect((root.querySelector('[data-form="automationLabel_s2"]') as HTMLSelectElement).value).toBe('');
    expect([...root.querySelectorAll('[data-form="automationLabel_s1"] option')].map((option) => option.textContent)).toEqual(['Choose a label', 'VIP']);
  });

  it('picks a contact field and its value for a field step', () => {
    const s = builder([{ id: 's1', type: 'update_customer_field', config: { fieldId: 'f-1', value: 3 } }, { id: 's2', type: 'update_customer_field', config: {} }]);
    s.live.customFields = { status: 'ready', value: [
      { id: 'f-1', target: 'contact', key: 'seats', name: 'Seats', type: 'number', options: [], state: 'active', version: 1 },
      { id: 'f-2', target: 'conversation', key: 'topic', name: 'Topic', type: 'text', options: [], state: 'active', version: 1 },
    ], loadedAt: 1 };
    let root = renderAutomations(s);
    expect((root.querySelector('[data-form="automationField_s1"]') as HTMLSelectElement).value).toBe('f-1');
    expect((root.querySelector('[data-form="automationFieldValue_s1"]') as HTMLInputElement).value).toBe('3');
    expect((root.querySelector('[data-form="automationFieldValue_s2"]') as HTMLInputElement).value).toBe('');
    expect([...root.querySelectorAll('[data-form="automationField_s1"] option')].map((option) => option.textContent)).toEqual(['Choose a field', 'Seats']);
    s.dialogForm = { automationField_s2: 'f-1', automationFieldValue_s2: '7' };
    root = renderAutomations(s);
    expect((root.querySelector('[data-form="automationFieldValue_s2"]') as HTMLInputElement).value).toBe('7');
  });

  it('follows a kind changed in the form, and flags a kind the executor cannot run', () => {
    const s = builder([{ id: 's1', type: 'webhook', config: {} }, { id: 's2', type: 'add_label', config: { labelId: 'l-1' } }], { automationStep_s2: 'delay' });
    const root = renderAutomations(s);
    const blocked = root.querySelector('[data-step="s1"]') as HTMLElement;
    expect(blocked.className).toContain('workflow-block--blocked');
    expect(blocked.textContent).toContain('activation will refuse it');
    expect([...blocked.querySelectorAll('select option')].map((option) => option.textContent)).toContain('Webhook (not available yet)');
    const changed = root.querySelector('[data-step="s2"]') as HTMLElement;
    expect(changed.querySelector('h3')?.textContent).toBe('Wait');
    // A kind just chosen starts from nothing: the label it had is not a delay.
    expect((changed.querySelector('[data-form="automationDelay_s2"]') as HTMLInputElement).value).toBe('1');
    s.lang = 'ar';
    expect(renderAutomations(s).querySelector('[data-step="s1"]')?.textContent).toContain('غير متاحة بعد');
  });

  it('names the label of a label audience', () => {
    const s = builder([{ id: 's1', type: 'delay', config: { seconds: 60 } }], {}, { type: 'label', config: { labelId: 'l-1' } });
    s.live.labels = { status: 'ready', value: LABELS, loadedAt: 1 };
    expect((renderAutomations(s).querySelector('[data-form="automationTargetLabel"]') as HTMLSelectElement).value).toBe('l-1');
    s.dialogForm = { automationTarget: 'label', automationTargetLabel: '' };
    expect((renderAutomations(s).querySelector('[data-form="automationTargetLabel"]') as HTMLSelectElement).value).toBe('');
    s.dialogForm = { automationTarget: 'single_customer' };
    expect(renderAutomations(s).querySelector('[data-form="automationTargetLabel"]')).toBeNull();
    const other = builder([{ id: 's1', type: 'delay', config: { seconds: 60 } }], { automationTarget: 'label' });
    other.live.labels = { status: 'ready', value: LABELS, loadedAt: 1 };
    expect((renderAutomations(other).querySelector('[data-form="automationTargetLabel"]') as HTMLSelectElement).value).toBe('');
  });
});

describe('the schedule block follows the chosen recurrence', () => {
  function builderFor(schedule: Record<string, unknown> | undefined, kind = 'schedule') {
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = {
      status: 'ready',
      value: [{
        ...AUTOMATION,
        workflow: {
          ...WORKFLOW,
          trigger: { type: kind, config: {} },
          ...(schedule === undefined ? {} : { schedule }),
        },
      }],
      loadedAt: 1,
    };
    return renderAutomations(s);
  }

  it('offers an instant for a one-time schedule and nothing else', () => {
    const root = builderFor({ kind: 'one_time', at: '2026-10-01T09:00:00Z' });
    expect(root.querySelector('[data-form="automationScheduleAt"]')).not.toBeNull();
    expect(root.querySelector('[data-form="automationScheduleTime"]')).toBeNull();
  });

  it('offers a time for a daily schedule', () => {
    const root = builderFor({ kind: 'daily', time: '07:30' });
    expect(root.querySelector('[data-form="automationScheduleTime"]')).not.toBeNull();
    expect(root.querySelector('[data-form="automationScheduleDays"]')).toBeNull();
  });

  it('offers weekdays for a weekly schedule', () => {
    const root = builderFor({ kind: 'weekly', time: '09:00', daysOfWeek: [1, 4] });
    expect(root.querySelector('[data-form="automationScheduleDays"]')).not.toBeNull();
    expect(root.querySelector('[data-form="automationScheduleTime"]')).not.toBeNull();
  });

  it('offers a day of month for a monthly schedule', () => {
    const root = builderFor({ kind: 'monthly', time: '09:00', dayOfMonth: 15 });
    expect(root.querySelector('[data-form="automationScheduleDay"]')).not.toBeNull();
  });

  it('offers an interval for a custom recurrence', () => {
    const root = builderFor({ kind: 'custom_recurrence', everyMinutes: 30 });
    expect(root.querySelector('[data-form="automationScheduleEvery"]')).not.toBeNull();
  });

  it('falls back to sensible defaults when the schedule carries no values', () => {
    for (const kind of ['one_time', 'daily', 'weekly', 'monthly', 'custom_recurrence']) {
      expect(builderFor({ kind }).textContent).toContain('Schedule');
    }
  });

  it('shows no schedule block at all when the trigger is not a schedule', () => {
    const root = builderFor(undefined, 'manual');
    expect(root.querySelector('[data-form="automationScheduleKind"]')).toBeNull();
  });
});

describe('the screen in Arabic', () => {
  it('renders every view without falling back to English', () => {
    for (const view of ['templates', 'mine', 'runs']) {
      const s = state(view);
      s.lang = 'ar';
      const root = renderAutomations(s);
      expect(root.textContent).not.toBe('');
    }
    const s = state('mine');
    s.lang = 'ar';
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    expect(renderAutomations(s).textContent).toContain('الجدول');
  });
});

describe('run evidence at its edges', () => {
  it('renders a production run, a failure, and one that never started', () => {
    const s = state('runs');
    s.live.automationRuns = {
      status: 'ready',
      value: [
        { ...RUN, id: 'r-2', mode: 'production', status: 'failed', failed_count: 2, error: { code: 'x' } },
        { ...RUN, id: 'r-3', status: 'queued', started_at: null, completed_at: null },
        { ...RUN, id: 'r-4', status: 'partially_completed' },
      ],
      loadedAt: 1,
    };
    const root = renderAutomations(s);
    expect(root.textContent).not.toContain('undefined');
    expect(root.textContent).not.toContain('NaN');
  });

  it('survives an automation whose state has no tone of its own', () => {
    const s = state('mine');
    s.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, state: 'unheard_of' as Automation['state'] }],
      loadedAt: 1,
    };
    expect(renderAutomations(s).textContent).toContain('Reminder');
  });

  it('renders an unknown view as the default rather than as nothing', () => {
    expect(renderAutomations(state('nonsense')).textContent).not.toBe('');
  });
});

describe('the template picker, with and without a catalogue', () => {
  function builder(overrides: { templates?: unknown[]; step?: Record<string, unknown>; extra?: Record<string, string>; form?: Record<string, string> } = {}) {
    const s = state('mine');
    s.dialogForm = overrides.form ?? {};
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1', ...overrides.extra } };
    s.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'step_1', type: 'send_whatsapp_template', config: overrides.step ?? {} }] } }],
      loadedAt: 1,
    };
    s.live.whatsappTemplates = overrides.templates === undefined
      ? { status: 'ready', value: [], loadedAt: 1 }
      : { status: 'ready', value: overrides.templates as never, loadedAt: 1 };
    return renderAutomations(s);
  }

  const WA = { id: 'wa-1', connectionId: 'c', providerTemplateId: 'p', templateName: 'class_reminder', language: 'en', category: 'UTILITY', status: 'approved', components: [], variables: ['1'], lastSyncedAt: NOW.toISOString() };

  it('renders a configuration-required notice when no template has been synced', () => {
    // The honest state: the catalogue is empty because nothing has connected a
    // WhatsApp number yet, and the screen says so rather than showing nothing.
    expect(builder().textContent).toContain('Connect WhatsApp');
  });

  it('marks the template the step already names, and shows it in the preview', () => {
    const root = builder({ templates: [WA, { ...WA, id: 'wa-2', templateName: 'other' }], step: { templateId: 'wa-2' } });
    expect(root.querySelector('.tpl-card.is-selected')?.textContent).toContain('other');
    expect(root.querySelector('[data-act="form-toggle"][data-arg="automationTemplate_step_1:wa-1"]')).not.toBeNull();
  });

  it('asks for a choice when the step names a template that is gone', () => {
    const root = builder({ templates: [WA], step: { templateId: 'wa-missing' } });
    expect(root.querySelector('.tpl-card.is-selected')).toBeNull();
    expect(root.textContent).toContain('Choose a template to see it');
  });

  it('binds every variable the template declares, from what the step stored', () => {
    const template = { ...WA, components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} and {{3}}' }] };
    const root = builder({ templates: [template], step: { templateId: 'wa-1', variableMapping: { 'body:2': { source: 'phone' } } } });
    expect(root.querySelectorAll('.tpl-var')).toHaveLength(3);
    expect((root.querySelector('[data-form="automationParam_step_1_body_2_source"]') as HTMLSelectElement).value).toBe('phone');
    expect(root.querySelector('.wa-bubble__body')?.textContent).toBe('Hi Mona, +20 100 000 0000 and {{3}}');
  });

  it('starts another template from nothing, whatever the step stored for the first', () => {
    const template = { ...WA, components: [{ type: 'BODY', text: 'Hi {{1}}' }] };
    const root = builder({ templates: [template, { ...template, id: 'wa-2' }], step: { templateId: 'wa-1', variableMapping: { 'body:1': { source: 'phone' } } }, form: { automationTemplate_step_1: 'wa-2' } });
    expect((root.querySelector('[data-form="automationParam_step_1_body_1_source"]') as HTMLSelectElement).value).toBe('display_name');
  });

  it('says a template without variables goes to everyone as is', () => {
    const root = builder({ templates: [{ ...WA, components: [{ type: 'BODY', text: 'Hello' }] }], step: { templateId: 'wa-1' } });
    expect(root.querySelector('.tpl-var')).toBeNull();
    expect(root.textContent).toContain('This template has no variables');
  });
});

describe('who an automation reaches', () => {
  function target(config: Record<string, unknown>, form: Record<string, string> = {}): AppState {
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = { status: 'ready', value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, target: { type: 'dynamic_audience', config } } as never }], loadedAt: 1 };
    s.dialogForm = form;
    return s;
  }

  it('names each target plainly, and marks the ones that cannot run yet', () => {
    const options = [...renderAutomations(target({})).querySelectorAll('[data-form="automationTarget"] option')].map((option) => option.textContent);
    expect(options).toEqual(['The contact who triggered it', 'A saved audience', 'Contacts with a label', 'A saved view (coming soon)', 'Course context (coming soon)', 'Contacts matching conditions (coming soon)']);
    const arabic = target({});
    arabic.lang = 'ar';
    expect(renderAutomations(arabic).querySelector('[data-form="automationTarget"] option:last-child')?.textContent).toBe('من يطابق شروطًا (قريبًا)');
  });

  it('picks a saved audience, as stored or as chosen, and says when there is none', () => {
    const s = target({ audienceId: 'aud-2' });
    expect(renderAutomations(s).textContent).toContain('Loading audiences…');
    s.live.audiences = { status: 'ready', loadedAt: 1, value: [] };
    expect(renderAutomations(s).textContent).toContain('No saved audiences.');
    s.live.audiences = { status: 'ready', loadedAt: 1, value: [
      { id: 'aud-1', name: 'VIPs', description: null, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [] } }, state: 'active', version: 1 },
      { id: 'aud-2', name: 'Leads', description: null, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [] } }, state: 'active', version: 1 },
    ] };
    expect((renderAutomations(s).querySelector('[data-form="automationTargetAudience"]') as HTMLSelectElement).value).toBe('aud-2');
    s.dialogForm = { automationTargetAudience: 'aud-1' };
    expect((renderAutomations(s).querySelector('[data-form="automationTargetAudience"]') as HTMLSelectElement).value).toBe('aud-1');
    // Switching away from a saved audience drops the picker.
    s.dialogForm = { automationTarget: 'label' };
    expect(renderAutomations(s).querySelector('[data-form="automationTargetAudience"]')).toBeNull();
  });
});

describe('states the screen must not render as a blank panel', () => {
  it('shows a loading skeleton for the runs view and for the builder', () => {
    const runs = state('runs');
    runs.live.automationRuns = { status: 'loading' };
    expect(renderAutomations(runs).querySelector('[aria-busy="true"]')).not.toBeNull();

    const mine = state('mine');
    mine.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    mine.live.whatsappTemplates = { status: 'loading' };
    expect(renderAutomations(mine).textContent).not.toBe('');
  });

  it('shows a retryable error state for each resource', () => {
    const error = { code: 'x', message: 'x', requestId: 'req-id', status: 500, details: [] };
    const mine = state('mine');
    mine.live.automations = { status: 'error', error };
    const root = renderAutomations(mine);
    expect(root.textContent).toContain('req-id');
    expect(root.querySelector('[data-act="live-automations-reload"]')).not.toBeNull();
  });

  it('defaults to the template catalogue when the route names no view', () => {
    const s = state();
    s.route = { screen: 'automations', conversationId: null, params: {} };
    expect(renderAutomations(s).textContent).toContain('Start with a proven flow');
  });

  it('hides the remove-step control when only one step remains', () => {
    // Removing the last step would leave a workflow that cannot validate.
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, steps: [{ id: 'only', type: 'delay', config: {} }] } }],
      loadedAt: 1,
    };
    expect(renderAutomations(s).querySelector('[data-act="live-automation-remove-step"]')).toBeNull();
  });

  it('shows a non-schedule trigger with a macro glyph rather than a calendar', () => {
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, workflow: { ...WORKFLOW, trigger: { type: 'manual', config: {} } } }],
      loadedAt: 1,
    };
    expect(renderAutomations(s).textContent).toContain('Reminder');
  });
});

describe('glyphs and tones chosen per row', () => {
  it('shows a macro glyph for a template whose trigger is not a schedule', () => {
    const s = state();
    s.live.automationTemplates = {
      status: 'ready',
      value: [
        { ...TEMPLATE, key: 'evented', preset: { ...WORKFLOW, trigger: { type: 'customer_created', config: {} } } },
        TEMPLATE,
      ],
      loadedAt: 1,
    };
    const root = renderAutomations(s);
    expect(root.querySelectorAll('.automation-template-card').length).toBe(2);
  });

  it('falls back to a neutral tone for a state it has no colour for', () => {
    const s = state('mine');
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = {
      status: 'ready',
      value: [{ ...AUTOMATION, state: 'quarantined' as Automation['state'] }],
      loadedAt: 1,
    };
    expect(renderAutomations(s).textContent).toContain('Quarantined');
  });
});

describe('the builder’s header', () => {
  function header(state: 'draft' | 'paused', permissions: readonly string[]): HTMLElement {
    const s = createState(new Date('2026-09-17T00:00:00Z'));
    s.lang = 'en';
    s.live.session = { status: 'signed_in', email: 'a@b.c', tenantId: 't', memberships: [{ id: 'm', tenant: { id: 't', name: 'S', slug: 's' }, role: { id: 'r', key: 'x', name: 'X' }, permissions }] };
    s.route = { screen: 'automations', conversationId: null, params: { view: 'mine', edit: 'a-1' } };
    s.live.automations = { status: 'ready', value: [{ ...AUTOMATION, state }], loadedAt: 1 };
    return renderAutomations(s).querySelector('.automation-builder__header') as HTMLElement;
  }

  it('offers saving as a draft or turning it on, as the operator may', () => {
    const draft = header('draft', ['automation.read', 'automation.edit', 'automation.activate']);
    expect(draft.querySelector('[data-act="live-automation-save"]')?.textContent).toBe('Save as draft');
    expect(draft.querySelector('[data-act="live-automation-save-activate"]')?.textContent).toBe('Save and turn on');
    expect(draft.textContent).toContain('Not turned on yet');
    const paused = header('paused', ['automation.read', 'automation.edit', 'automation.activate']);
    expect(paused.querySelector('[data-act="live-automation-save-activate"]')?.textContent).toBe('Save and resume');
    expect(paused.textContent).toContain('Paused automation');
    expect(header('draft', ['automation.read', 'automation.edit']).querySelector('[data-act="live-automation-save-activate"]')).toBeNull();
  });
});
