import type { TemplateBindings } from '@convo/domain';
import type { Campaign } from '../api/campaigns.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber } from '../format.js';
import { icon } from '../icons.js';
import { hasPermission } from '../live/ability.js';
import { editorAudience, previewKey } from '../live/audience.js';
import { BROADCAST_PREFIX, broadcastName, broadcastStep, broadcastTemplate, whatsappNumbers } from '../live/broadcast.js';
import { bindingsFromForm, templateDefinition } from '../live/template-binding.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { audienceSection } from './campaign-audience.js';
import { t } from './copy.js';
import { button, dialogShell, emptyState, inlineError, isolated, notice, textInput } from './parts.js';
import { templateComposer } from './template-composer.js';

/**
 * A WhatsApp broadcast, set up the way broadcast tools lay it out: the number
 * it goes from, the approved template and where each of its variables comes
 * from — beside a preview of the message — who receives it, and whether it
 * goes now or at a time. Each step is checked before the next opens, and the
 * last one reads everything back before anything is sent.
 */

const STEPS: readonly (readonly [string, string, 'settings' | 'template' | 'users' | 'send'])[] = [
  ['الإعداد', 'Setup', 'settings'],
  ['الرسالة', 'Message', 'template'],
  ['الجمهور', 'Audience', 'users'],
  ['الإرسال', 'Send', 'send'],
];

export function broadcastWizard(state: AppState, kind: string, campaignId: string): HTMLElement {
  const live = state.live;
  const campaign = kind === 'campaign-edit' ? rowsOf(live.campaigns).find((entry) => entry.id === campaignId) : undefined;
  const title = campaign === undefined ? t(state, 'بث واتساب جديد', 'New WhatsApp broadcast') : t(state, 'تعديل البث', 'Edit broadcast');
  if (kind === 'campaign-edit' && campaign === undefined) {
    return dialogShell(state, title, [notice('warning', 'alert', t(state, 'لم تعد الحملة موجودة. حدّث القائمة.', 'The campaign no longer exists. Refresh the list.'))], [closeButton(state)]);
  }
  const numbers = whatsappNumbers(state, campaign?.connection_id);
  if (numbers.length === 0) {
    return dialogShell(state, title, [
      emptyState({
        icon: 'plug',
        title: t(state, 'اربط رقم واتساب أولًا', 'Connect a WhatsApp number first'),
        body: t(state, 'البث يُرسل من رقم واتساب للأعمال بقوالب معتمدة من Meta. اربط رقمك وزامن قوالبه ثم عُد هنا.', 'Broadcasts go out from a WhatsApp Business number using templates Meta approved. Connect yours, sync its templates, then come back.'),
        action: { label: t(state, 'ربط واتساب', 'Connect WhatsApp'), act: 'nav', arg: 'channels', primary: true },
      }),
    ], [closeButton(state)], { size: 'lg' });
  }
  const step = broadcastStep(state);
  const busy = live.busy === 'broadcast-submit';
  return dialogShell(state, title, [
    h('div', { class: 'broadcast' }, [
      stepper(state, step),
      inlineError(state, live.error),
      step === 0 ? setupStep(state, campaign, numbers)
        : step === 1 ? messageStep(state, campaign)
          : step === 2 ? audienceStep(state)
            : sendStep(state, campaign),
    ]),
  ], [
    step === 0 ? closeButton(state) : button({ label: t(state, 'السابق', 'Back'), icon: 'chevronStart', act: 'live-broadcast-step', arg: String(step - 1), variant: 'ghost' }),
    step < 3
      ? button({ label: t(state, 'التالي', 'Next'), icon: 'chevronEnd', act: 'live-broadcast-step', arg: String(step + 1), variant: 'primary' })
      : h('div', { class: 'broadcast__finish' }, [
          button({ label: t(state, 'حفظ كمسودة', 'Save as draft'), act: 'live-broadcast-submit', arg: 'draft', variant: 'ghost', busy: busy && state.dialogForm['broadcastMode'] === 'draft' }),
          sendButton(state, busy),
        ]),
  ], { size: 'lg' });
}

function closeButton(state: AppState): HTMLElement {
  return button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' });
}

function sendButton(state: AppState, busy: boolean): HTMLElement {
  const later = state.dialogForm['campaignWhen'] === 'later';
  const mayLaunch = hasPermission(state.live, 'campaign.launch') && hasPermission(state.live, 'campaign.approve');
  return button({
    label: !mayLaunch ? t(state, 'إرسال للاعتماد', 'Submit for approval')
      : later ? t(state, 'جدولة البث', 'Schedule broadcast') : t(state, 'إرسال الآن', 'Send now'),
    icon: later ? 'calendar' : 'send',
    act: 'live-broadcast-submit',
    arg: later ? 'schedule' : 'now',
    variant: 'primary',
    busy: busy && state.dialogForm['broadcastMode'] !== 'draft',
  });
}

function stepper(state: AppState, current: number): HTMLElement {
  return h('ol', { class: 'broadcast__steps', 'aria-label': t(state, 'مراحل البث', 'Broadcast steps') }, STEPS.map(([ar, en, name], index) =>
    h('li', { class: `broadcast__step${index < current ? ' is-done' : index === current ? ' is-current' : ''}` }, [
      h('button', {
        type: 'button',
        class: 'broadcast__step-button',
        'aria-current': index === current ? 'step' : undefined,
        'data-act': 'live-broadcast-step',
        'data-arg': String(index),
      }, [
        h('span', { class: 'broadcast__step-mark', 'aria-hidden': 'true' }, [index < current ? icon('check', 14) : icon(name === 'settings' ? 'settings' : name === 'template' ? 'template' : name === 'users' ? 'users' : 'send', 14)]),
        h('span', { class: 'broadcast__step-label' }, [t(state, ar, en)]),
      ]),
    ])));
}

function fieldError(state: AppState, key: string): HTMLElement | null {
  const message = state.formErrors[key];
  return message === undefined ? null : h('p', { class: 'field__error', role: 'alert' }, [message]);
}

function setupStep(state: AppState, campaign: Campaign | undefined, numbers: ReturnType<typeof whatsappNumbers>): HTMLElement {
  const form = state.dialogForm;
  // The wizard opens only with a number to offer.
  const chosen = form['campaignConnection'] ?? campaign?.connection_id ?? numbers[0]!.id;
  return h('section', { class: 'broadcast__panel', 'aria-label': t(state, 'الإعداد', 'Setup') }, [
    h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: 'campaign-name' }, [t(state, 'اسم البث', 'Broadcast name')]),
      textInput('campaignName', form['campaignName'] ?? campaign?.name ?? '', t(state, 'مثال: عرض كورسات سبتمبر', 'e.g. September course offer'), { id: 'campaign-name', required: true }),
      h('p', { class: 'field__hint' }, [t(state, 'للفريق فقط، لا يراه العملاء.', 'For your team only; customers never see it.')]),
      fieldError(state, 'campaignName'),
    ]),
    h('div', { class: 'field' }, [
      h('span', { class: 'field__label', id: 'campaign-number-label' }, [t(state, 'يُرسل من رقم', 'Send from')]),
      h('div', { class: 'broadcast__numbers', role: 'radiogroup', 'aria-labelledby': 'campaign-number-label' }, numbers.map((connection) =>
        h('button', {
          type: 'button',
          class: 'broadcast__number',
          role: 'radio',
          'aria-checked': String(connection.id === chosen),
          'data-act': 'form-toggle',
          'data-arg': `campaignConnection:${connection.id}`,
        }, [
          h('span', { class: 'broadcast__number-icon', 'aria-hidden': 'true' }, [icon('chat', 16)]),
          h('span', { class: 'broadcast__number-text' }, [
            h('strong', {}, [connection.display_name]),
            h('span', {}, [isolated(connection.external_asset_id, true)]),
          ]),
          connection.status === 'healthy'
            ? h('span', { class: 'broadcast__number-state is-ready' }, [t(state, 'جاهز', 'Ready')])
            : h('span', { class: 'broadcast__number-state' }, [t(state, 'غير مكتمل الإعداد', 'Setup incomplete')]),
        ]))),
      fieldError(state, 'campaignConnection'),
    ]),
    notice('info', 'shield', t(state,
      'واتساب يسمح ببدء المحادثة مع العملاء بالقوالب المعتمدة فقط، ولمن وافق على استقبال رسائلك التسويقية.',
      'WhatsApp lets a business start a conversation only with an approved template, and only with people who agreed to hear from it.')),
  ]);
}

function messageStep(state: AppState, campaign: Campaign | undefined): HTMLElement {
  const { connectionId } = editorAudience(state);
  const templates = rowsOf(state.live.whatsappTemplates).filter((template) => template.connectionId === connectionId);
  const connection = rowsOf(state.live.connections).find((entry) => entry.id === connectionId);
  const templatesState = state.live.whatsappTemplates;
  if (templatesState.status !== 'ready') {
    return h('section', { class: 'broadcast__panel' }, [h('p', { class: 'field__hint', role: 'status' }, [templatesState.status === 'error'
      ? templatesState.error.message
      : t(state, 'جارٍ تحميل القوالب المعتمدة…', 'Loading approved templates…')])]);
  }
  if (templates.length === 0) {
    return h('section', { class: 'broadcast__panel' }, [emptyState({
      icon: 'template',
      title: t(state, 'لا توجد قوالب معتمدة لهذا الرقم', 'No approved templates on this number'),
      body: t(state, 'أنشئ القالب في WhatsApp Manager وانتظر اعتماده، ثم زامن القوالب من صفحة القنوات.', 'Create the template in WhatsApp Manager and wait for approval, then sync templates from the Channels screen.'),
      action: { label: t(state, 'صفحة القنوات', 'Open Channels'), act: 'nav', arg: 'channels' },
    })]);
  }
  const { template, stored } = broadcastTemplate(state, campaign);
  const problem = state.formErrors['campaignTemplate'];
  return h('section', { class: 'broadcast__panel', 'aria-label': t(state, 'الرسالة', 'Message') }, [
    problem === undefined ? null : notice('danger', 'alert', problem),
    templateComposer(state, {
      prefix: BROADCAST_PREFIX,
      pick: 'campaignTemplate',
      templates,
      selectedId: template,
      stored,
      sample: { name: t(state, 'منى', 'Mona'), phone: '+20 100 000 0000' },
      sender: connection?.display_name ?? 'WhatsApp',
      showMissing: problem !== undefined,
    }),
  ]);
}

function audienceStep(state: AppState): HTMLElement {
  return h('section', { class: 'broadcast__panel broadcast__panel--audience', 'aria-label': t(state, 'الجمهور', 'Audience') }, [audienceSection(state)]);
}

function sendStep(state: AppState, campaign: Campaign | undefined): HTMLElement {
  const form = state.dialogForm;
  const when = form['campaignWhen'] === 'later' ? 'later' : 'now';
  const { connectionId, filter } = editorAudience(state);
  const connection = rowsOf(state.live.connections).find((entry) => entry.id === connectionId);
  const { template: templateId, stored } = broadcastTemplate(state, campaign);
  const template = rowsOf(state.live.whatsappTemplates).find((entry) => entry.id === templateId);
  const bindings: TemplateBindings = template === undefined ? {} : bindingsFromForm(form, BROADCAST_PREFIX, templateDefinition(template), stored).bindings;
  const preview = state.live.audiencePreview;
  const count = filter !== null && preview !== null && preview.key === previewKey(connectionId, filter) && preview.result.status === 'ready' ? preview.result.value : null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scheduled = form['campaignScheduleAt'] ?? '';
  return h('section', { class: 'broadcast__panel', 'aria-label': t(state, 'الإرسال', 'Send') }, [
    h('div', { class: 'broadcast__when', role: 'radiogroup', 'aria-label': t(state, 'متى يُرسل؟', 'When does it go?') }, ([
      ['now', 'send', t(state, 'أرسل الآن', 'Send now'), t(state, 'يبدأ الإرسال فور التأكيد.', 'Sending starts as soon as you confirm.')],
      ['later', 'calendar', t(state, 'جدولة لوقت لاحق', 'Schedule for later'), t(state, 'اختر اليوم والساعة.', 'Pick the day and time.')],
    ] as const).map(([value, name, title, body]) => h('button', {
      type: 'button',
      class: 'broadcast__choice',
      role: 'radio',
      'aria-checked': String(when === value),
      'data-act': 'form-toggle',
      'data-arg': `campaignWhen:${value}`,
    }, [
      h('span', { class: 'broadcast__choice-icon', 'aria-hidden': 'true' }, [icon(name, 18)]),
      h('span', { class: 'broadcast__choice-text' }, [h('strong', {}, [title]), h('span', {}, [body])]),
    ]))),
    when === 'later'
      ? h('div', { class: 'field broadcast__schedule' }, [
          h('label', { class: 'field__label', for: 'campaign-schedule-at' }, [t(state, 'وقت الإرسال', 'Send at')]),
          h('input', { id: 'campaign-schedule-at', class: 'input', type: 'datetime-local', value: scheduled, 'data-act': 'form-toggle', 'data-form': 'campaignScheduleAt' }),
          h('p', { class: 'field__hint' }, [t(state, `بتوقيت ${zone}`, `In ${zone} time`)]),
          fieldError(state, 'campaignScheduleAt'),
        ])
      : null,
    h('dl', { class: 'broadcast__review' }, [
      review(t(state, 'الاسم', 'Name'), broadcastName(state, campaign)),
      review(t(state, 'من رقم', 'From'), connection === undefined ? '—' : `${connection.display_name} · ${connection.external_asset_id}`),
      review(t(state, 'القالب', 'Template'), template === undefined ? '—' : `${template.templateName} · ${template.language}`),
      review(t(state, 'المتغيرات', 'Variables'), Object.keys(bindings).length === 0 ? t(state, 'لا توجد', 'None') : Object.entries(bindings).map(([key, binding]) =>
        `${placeName(state, key)} {{${key.split(':').at(-1)!}}}: ${sourceName(state, binding.source)}`).join(t(state, '، ', ', '))),
      review(t(state, 'الجمهور', 'Audience'), count === null
        ? t(state, 'لم يُحسب بعد', 'Not counted yet')
        : t(state, `${formatNumber(count.eligible, state.lang)} سيستلمون من ${formatNumber(count.total, state.lang)}`, `${formatNumber(count.eligible, state.lang)} will receive it, of ${formatNumber(count.total, state.lang)}`)),
      review(t(state, 'الموعد', 'When'), when === 'now' ? t(state, 'الآن', 'Now') : scheduled === '' ? '—' : dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(scheduled))),
    ]),
    count === null
      ? button({ label: t(state, 'احسب الجمهور', 'Check audience'), icon: 'users', act: 'live-campaign-audience-preview', small: true })
      : null,
    fieldError(state, 'campaignAudience'),
    notice('info', 'shield', t(state,
      'يصل البث فقط لمن لديه موافقة تسويقية مسجّلة ولم يلغِ الاشتراك. سجّل الموافقة من ملف العميل.',
      'The broadcast reaches only contacts with recorded marketing consent who have not opted out. Record consent on the contact’s profile.')),
  ]);
}

function placeName(state: AppState, key: string): string {
  if (key.startsWith('header')) return t(state, 'العنوان', 'Header');
  if (key.startsWith('body')) return t(state, 'النص', 'Body');
  return t(state, 'الزر', 'Button');
}

function sourceName(state: AppState, source: string): string {
  if (source === 'display_name') return t(state, 'الاسم', 'name');
  if (source === 'phone') return t(state, 'الرقم', 'number');
  if (source === 'field') return t(state, 'حقل', 'field');
  return t(state, 'نص ثابت', 'fixed text');
}

function review(label: string, value: string): Child {
  return h('div', { class: 'broadcast__review-row' }, [h('dt', {}, [label]), h('dd', {}, [value])]);
}
