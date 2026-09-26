import type { TemplateBindings, WhatsAppTemplateDefinition, WhatsAppTemplateParameterDefinition } from '@convo/domain';
import type { WhatsAppTemplate } from '../api/automations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { initials } from '../format.js';
import { icon } from '../icons.js';
import type { BindingDraft, BindingPart, PreviewSample } from '../live/template-binding.js';
import { bindingKey, bindingsFromForm, sampleValues, templateDefinition, templateSegments } from '../live/template-binding.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { badge, isolated, selectControl } from './parts.js';

/**
 * Choosing an approved WhatsApp template and saying where each of its
 * variables comes from, beside a preview drawn the way WhatsApp draws it.
 *
 * Shared by the broadcast wizard and the automation step. `prefix` keeps the
 * form keys of one composer apart from another's; `pick` is the form key that
 * holds the chosen template.
 */
export interface ComposerOptions {
  readonly prefix: string;
  readonly pick: string;
  readonly templates: readonly WhatsAppTemplate[];
  readonly selectedId: string;
  readonly stored: TemplateBindings;
  readonly sample: PreviewSample;
  /** The business name over the preview. */
  readonly sender: string;
  readonly compact?: boolean;
  /** Marks each variable still without a value; set once the operator tried to go on. */
  readonly showMissing?: boolean;
}

export function templateComposer(state: AppState, options: ComposerOptions): HTMLElement {
  const selected = options.templates.find((template) => template.id === options.selectedId);
  const definition = selected === undefined ? null : templateDefinition(selected);
  const fields = rowsOf(state.live.customFields).filter((field) => field.target === 'contact' && field.state === 'active');
  const draft = definition === null ? null : bindingsFromForm(state.dialogForm, options.prefix, definition, options.stored);
  const values = definition === null || draft === null ? {} : sampleValues(definition, draft.bindings, fields, options.sample);
  return h('div', { class: `tpl-composer${options.compact === true ? ' tpl-composer--compact' : ''}` }, [
    h('div', { class: 'tpl-composer__pick' }, [
      h('div', { class: 'tpl-list', role: 'listbox', 'aria-label': t(state, 'القوالب المعتمدة', 'Approved templates') }, options.templates.map((template) => {
        const own = templateDefinition(template);
        const chosen = template.id === options.selectedId;
        const body = own.components.find((component) => component.type === 'body')?.text ?? '';
        return h('button', {
          type: 'button',
          class: `tpl-card${chosen ? ' is-selected' : ''}`,
          role: 'option',
          'aria-selected': String(chosen),
          'data-act': 'form-toggle',
          'data-arg': `${options.pick}:${template.id}`,
          disabled: !own.sendSupported,
        }, [
          h('span', { class: 'tpl-card__top' }, [
            h('span', { class: 'tpl-card__name' }, [isolated(template.templateName, true)]),
            chosen ? icon('check', 14) : null,
          ]),
          h('span', { class: 'tpl-card__meta' }, [
            badge(template.language, 'neutral'),
            badge(categoryLabel(state, template.category), template.category.toLowerCase() === 'marketing' ? 'accent' : 'neutral'),
            own.parameters.length === 0 ? null : h('span', { class: 'tpl-card__vars' }, [t(state, `${String(own.parameters.length)} متغير`, `${String(own.parameters.length)} variables`)]),
          ]),
          h('span', { class: 'tpl-card__body', dir: 'auto' }, [body]),
          own.sendSupported ? null : h('span', { class: 'tpl-card__warning' }, [icon('alert', 12), t(state, 'قالب بوسائط لا يدعمه الإرسال الجماعي بعد', 'Media templates cannot be broadcast yet')]),
        ]);
      })),
    ]),
    h('div', { class: 'tpl-composer__detail' }, [
      whatsappPreview(state, definition, values, options.sender, selected?.language ?? state.lang, `${options.prefix}|`),
      definition === null || draft === null
        ? h('p', { class: 'field__hint' }, [t(state, 'اختر قالبًا لترى شكله وتحدد قيم متغيراته.', 'Choose a template to see it and set its variables.')])
        : variablesEditor(state, options.prefix, definition, draft, fields, options.showMissing === true),
    ]),
  ]);
}

function categoryLabel(state: AppState, category: string): string {
  const value = category.toLowerCase();
  if (value === 'marketing') return t(state, 'تسويقي', 'Marketing');
  if (value === 'utility') return t(state, 'خدمي', 'Utility');
  if (value === 'authentication') return t(state, 'تحقق', 'Authentication');
  return category;
}

/** Where in the template a parameter sits. */
function parameterPlace(state: AppState, parameter: WhatsAppTemplateParameterDefinition): string {
  if (parameter.component === 'header') return t(state, 'العنوان', 'Header');
  if (parameter.component === 'body') return t(state, 'النص', 'Body');
  // A button parameter always belongs to one button.
  const button = String(parameter.index! + 1);
  return t(state, `رابط الزر ${button}`, `Button ${button} link`);
}

function variablesEditor(
  state: AppState,
  prefix: string,
  definition: WhatsAppTemplateDefinition,
  draft: BindingDraft,
  fields: readonly { readonly id: string; readonly name: string }[],
  showMissing: boolean,
): HTMLElement {
  if (definition.parameters.length === 0) {
    return h('p', { class: 'tpl-vars__none' }, [icon('check', 14), t(state, 'هذا القالب بلا متغيرات: يصل للجميع كما هو.', 'This template has no variables: everyone gets it as is.')]);
  }
  return h('div', { class: 'tpl-vars' }, [
    h('p', { class: 'tpl-vars__title' }, [t(state, 'قيم المتغيرات', 'Variable values')]),
    ...definition.parameters.map((parameter) => {
      const binding = draft.bindings[parameter.key];
      const key = (part: BindingPart): string => bindingKey(prefix, parameter.key, part);
      const source = draft.sources[parameter.key]!;
      // Asking for what is missing waits until the operator tried to go on.
      const unfilled = showMissing && draft.missing.includes(parameter.key);
      return h('div', { class: `tpl-var${unfilled ? ' tpl-var--missing' : ''}`, 'data-parameter': parameter.key }, [
        h('span', { class: 'tpl-var__label' }, [
          h('code', { class: 'tpl-var__token', dir: 'ltr' }, [`{{${String(parameter.position)}}}`]),
          h('span', { class: 'tpl-var__place' }, [parameterPlace(state, parameter)]),
        ]),
        selectControl({
          form: key('source'),
          value: source,
          ariaLabel: t(state, 'مصدر القيمة', 'Value source'),
          options: [
            { value: 'display_name', label: t(state, 'اسم العميل', 'Contact name') },
            { value: 'phone', label: t(state, 'رقم الواتساب', 'WhatsApp number') },
            { value: 'field', label: t(state, 'حقل من بيانات العميل', 'Contact field') },
            { value: 'static', label: t(state, 'نص ثابت', 'Fixed text') },
          ],
        }),
        h('div', { class: 'tpl-var__inputs' }, [
          source === 'field'
            ? selectControl({
                form: key('field'),
                value: binding?.fieldId ?? state.dialogForm[key('field')] ?? '',
                ariaLabel: t(state, 'الحقل', 'Field'),
                options: [
                  { value: '', label: fields.length === 0 ? t(state, 'لا توجد حقول بعد', 'No fields yet') : t(state, 'اختر حقلًا', 'Choose a field') },
                  ...fields.map((field) => ({ value: field.id, label: field.name })),
                ],
              })
            : source === 'static'
              ? h('input', {
                  class: 'input',
                  value: binding?.value ?? state.dialogForm[key('value')] ?? '',
                  placeholder: parameter.example ?? t(state, 'النص الذي يظهر للجميع', 'Text everyone sees'),
                  'aria-label': t(state, 'النص', 'Text'),
                  dir: 'auto',
                  'data-act': 'form',
                  'data-form': key('value'),
                  'data-wa-parameter': `${prefix}|${parameter.key}`,
                })
              : null,
          source === 'static'
            ? null
            : h('input', {
                class: 'input',
                value: binding?.fallback ?? state.dialogForm[key('fallback')] ?? '',
                placeholder: t(state, 'قيمة بديلة', 'Fallback'),
                title: t(state, 'تُستخدم إن لم تكن للعميل قيمة', 'Used when the contact has no value'),
                'aria-label': t(state, 'القيمة البديلة', 'Fallback value'),
                dir: 'auto',
                'data-act': 'form',
                'data-form': key('fallback'),
              }),
        ]),
        unfilled ? h('p', { class: 'field__error' }, [source === 'field' ? t(state, 'اختر الحقل.', 'Choose the field.') : t(state, 'اكتب النص.', 'Type the text.')]) : null,
      ]);
    }),
    h('p', { class: 'field__hint' }, [t(state,
      'إن لم يكن للعميل قيمة ولا يوجد بديل، لا تُرسل له الرسالة بدل أن تصله ناقصة.',
      'A contact with no value and no fallback is skipped rather than sent an incomplete message.')]),
  ]);
}

/**
 * The template as the customer's phone would show it: a business header, a
 * chat bubble with header, body, footer and the time, and its buttons below.
 * Variables are marked so the operator sees what changes per person.
 */
export function whatsappPreview(
  state: AppState,
  definition: WhatsAppTemplateDefinition | null,
  values: Readonly<Record<string, string>>,
  sender: string,
  language: string,
  previewPrefix = '',
): HTMLElement {
  const header = definition?.components.find((component) => component.type === 'header');
  const body = definition?.components.find((component) => component.type === 'body');
  const footer = definition?.components.find((component) => component.type === 'footer');
  const buttons = definition?.components.find((component) => component.type === 'buttons')?.buttons ?? [];
  const segments = (text: string, component: 'header' | 'body'): readonly Child[] => templateSegments(text, component, values).map((segment) =>
    'key' in segment
      ? h('mark', { class: 'wa-var', 'data-template-preview-key': `${previewPrefix}${segment.key}` }, [segment.value])
      : segment.text);
  return h('div', { class: 'wa-phone', 'aria-label': t(state, 'معاينة واتساب', 'WhatsApp preview') }, [
    h('div', { class: 'wa-phone__bar' }, [
      h('span', { class: 'wa-phone__avatar', 'aria-hidden': 'true' }, [initials(sender)]),
      h('span', { class: 'wa-phone__name' }, [isolated(sender)]),
      h('span', { class: 'wa-phone__verified', 'aria-hidden': 'true' }, [icon('check', 10)]),
    ]),
    h('div', { class: 'wa-phone__chat' }, [
      definition === null
        ? h('div', { class: 'wa-bubble wa-bubble--empty' }, [t(state, 'ستظهر رسالتك هنا', 'Your message appears here')])
        : h('div', { class: 'wa-bubble', dir: language.toLowerCase().startsWith('ar') ? 'rtl' : 'ltr' }, [
            header?.text === null || header === undefined ? null : h('p', { class: 'wa-bubble__header' }, segments(header.text, 'header')),
            body?.text === null || body === undefined ? null : h('p', { class: 'wa-bubble__body' }, segments(body.text, 'body')),
            footer?.text === null || footer === undefined ? null : h('p', { class: 'wa-bubble__footer' }, [footer.text]),
            h('span', { class: 'wa-bubble__time', dir: 'ltr' }, ['12:00']),
          ]),
      buttons.length === 0 ? null : h('div', { class: 'wa-buttons' }, buttons.map((entry) =>
        h('span', { class: 'wa-button' }, [icon(entry.type.toLowerCase() === 'url' ? 'link' : entry.type.toLowerCase().includes('phone') ? 'phone' : 'reply', 14), entry.text]))),
    ]),
  ]);
}
