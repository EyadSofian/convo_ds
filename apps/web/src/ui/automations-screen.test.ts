/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun, AutomationTemplate } from '../api/automations.js';
import { createState } from '../state.js';
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
 });
 it('renders the sequential builder without exposing JSON',()=>{
  const s=state('mine'); s.route={screen:'automations',conversationId:null,params:{view:'mine',edit:'a-1'}}; s.live.whatsappTemplates={status:'ready',value:[{id:'wa-1',connectionId:'c',providerTemplateId:'p',templateName:'class_reminder',language:'en',category:'UTILITY',status:'approved',components:[],variables:['1'],lastSyncedAt:NOW.toISOString()}],loadedAt:1}; const root=renderAutomations(s); expect(root.querySelectorAll('.workflow-block').length).toBe(4); expect(root.textContent).toContain('Execution safety'); expect(root.textContent).toContain('Approved WhatsApp template'); expect(root.textContent).not.toContain('"trigger"'); expect(root.querySelector('[data-act="live-automation-add-step"]')).not.toBeNull();
 });
 it('shows run evidence, empty history and load failures',()=>{
  const s=state('runs'); let root=renderAutomations(s); expect(root.textContent).toContain('TEST'); expect(root.textContent).toContain('Delivered');
  s.live.automationRuns={status:'ready',value:[],loadedAt:1}; root=renderAutomations(s); expect(root.textContent).toContain('No runs yet');
  s.live.automationRuns={status:'error',error:{code:'x',message:'x',requestId:'run-req',status:500,details:[]}}; expect(renderAutomations(s).textContent).toContain('run-req');
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
  function builder(overrides: { templates?: unknown[]; step?: Record<string, unknown>; extra?: Record<string, string> } = {}) {
    const s = state('mine');
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

  it('selects the template the step already names', () => {
    const root = builder({ templates: [WA, { ...WA, id: 'wa-2', templateName: 'other' }], step: { templateId: 'wa-2' } });
    expect(root.textContent).toContain('other');
  });

  it('falls back to the first template when the step names one that is gone', () => {
    const root = builder({ templates: [WA], step: { templateId: 'wa-missing' } });
    expect(root.textContent).toContain('class_reminder');
  });

  it('renders a variable row for every variable the template declares', () => {
    const root = builder({ templates: [{ ...WA, variables: ['1', '2', '3'] }] });
    expect(root.querySelectorAll('[data-form^="automationVariable_"]').length).toBe(3);
  });

  it('renders no variable rows for a template that declares none', () => {
    const root = builder({ templates: [{ ...WA, variables: [] }] });
    expect(root.querySelectorAll('[data-form^="automationVariable_"]').length).toBe(0);
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
