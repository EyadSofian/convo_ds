import type { Automation, AutomationInput, AutomationListQuery, AutomationRun, AutomationRunsQuery, AutomationStep } from '../api/automations.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { forTenant, fromResult, LOADING, refetching, rowsOf } from './store.js';
import { loadAudiences } from './audience-actions.js';
import { automationPrefix, stepConfigFrom } from './automation-steps.js';
import { loadMetadataCatalog } from './metadata-catalog.js';
import { bindingsFromForm, storedBindings, templateDefinition } from './template-binding.js';

function copy(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function loadAutomationsScreen(context: LiveContext): Promise<void> {
  const view = context.state.route.params['view'] ?? 'templates';
  if (context.state.route.params['edit'] !== undefined || view === 'mine') {
    await loadAutomationPage(context, true);
    if (context.state.route.params['edit'] !== undefined) {
      // The step editors pick labels and fields from the company's catalogue.
      // A saved-audience target picks from the saved audiences.
      await Promise.all([loadWhatsAppTemplates(context), context.live.labels.status === 'idle' ? loadMetadataCatalog(context) : null, loadAudiences(context)]);
    }
    return;
  }
  if (view === 'runs') {
    await loadAutomationRunsPage(context, true);
    return;
  }
  await loadAutomationTemplates(context);
}

async function loadAutomationTemplates(context: LiveContext): Promise<void> {
  context.live.automationTemplates = refetching(context.live, context.live.automationTemplates);
  context.refresh();
  await forTenant(context, undefined, async (tenantId) => {
    const result = await context.live.automationsApi.templates(tenantId);
    context.live.automationTemplates = fromResult(result, context.now());
    context.live.error = result.ok ? null : result.error;
    context.refresh();
  });
}

async function loadWhatsAppTemplates(context: LiveContext): Promise<void> {
  context.live.whatsappTemplates = LOADING;
  context.refresh();
  await forTenant(context, undefined, async (tenantId) => {
    const result = await context.live.automationsApi.whatsappTemplates(tenantId);
    context.live.whatsappTemplates = fromResult(result, context.now());
    context.live.error = result.ok ? null : result.error;
    context.refresh();
  });
}

export async function loadAutomationPage(context: LiveContext, reset: boolean): Promise<void> {
  const { live } = context;
  const cursor = reset ? null : live.automationNextCursor;
  if (!reset && cursor === null) return;
  live.automations = reset ? refetching(live, live.automations) : live.automations;
  context.refresh();
  await forTenant(context, undefined, async (tenantId) => {
    const result = await live.automationsApi.list(tenantId, { ...live.automationQuery, cursor });
    if (!result.ok) {
      if (reset) live.automations = fromResult(result, context.now());
      live.error = result.error;
      context.refresh();
      return;
    }
    const previous = reset ? [] : rowsOf(live.automations);
    live.automations = fromResult({ ok: true, data: uniqueAutomations([...previous, ...result.data.data]) }, context.now());
    live.automationNextCursor = result.data.nextCursor;
    live.error = null;
    context.refresh();
  });
}

export async function loadAutomationRunsPage(context: LiveContext, reset: boolean): Promise<void> {
  const { live } = context;
  const cursor = reset ? null : live.automationRunsNextCursor;
  if (!reset && cursor === null) return;
  live.automationRuns = reset ? refetching(live, live.automationRuns) : live.automationRuns;
  context.refresh();
  await forTenant(context, undefined, async (tenantId) => {
    const result = await live.automationsApi.runs(tenantId, { ...live.automationRunsQuery, cursor });
    if (!result.ok) {
      if (reset) live.automationRuns = fromResult(result, context.now());
      live.error = result.error;
      context.refresh();
      return;
    }
    const previous = reset ? [] : rowsOf(live.automationRuns);
    live.automationRuns = fromResult({ ok: true, data: uniqueRuns([...previous, ...result.data.data]) }, context.now());
    live.automationRunsNextCursor = result.data.nextCursor;
    live.error = null;
    context.refresh();
  });
}

export async function setAutomationQuery(context: LiveContext, query: Omit<AutomationListQuery, 'cursor'>): Promise<void> {
  context.live.automationQuery = query;
  context.live.automationNextCursor = null;
  await loadAutomationPage(context, true);
}

export async function setAutomationRunsQuery(context: LiveContext, query: Omit<AutomationRunsQuery, 'cursor'>): Promise<void> {
  context.live.automationRunsQuery = query;
  context.live.automationRunsNextCursor = null;
  await loadAutomationRunsPage(context, true);
}

export async function useAutomationTemplate(context: LiveContext, key: string): Promise<boolean> {
  const source = rowsOf(context.live.automationTemplates).find((entry) => entry.key === key);
  if (source === undefined) return false;
  context.live.busy = `automation-use:${key}`;
  context.live.error = null;
  context.refresh();
  return forTenant(context, false, async (tenantId) => {
    const suffix = context.newKey().slice(-6).toUpperCase();
    const result = await context.live.automationsApi.useTemplate(tenantId, key, `${source.name} · ${suffix}`);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return false;
    }
    insertAutomation(context, result.data);
    context.state.route = {
      screen: 'automations',
      conversationId: null,
      params: { view: 'mine', edit: result.data.id },
    };
    context.state.focusTarget = '[data-automation-builder] input[name="automationName"]';
    pushToast(context.state, copy(context, 'أُنشئت المسودة. جارٍ فتح المحرر.', 'Draft created. Opening editor.'));
    context.refresh();
    return true;
  });
}

export async function createBlankAutomation(context: LiveContext, name: string): Promise<boolean> {
  const input: AutomationInput = {
    name,
    description: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workflow: {
      version: 1,
      trigger: { type: 'manual', config: {} },
      target: { type: 'matching_conditions', config: {} },
      // A step the executor can run, left for the operator to point at a label.
      steps: [{ id: 'step_1', type: 'add_label', config: {} }],
      safety: { approvalRequired: true, duplicateWindowSeconds: 86400 },
    },
  };
  return mutate(context, 'automation-create', (tenantId) => context.live.automationsApi.create(tenantId, input), copy(context, 'تم إنشاء الأتمتة كمسودة.', 'Automation created as a draft.'));
}

export async function saveAutomation(context: LiveContext, automationId: string): Promise<boolean> {
  const automation = rowsOf(context.live.automations).find((entry) => entry.id === automationId);
  if (automation === undefined) return false;
  const form = context.state.dialogForm;
  const steps = stepsFromForm(context, automation);
  const triggerType = form['automationTrigger'] || automation.workflow.trigger.type;
  const targetType = (form['automationTarget'] || automation.workflow.target.type) as Automation['workflow']['target']['type'];
  const ownTarget = targetType === automation.workflow.target.type ? automation.workflow.target.config : {};
  const targetLabel = form['automationTargetLabel'] ?? (typeof ownTarget['labelId'] === 'string' ? ownTarget['labelId'] : '');
  const targetAudience = form['automationTargetAudience'] ?? (typeof ownTarget['audienceId'] === 'string' ? ownTarget['audienceId'] : '');
  const schedule = triggerType === 'schedule'
    ? scheduleOf(form, automation.workflow.schedule, context.now())
    : automation.workflow.schedule;
  const input: AutomationInput = {
    name: form['automationName']?.trim() || automation.name,
    description: form['automationDescription']?.trim() || automation.description,
    timezone: form['automationTimezone'] || automation.timezone,
    workflow: {
      ...automation.workflow,
      trigger: { ...automation.workflow.trigger, type: triggerType },
      target: {
        type: targetType,
        config: targetType === 'label' ? (targetLabel === '' ? {} : { labelId: targetLabel })
          : targetType === 'dynamic_audience' ? (targetAudience === '' ? {} : { audienceId: targetAudience })
            : ownTarget,
      },
      steps,
      ...(schedule === undefined ? {} : { schedule }),
    },
  };
  return mutate(context, `automation-save:${automationId}`, (tenantId) => context.live.automationsApi.update(tenantId, automationId, automation.version, input), copy(context, 'حُفظت المسودة.', 'Draft saved.'));
}

/**
 * The steps as the builder shows them: each with the kind and config typed so
 * far. Saving, adding and removing a step all start from this, so a step being
 * configured is never lost to a neighbour being added.
 */
export function stepsFromForm(context: LiveContext, automation: Automation): AutomationStep[] {
  const form = context.state.dialogForm;
  const fields = rowsOf(context.live.customFields);
  return automation.workflow.steps.map((step) => {
    const type=(form[`automationStep_${step.id}`]||step.type) as AutomationStep['type'];
    if(type!=='send_whatsapp_template')return{...step,type,config:stepConfigFrom(form,step,type,fields)};
    // The same bindings a broadcast uses: each variable of the chosen template
    // names where its value comes from for each recipient.
    const savedId=typeof step.config['templateId']==='string'?step.config['templateId']:'';
    const templateId=form[`automationTemplate_${step.id}`]||savedId;
    const template=rowsOf(context.live.whatsappTemplates).find((entry)=>entry.id===templateId);
    const stored=templateId===savedId?storedBindings(step.config['variableMapping']):{};
    const variableMapping=template===undefined?stored:bindingsFromForm(form,automationPrefix(step.id),templateDefinition(template),stored).bindings;
    return{...step,type,config:templateId===''?{}:{templateId,variableMapping}};
  });
}

export function scheduleOf(form:Readonly<Record<string,string>>,previous:Readonly<Record<string,unknown>>|undefined,now:number):Readonly<Record<string,unknown>>{
  const kind=form['automationScheduleKind']||String(previous?.['kind']??'daily');
  const time=form['automationScheduleTime']||String(previous?.['time']??'09:00');
  if(kind==='one_time')return{kind,at:form['automationScheduleAt']||String(previous?.['at']??new Date(now+86400000).toISOString())};
  if(kind==='weekly')return{kind,time,daysOfWeek:(form['automationScheduleDays']||'1').split(',').map((value)=>Number(value.trim())).filter((value)=>Number.isInteger(value)&&value>=0&&value<=6)};
  if(kind==='monthly')return{kind,time,dayOfMonth:Number(form['automationScheduleDay']||previous?.['dayOfMonth']||1)};
  if(kind==='custom_recurrence')return{kind,everyMinutes:Number(form['automationScheduleEvery']||previous?.['everyMinutes']||60)};
  if(kind==='relative')return{kind,offsetMinutes:Number(form['automationScheduleOffset']||previous?.['offsetMinutes']||-60)};
  return{kind:'daily',time};
}

export async function addAutomationStep(context: LiveContext, automationId: string): Promise<boolean> {
  const automation = rowsOf(context.live.automations).find((entry) => entry.id === automationId);
  if (automation === undefined || automation.workflow.steps.length >= 50) return false;
  const step: AutomationStep = { id: `step_${String(automation.workflow.steps.length + 1)}_${context.newKey().slice(-4)}`, type: 'add_label', config: {} };
  return updateWorkflow(context, automation, [...stepsFromForm(context, automation), step], copy(context, 'أُضيفت خطوة جديدة.', 'Step added.'));
}

export async function removeAutomationStep(context: LiveContext, argument: string): Promise<boolean> {
  const [automationId = '', stepId = ''] = argument.split(':');
  const automation = rowsOf(context.live.automations).find((entry) => entry.id === automationId);
  if (automation === undefined || automation.workflow.steps.length <= 1) return false;
  return updateWorkflow(context, automation, stepsFromForm(context, automation).filter((step) => step.id !== stepId), copy(context, 'حُذفت الخطوة.', 'Step removed.'));
}

export async function transitionAutomation(context: LiveContext, argument: string): Promise<boolean> {
  const [id = '', action = ''] = argument.split(':');
  const automation = rowsOf(context.live.automations).find((entry) => entry.id === id);
  if (automation === undefined || !isAction(action)) return false;
  return mutate(context, `automation-${action}:${id}`, (tenantId) => context.live.automationsApi.transition(tenantId, automation, action), copy(context, 'تم تحديث حالة الأتمتة.', 'Automation state updated.'));
}

/**
 * A draft has no side effects, but deletion is still server-authorized and
 * version-fenced. Refreshing just the definition list keeps run evidence on
 * screen and avoids pretending a local removal was committed.
 */
export async function deleteAutomationDraft(context: LiveContext, automationId: string): Promise<boolean> {
  const automation = rowsOf(context.live.automations).find((entry) => entry.id === automationId);
  if (automation === undefined || automation.state !== 'draft') return false;
  context.live.busy = `automation-delete:${automationId}`;
  context.live.error = null;
  context.refresh();
  return forTenant(context, false, async (tenantId) => {
    const result = await context.live.automationsApi.deleteDraft(tenantId, automation);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return false;
    }
    context.live.automations = fromResult({ ok: true, data: rowsOf(context.live.automations).filter((entry) => entry.id !== automation.id) }, context.now());
    if (context.state.route.params['edit'] === automationId) {
      context.state.route = { screen: 'automations', conversationId: null, params: { view: 'mine' } };
    }
    pushToast(context.state, copy(context, 'تم حذف المسودة.', 'Draft deleted.'));
    context.refresh();
    return true;
  });
}

async function updateWorkflow(context: LiveContext, automation: Automation, steps: readonly AutomationStep[], message: string): Promise<boolean> {
  const input: AutomationInput = { name: automation.name, description: automation.description, timezone: automation.timezone, workflow: { ...automation.workflow, steps } };
  return mutate(context, `automation-steps:${automation.id}`, (tenantId) => context.live.automationsApi.update(tenantId, automation.id, automation.version, input), message);
}

function isAction(value: string): value is 'activate' | 'pause' | 'resume' | 'archive' {
  return value === 'activate' || value === 'pause' || value === 'resume' || value === 'archive';
}

async function mutate(context: LiveContext, busy: string, request: (tenantId: string) => ReturnType<LiveContext['live']['automationsApi']['create']>, success: string): Promise<boolean> {
  context.live.busy = busy;
  context.live.error = null;
  context.refresh();
  return forTenant(context, false, async (tenantId) => {
    const result = await request(tenantId);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return false;
    }
    insertAutomation(context, result.data);
    pushToast(context.state, success);
    context.refresh();
    return true;
  });
}

/** Reconcile one committed definition without fetching unrelated tabs. */
function insertAutomation(context: LiveContext, automation: Automation): void {
  const query = context.live.automationQuery;
  const existing = rowsOf(context.live.automations).filter((entry) => entry.id !== automation.id);
  const included = matchesAutomationQuery(automation, query);
  context.live.automations = fromResult({ ok: true, data: included ? uniqueAutomations([automation, ...existing]) : existing }, context.now());
}

function matchesAutomationQuery(automation: Automation, query: Omit<AutomationListQuery, 'cursor'>): boolean {
  if (query.state !== '' && automation.state !== query.state) return false;
  if (query.search !== '' && !automation.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) return false;
  return true;
}

function uniqueAutomations(items: readonly Automation[]): readonly Automation[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function uniqueRuns(items: readonly AutomationRun[]): readonly AutomationRun[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
