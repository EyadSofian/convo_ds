import type { Automation, AutomationRun, AutomationTemplate } from '../api/automations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber } from '../format.js';
import { icon } from '../icons.js';
import { hasPermission } from '../live/ability.js';
import type { DelayUnit } from '../live/automation-steps.js';
import { DELAY_UNITS, delayParts, RUNNABLE_STEPS, runnable } from '../live/automation-steps.js';
import { rowsOf } from '../live/store.js';
import { formatHash } from '../router.js';
import { routeParamsWithLanguage } from '../state.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { badge, button, emptyState, errorState, inlineError, page, panel, refreshButton, selectControl, skeleton, toolbar, type Tone } from './parts.js';

const CATEGORIES = ['academic', 'sales', 'marketing', 'operations', 'custom'] as const;
const TRIGGERS = ['manual','schedule','customer_created','customer_updated','label_added','conversation_created','conversation_assigned','conversation_closed','customer_replied','no_reply_for_duration','custom_event','student_enrolled','course_starting','session_starting','attendance_updated','course_completed'] as const;
const TARGETS = ['single_customer','dynamic_audience','label','saved_view','course_context','matching_conditions'] as const;
const STEP_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  delay: ['انتظار', 'Wait'],
  send_whatsapp_template: ['إرسال قالب واتساب', 'Send a WhatsApp template'],
  add_label: ['إضافة تصنيف للعميل', 'Add a label to the contact'],
  remove_label: ['إزالة تصنيف من العميل', 'Remove a label from the contact'],
  update_customer_field: ['تحديث حقل للعميل', 'Update a contact field'],
};
const STATE_TONE: Readonly<Record<string, Tone>> = { draft: 'neutral', active: 'success', paused: 'warning', archived: 'neutral' };

export function renderAutomations(state: AppState): HTMLElement {
  const view = state.route.params['view'] ?? 'templates';
  const editId = state.route.params['edit'];
  const automation = editId === undefined ? undefined : rowsOf(state.live.automations).find((entry) => entry.id === editId);
  const actions: Child[] = [refreshButton(state, 'live-automations-reload', state.live.automations.status === 'loading')];
  return page('automations', toolbar(
    t(state, 'صمّم تدفقات تعمل عند الحدث أو في الموعد، وتابع كل تنفيذ ومستلم.', 'Design event and scheduled workflows, then trace every run and recipient.'),
    actions,
  ), [
    navigation(state, view),
    inlineError(state, state.live.error),
    automation === undefined ? body(state, view) : builder(state, automation),
  ]);
}

function navigation(state: AppState, current: string): HTMLElement {
  const tabs = [
    ['templates', t(state, 'القوالب', 'Templates')],
    ['mine', t(state, 'أتمتتي', 'My Automations')],
    ['runs', t(state, 'التشغيل والسجلات', 'Runs & Logs')],
  ] as const;
  return h('nav', { class: 'automation-tabs', 'aria-label': t(state, 'أقسام الأتمتة', 'Automation sections') }, tabs.map(([value, label]) =>
    h('a', { class: 'automation-tabs__item', href: formatHash({ screen: 'automations', conversationId: null, params: routeParamsWithLanguage(state, { ...state.route.params, view: value, edit: '' }) }), 'aria-current': current === value ? 'page' : undefined }, [label]),
  ));
}

function body(state: AppState, view: string): Child {
  if (view === 'mine') return automationsView(state);
  if (view === 'runs') return runsView(state);
  return templatesView(state);
}

function templatesView(state: AppState): Child {
  const resource = state.live.automationTemplates;
  if (resource.status === 'idle' || resource.status === 'loading') return skeleton(state, 6);
  if (resource.status === 'error') return errorState(state, resource.error, 'live-automations-reload');
  const canCreate = hasPermission(state.live, 'automation.create');
  return h('div', { class: 'automation-catalogue' }, [
    h('section', { class: 'automation-hero' }, [
      h('div', { class: 'automation-hero__mark', 'aria-hidden': 'true' }, [icon('macro', 20)]),
      h('div', { class: 'automation-hero__copy' }, [
        h('p', { class: 'eyebrow' }, [t(state, 'منطق متسلسل وقابل للمراجعة', 'Sequential, reviewable logic')]),
        h('h2', {}, [t(state, 'ابدأ من قالب ثم اجعله مناسبًا لطريقة عملك', 'Start with a proven flow, then make it yours')]),
        h('p', {}, [t(state, 'كل قالب ينشئ مسودة مستقلة. غيّر الحدث والجمهور والخطوات والجدول قبل التفعيل.', 'Every template creates an independent draft. Change its event, audience, steps and schedule before activation.')]),
      ]),
      canCreate ? h('div', { class: 'automation-blank' }, [
        h('label', { for: 'automation-blank-name' }, [t(state, 'أو ابدأ من الصفر', 'Or build from scratch')]),
        h('div', { class: 'automation-blank__row' }, [
          h('input', { id: 'automation-blank-name', class: 'input', 'data-act': 'form', 'data-form': 'automationBlankName', placeholder: t(state, 'اسم الأتمتة', 'Automation name') }),
          button({ label: t(state, 'إنشاء مسودة', 'Create draft'), icon: 'plus', act: 'live-automation-create', variant: 'primary', small: true }),
        ]),
      ]) : null,
    ]),
    ...CATEGORIES.flatMap((category) => {
      const templates = resource.value.filter((entry) => entry.category === category);
      return templates.length === 0 ? [] : [categorySection(state, category, templates, canCreate)];
    }),
  ]);
}

function categorySection(state: AppState, category: string, templates: readonly AutomationTemplate[], canCreate: boolean): HTMLElement {
  const names: Record<string, readonly [string,string]> = { academic:['أكاديمي','Academic'], sales:['المبيعات','Sales'], marketing:['التسويق','Marketing'], operations:['التشغيل','Operations'], custom:['مخصّص','Custom'] };
  /* c8 ignore next -- CATEGORIES is the loop's own source, so every key is known */
  const name = names[category] ?? [category, category];
  return h('section', { class: 'automation-category' }, [
    h('header', { class: 'automation-category__head' }, [h('h2', {}, [t(state, name[0], name[1])]), h('span', {}, [formatNumber(templates.length, state.lang)])]),
    h('div', { class: 'automation-template-grid' }, templates.map((template) => h('article', { class: 'automation-template-card' }, [
      h('div', { class: 'automation-template-card__icon', 'aria-hidden': 'true' }, [icon(template.preset.trigger.type === 'schedule' ? 'calendar' : 'macro', 18)]),
      h('div', { class: 'automation-template-card__content' }, [
        h('h3', {}, [template.name]),
        h('p', {}, [template.description]),
        h('div', { class: 'automation-flow-mini', 'aria-label': t(state, 'ملخص التدفق', 'Flow summary') }, [
          h('span', {}, [human(template.preset.trigger.type)]), icon('chevronEnd', 14), h('span', {}, [formatNumber(template.preset.steps.length, state.lang), ' ', t(state, 'خطوة', 'step(s)')]),
        ]),
      ]),
      canCreate ? button({ label: t(state, 'استخدام القالب', 'Use template'), act: 'live-automation-use', arg: template.key, small: true, busy: state.live.busy === `automation-use:${template.key}` }) : null,
    ]))),
  ]);
}

function automationsView(state: AppState): Child {
  const resource = state.live.automations;
  if (resource.status === 'idle' || resource.status === 'loading') return skeleton(state, 5);
  if (resource.status === 'error') return errorState(state, resource.error, 'live-automations-reload');
  const controls = automationFilters(state);
  if (resource.value.length === 0) return panel(t(state, 'أتمتتي', 'My Automations'), [controls, emptyState({ icon: 'workflow', title: t(state, 'لا توجد أتمتة مطابقة', 'No matching automations'), body: t(state, 'غيّر البحث أو الحالة، أو أنشئ مسودة من القوالب.', 'Change the search or state, or create a draft from Templates.') })]);
  return h('div', { class: 'automation-list' }, [controls, ...resource.value.map((automation) => automationCard(state, automation)), state.live.automationNextCursor === null ? null : h('div', { class: 'automation-list__more' }, [button({ label: t(state, 'تحميل المزيد', 'Load more'), act: 'live-automation-load-more', small: true, busy: state.live.busy === 'automation-load-more' })])]);
}

function automationFilters(state: AppState): HTMLElement {
  const query = state.live.automationQuery;
  return h('form', { class: 'toolbar automation-list__filters', 'data-submit': 'live-automation-filter', novalidate: true }, [
    h('input', { class: 'input', type: 'search', placeholder: t(state, 'ابحث بالاسم', 'Search by name'), value: state.dialogForm['automationSearch'] ?? query.search, 'data-act': 'form', 'data-form': 'automationSearch' }),
    h('select', { class: 'select', 'data-act': 'form', 'data-form': 'automationState' }, [
      h('option', { value: '', selected: (state.dialogForm['automationState'] ?? query.state) === '' }, [t(state, 'كل الحالات النشطة', 'All active states')]),
      ...(['draft', 'active', 'paused', 'archived'] as const).map((value) => h('option', { value, selected: (state.dialogForm['automationState'] ?? query.state) === value }, [human(value)])),
    ]),
    h('select', { class: 'select', 'data-act': 'form', 'data-form': 'automationSort' }, [
      h('option', { value: 'updated_desc', selected: (state.dialogForm['automationSort'] ?? query.sort) === 'updated_desc' }, [t(state, 'آخر تحديث', 'Recently updated')]),
      h('option', { value: 'name_asc', selected: (state.dialogForm['automationSort'] ?? query.sort) === 'name_asc' }, [t(state, 'الاسم أ–ي', 'Name A–Z')]),
      h('option', { value: 'name_desc', selected: (state.dialogForm['automationSort'] ?? query.sort) === 'name_desc' }, [t(state, 'الاسم ي–أ', 'Name Z–A')]),
    ]),
    button({ label: t(state, 'تطبيق', 'Apply'), act: 'live-automation-filter', small: true }),
  ]);
}

function automationCard(state: AppState, automation: Automation): HTMLElement {
  const mayEdit = hasPermission(state.live, 'automation.edit') && (automation.state === 'draft' || automation.state === 'paused');
  const action = automation.state === 'active' ? 'pause' : automation.state === 'paused' ? 'resume' : 'activate';
  return h('article', { class: 'automation-row' }, [
    h('div', { class: 'automation-row__state', 'data-state': automation.state }, [icon(automation.state === 'active' ? 'play' : 'pause', 18)]),
    h('div', { class: 'automation-row__main' }, [
      h('div', { class: 'automation-row__title' }, [h('h2', {}, [automation.name]), badge(human(automation.state), STATE_TONE[automation.state] ?? 'neutral', { dot: true })]),
      h('p', {}, [automation.description ?? t(state, 'تدفق قابل للتعديل', 'Editable workflow')]),
      h('div', { class: 'automation-row__meta' }, [h('span', {}, [human(automation.workflow.trigger.type)]), h('span', {}, [formatNumber(automation.workflow.steps.length, state.lang), ' ', t(state, 'خطوة', 'steps')]), h('span', {}, [automation.timezone])]),
    ]),
    h('div', { class: 'automation-row__actions' }, [
      mayEdit ? h('a', { class: 'btn btn--sm', href: formatHash({ screen: 'automations', conversationId: null, params: routeParamsWithLanguage(state, { view: 'mine', edit: automation.id }) }) }, [icon('edit', 14), h('span', { class: 'btn__label' }, [t(state, 'تحرير', 'Edit')])]) : null,
      automation.state === 'draft' && mayEdit ? button({ label: t(state, 'حذف المسودة', 'Delete draft'), icon: 'close', act: 'dialog', arg: `automation-delete:${automation.id}`, variant: 'ghost', small: true, busy: state.live.busy === `automation-delete:${automation.id}` }) : null,
      automation.state !== 'archived' ? button({ label: human(action), icon: action === 'pause' ? 'pause' : 'play', act: 'live-automation-transition', arg: `${automation.id}:${action}`, small: true, busy: state.live.busy === `automation-${action}:${automation.id}` }) : null,
    ]),
  ]);
}

function builder(state: AppState, automation: Automation): HTMLElement {
  const effectiveTrigger = state.dialogForm['automationTrigger'] || automation.workflow.trigger.type;
  const scheduleKind = state.dialogForm['automationScheduleKind'] || String(automation.workflow.schedule?.['kind'] ?? 'daily');
  return h('section', { class: 'automation-builder', 'data-automation-builder': true }, [
    h('header', { class: 'automation-builder__header' }, [
      h('a', { class: 'automation-builder__back', href: formatHash({ screen: 'automations', conversationId: null, params: routeParamsWithLanguage(state, { view: 'mine' }) }) }, [icon('chevronStart', 16), t(state, 'رجوع إلى أتمتتي', 'Back to automations')]),
      h('div', {}, [h('p', { class: 'eyebrow' }, [t(state, 'مسودة سير عمل', 'Workflow draft')]), h('h2', {}, [automation.name])]),
      button({ label: t(state, 'حفظ المسودة', 'Save draft'), icon: 'check', act: 'live-automation-save', arg: automation.id, variant: 'primary', busy: state.live.busy === `automation-save:${automation.id}` }),
    ]),
    h('div', { class: 'automation-builder__layout' }, [
      h('aside', { class: 'automation-builder__rail', 'aria-label': t(state, 'مراحل الإعداد', 'Builder stages') }, ['WHEN','CONDITIONS','TARGET','ACTIONS','MESSAGE','VARIABLES','SCHEDULE','SAFETY','REVIEW'].map((label,index) => h('div', { class: `automation-stage${index < 4 ? ' automation-stage--ready' : ''}` }, [h('span', {}, [String(index + 1)]), label]))),
      h('div', { class: 'automation-canvas' }, [
        fieldBlock(state, 'WHEN', t(state, 'متى يبدأ هذا التدفق؟', 'What starts this workflow?'), select('automationTrigger', automation.workflow.trigger.type, TRIGGERS)),
        connector(),
        targetBlock(state, automation),
        connector(),
        ...automation.workflow.steps.flatMap((step, index) => {
          const type = state.dialogForm[`automationStep_${step.id}`] || step.type;
          return [
            h('article', { class: `workflow-block${runnable(type) ? '' : ' workflow-block--blocked'}`, 'data-step': step.id }, [
              h('div', { class: 'workflow-block__index' }, [String(index + 1)]),
              h('div', { class: 'workflow-block__body' }, [
                h('span', { class: 'workflow-block__kind' }, [index === 0 ? t(state, 'ثم', 'THEN') : t(state, 'وبعدها', 'AND THEN')]),
                h('h3', {}, [stepName(state, type)]),
                stepSelect(state, step.id, type),
                stepConfig(state, step, type),
              ]),
              automation.workflow.steps.length > 1 ? button({ icon: 'close', act: 'live-automation-remove-step', arg: `${automation.id}:${step.id}`, variant: 'ghost', small: true, title: t(state, 'حذف الخطوة', 'Remove step') }) : null,
            ]),
            connector(),
          ];
        }),
        button({ label: t(state, 'إضافة خطوة', 'Add step'), icon: 'plus', act: 'live-automation-add-step', arg: automation.id, extraClass: 'automation-add-step' }),
        h('section', { class: 'automation-safety-card' }, [icon('shield', 20), h('div', {}, [h('h3', {}, [t(state, 'الحماية قبل التشغيل', 'Execution safety')]), h('p', {}, [t(state, 'منع التكرار فعال. التفعيل يتحقق من أن كل خطوة مكتملة: التصنيف أو الحقل أو القالب المعتمد ومتغيراته.', 'Duplicate suppression is on. Activation checks every step is complete: its label, field, or approved template and variables.')])])]),
      ]),
      h('aside', { class: 'automation-inspector' }, [
        h('h2', {}, [t(state, 'تفاصيل المسودة', 'Draft details')]),
        labelInput('automationName', t(state, 'الاسم', 'Name'), automation.name),
        labelInput('automationDescription', t(state, 'الوصف', 'Description'), automation.description ?? ''),
        labelInput('automationTimezone', t(state, 'المنطقة الزمنية', 'Timezone'), automation.timezone),
        effectiveTrigger === 'schedule' ? h('div', { class: 'automation-schedule-fields' }, [
          h('h3', {}, [t(state, 'الجدول', 'Schedule')]),
          h('label', { class: 'field' }, [h('span', { class: 'field__label' }, [t(state, 'التكرار', 'Recurrence')]), select('automationScheduleKind', scheduleKind, ['one_time','daily','weekly','monthly','custom_recurrence'])]),
          ...(scheduleKind === 'one_time' ? [labelInput('automationScheduleAt', t(state, 'وقت التنفيذ بصيغة ISO', 'Execution instant (ISO)'), String(automation.workflow.schedule?.['at'] ?? ''))] : []),
          ...(['daily','weekly','monthly'].includes(scheduleKind) ? [labelInput('automationScheduleTime', t(state, 'الوقت', 'Time'), String(automation.workflow.schedule?.['time'] ?? '09:00'))] : []),
          ...(scheduleKind === 'weekly' ? [labelInput('automationScheduleDays', t(state, 'أيام الأسبوع 0–6', 'Weekdays 0–6'), String(automation.workflow.schedule?.['daysOfWeek'] ?? '1'))] : []),
          ...(scheduleKind === 'monthly' ? [labelInput('automationScheduleDay', t(state, 'يوم الشهر', 'Day of month'), String(automation.workflow.schedule?.['dayOfMonth'] ?? '1'))] : []),
          ...(scheduleKind === 'custom_recurrence' ? [labelInput('automationScheduleEvery', t(state, 'كل عدد دقائق', 'Every N minutes'), String(automation.workflow.schedule?.['everyMinutes'] ?? '60'))] : []),
        ]) : null,
        h('div', { class: 'automation-review' }, [h('span', {}, [t(state, 'الحالة', 'State')]), badge(human(automation.state), STATE_TONE[automation.state] ?? 'neutral')]),
      ]),
    ]),
  ]);
}

function stepName(state: AppState, type: string): string {
  const names = STEP_NAMES[type];
  return names === undefined ? human(type) : t(state, names[0], names[1]);
}

/** Only kinds the executor runs are offered; one a draft already holds stays visible, marked. */
function stepSelect(state: AppState, stepId: string, type: string): HTMLSelectElement {
  const options = runnable(type) ? RUNNABLE_STEPS : [...RUNNABLE_STEPS, type];
  return selectControl({
    form: `automationStep_${stepId}`,
    value: type,
    ariaLabel: t(state, 'نوع الخطوة', 'Step type'),
    options: options.map((option) => ({ value: option, label: runnable(option) ? stepName(state, option) : t(state, `${human(option)} (غير متاحة بعد)`, `${human(option)} (not available yet)`) })),
  });
}

function stepConfig(state: AppState, step: Automation['workflow']['steps'][number], type: string): Child {
  const own = type === step.type ? step.config : {};
  const form = state.dialogForm;
  if (type === 'send_whatsapp_template') return whatsappStep(state, step);
  if (type === 'delay') {
    const parts = delayParts(own);
    return h('div', { class: 'workflow-config workflow-config--row' }, [
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'المدة', 'How long')]),
        h('input', { class: 'input', type: 'number', min: '1', value: form[`automationDelay_${step.id}`] ?? String(parts.amount), 'data-act': 'form', 'data-form': `automationDelay_${step.id}` }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'الوحدة', 'Unit')]),
        selectControl({
          form: `automationDelayUnit_${step.id}`,
          value: form[`automationDelayUnit_${step.id}`] ?? parts.unit,
          options: (Object.keys(DELAY_UNITS) as DelayUnit[]).map((unit) => ({
            value: unit,
            label: unit === 'minutes' ? t(state, 'دقائق', 'Minutes') : unit === 'hours' ? t(state, 'ساعات', 'Hours') : t(state, 'أيام', 'Days'),
          })),
        }),
      ]),
    ]);
  }
  if (type === 'add_label' || type === 'remove_label') return labelPicker(state, `automationLabel_${step.id}`, form[`automationLabel_${step.id}`] ?? String(own['labelId'] ?? ''));
  if (type === 'update_customer_field') {
    const fields = rowsOf(state.live.customFields).filter((field) => field.target === 'contact' && field.state === 'active');
    const chosen = form[`automationField_${step.id}`] ?? String(own['fieldId'] ?? '');
    return h('div', { class: 'workflow-config workflow-config--row' }, [
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'الحقل', 'Field')]),
        selectControl({
          form: `automationField_${step.id}`,
          value: chosen,
          options: [{ value: '', label: t(state, 'اختر حقلًا', 'Choose a field') }, ...fields.map((field) => ({ value: field.id, label: field.name }))],
        }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label' }, [t(state, 'القيمة', 'Value')]),
        h('input', { class: 'input', value: form[`automationFieldValue_${step.id}`] ?? (own['value'] === undefined ? '' : String(own['value'])), 'data-act': 'form', 'data-form': `automationFieldValue_${step.id}` }),
      ]),
    ]);
  }
  return h('p', { class: 'workflow-block__warning' }, [icon('alert', 14), t(state,
    'هذه الخطوة لا يمكن تشغيلها بعد، والتفعيل سيرفضها. اختر إجراءً آخر.',
    'This step cannot run yet, and activation will refuse it. Choose another action.')]);
}

function labelPicker(state: AppState, key: string, chosen: string): HTMLElement {
  const labels = state.live.labels;
  const active = rowsOf(labels).filter((label) => label.state === 'active');
  if (active.length === 0) {
    return h('p', { class: 'workflow-block__warning' }, [icon('tag', 14), labels.status === 'ready'
      ? t(state, 'لا توجد تصنيفات بعد. أنشئها من صفحة جهات الاتصال.', 'No labels yet. Create them on the Contacts screen.')
      : t(state, 'جارٍ تحميل التصنيفات…', 'Loading labels…')]);
  }
  return h('label', { class: 'field workflow-config' }, [
    h('span', { class: 'field__label' }, [t(state, 'التصنيف', 'Label')]),
    selectControl({
      form: key,
      value: chosen,
      options: [{ value: '', label: t(state, 'اختر تصنيفًا', 'Choose a label') }, ...active.map((label) => ({ value: label.id, label: label.name }))],
    }),
  ]);
}

/** Who it runs for; a label audience names its label here. */
function targetBlock(state: AppState, automation: Automation): HTMLElement {
  const target = state.dialogForm['automationTarget'] || automation.workflow.target.type;
  const own = target === automation.workflow.target.type ? automation.workflow.target.config : {};
  return h('article', { class: 'workflow-block workflow-block--root' }, [h('div', { class: 'workflow-block__body' }, [
    h('span', { class: 'workflow-block__kind' }, [t(state, 'لمن', 'FOR')]),
    h('h3', {}, [t(state, 'مَن أو ما الذي يعمل عليه؟', 'Who or what should it work on?')]),
    select('automationTarget', target, TARGETS),
    target === 'label' ? labelPicker(state, 'automationTargetLabel', state.dialogForm['automationTargetLabel'] ?? String(own['labelId'] ?? '')) : null,
  ])]);
}

function fieldBlock(state: AppState, label: string, title: string, control: HTMLElement): HTMLElement { return h('article', { class: 'workflow-block workflow-block--root' }, [h('div', { class: 'workflow-block__body' }, [h('span', { class: 'workflow-block__kind' }, [label]), h('h3', {}, [title]), control])]); }
/**
 * The template picker for a `send_whatsapp_template` step.
 *
 * Written out rather than on one line because three of its guards cannot be
 * reached and that should be visible rather than buried: the function returns
 * early when the catalogue is empty, so from that point `templates[0]` and the
 * `find(...) ?? templates[0]` fallback are both guaranteed to exist. They stay
 * because they are what makes the types honest at each step, and because a
 * future edit that moves the early return would need them.
 */
function whatsappStep(state: AppState, step: Automation['workflow']['steps'][number]): HTMLElement {
  const templates = rowsOf(state.live.whatsappTemplates);
  if (templates.length === 0) {
    // The honest configuration-required state: nothing has connected a WhatsApp
    // number and synchronized its approved templates yet.
    return h('p', { class: 'workflow-block__warning' }, [
      icon('alert', 14),
      t(state, 'اربط حساب WhatsApp ثم زامن القوالب المعتمدة.', 'Connect WhatsApp and synchronize approved templates first.'),
    ]);
  }
  const stored = step.config['templateId'];
  /* c8 ignore next -- the early return above guarantees a first template */
  const fallback = templates[0]?.id ?? '';
  const selected = state.dialogForm[`automationTemplate_${step.id}`] || String(stored ?? fallback);
  /* c8 ignore next -- same: find may miss, templates[0] cannot */
  const template = templates.find((entry) => entry.id === selected) ?? templates[0];
  return h('div', { class: 'whatsapp-template-picker' }, [
    h('label', { class: 'field' }, [
      h('span', { class: 'field__label' }, [t(state, 'قالب WhatsApp المعتمد', 'Approved WhatsApp template')]),
      h('select', { class: 'select', 'data-act': 'form', 'data-form': `automationTemplate_${step.id}` },
        templates.map((entry) => h('option', { value: entry.id, selected: entry.id === selected }, [`${entry.templateName} · ${entry.language}`]))),
    ]),
    /* c8 ignore next -- `template` is always defined here */
    ...(template?.variables ?? []).map((variable) => h('label', { class: 'field' }, [
      h('span', { class: 'field__label' }, [`{{${variable}}}`]),
      select(`automationVariable_${step.id}_${variable}`, 'customer_field',
        ['customer_field','customer_custom_field','course_field','session_field','automation_context','static_value','current_date','current_time']),
    ])),
    h('div', { class: 'template-preview' }, [
      h('span', {}, [t(state, 'معاينة', 'Preview')]),
      /* c8 ignore next -- as above */
      h('strong', {}, [template?.templateName ?? '']),
    ]),
  ]);
}
function connector(): HTMLElement { return h('div', { class: 'workflow-connector', 'aria-hidden': 'true' }, [h('span', {})]); }
function select(name: string, value: string, options: readonly string[]): HTMLSelectElement { return h('select', { class: 'select', 'data-act': 'form', 'data-form': name }, options.map((option) => h('option', { value: option, selected: option === value }, [human(option)]))); }
function labelInput(name: string, label: string, value: string): HTMLElement { return h('label', { class: 'field' }, [h('span', { class: 'field__label' }, [label]), h('input', { class: 'input', name, value, 'data-act': 'form', 'data-form': name })]); }

function runsView(state: AppState): Child {
  const resource = state.live.automationRuns;
  if (resource.status === 'idle' || resource.status === 'loading') return skeleton(state, 5);
  if (resource.status === 'error') return errorState(state, resource.error, 'live-automations-reload');
  const controls = runsFilters(state);
  if (resource.value.length === 0) return panel(t(state, 'التشغيل والسجلات', 'Runs & Logs'), [controls, emptyState({ icon: 'history', title: t(state, 'لا توجد عمليات تشغيل', 'No runs yet'), body: t(state, 'ستظهر هنا عمليات الاختبار والإنتاج، منفصلة عن الحملات.', 'Test and production runs will appear here, separate from campaigns.') })]);
  return panel(t(state, 'آخر عمليات التشغيل', 'Recent runs'), [controls, runsTable(state, resource.value), state.live.automationRunsNextCursor === null ? null : h('div', { class: 'automation-list__more' }, [button({ label: t(state, 'تحميل المزيد', 'Load more'), act: 'live-automation-runs-load-more', small: true })])], { flush: true });
}

function runsFilters(state: AppState): HTMLElement {
  const limit = state.dialogForm['automationRunsLimit'] ?? String(state.live.automationRunsQuery.limit);
  return h('form', { class: 'toolbar automation-list__filters', 'data-submit': 'live-automation-runs-filter', novalidate: true }, [
    h('label', { class: 'field field--inline' }, [h('span', { class: 'field__label' }, [t(state, 'لكل صفحة', 'Per page')]), h('select', { class: 'select', 'data-act': 'form', 'data-form': 'automationRunsLimit' }, ['25', '50'].map((value) => h('option', { value, selected: value === limit }, [value])))]),
    button({ label: t(state, 'تطبيق', 'Apply'), act: 'live-automation-runs-filter', small: true }),
  ]);
}

function runsTable(state: AppState, runs: readonly AutomationRun[]): HTMLElement { return h('div', { class: 'tablewrap' }, [h('table', { class: 'table' }, [h('thead', {}, [h('tr', {}, [t(state,'وقت التشغيل','Run date'),t(state,'المشغّل','Trigger'),t(state,'الجمهور','Audience'),t(state,'أُرسلت','Sent'),t(state,'سُلّمت','Delivered'),t(state,'فشلت','Failed'),t(state,'الحالة','Status')].map((label) => h('th', { scope: 'col' }, [label])))]), h('tbody', {}, runs.map((run) => h('tr', {}, [h('td', {}, [dateFormat(state.lang,{dateStyle:'medium',timeStyle:'short'}).format(new Date(run.scheduled_for))]), h('td', {}, [human(run.trigger_type), run.mode === 'test' ? badge('TEST','warning') : null]), h('td', {}, [formatNumber(run.audience_count,state.lang)]), h('td', {}, [formatNumber(run.sent_count,state.lang)]), h('td', {}, [formatNumber(run.delivered_count,state.lang)]), h('td', {}, [formatNumber(run.failed_count,state.lang)]), h('td', {}, [badge(human(run.status), run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'accent', {dot:true})])])))] )]); }

function human(value: string): string { return value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
