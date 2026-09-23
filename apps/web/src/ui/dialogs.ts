import type { Child } from '../dom';
import { h } from '../dom';
import { rowsOf } from '../live/store';
import type { AppState } from '../state';
import { catalogueItem } from './channels-screen';
import { t } from './copy';
import { button, dialogShell, field, inlineError, notice, selectControl, textInput } from './parts';
import { channelTile } from './brand';

function closeButton(state: AppState): HTMLElement {
  return button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' });
}

function fieldError(state: AppState, key: string): HTMLElement | null {
  const message = state.formErrors[key];
  return message === undefined ? null : h('p', { class: 'field__error' }, [message]);
}

/** Returns the dialog layer for the current state, or `null` when none is open. */
export function renderDialog(state: AppState): HTMLElement | null {
  const dialog = state.dialog;
  if (dialog === null) return null;
  if (dialog.kind === 'connect-channel') return connectChannel(state, dialog.arg);
  if (dialog.kind === 'disconnect-channel') return disconnectChannel(state, dialog.arg);
  if (dialog.kind === 'campaign-test-send') return campaignTestSend(state, dialog.arg);
  if (dialog.kind === 'campaign-schedule') return campaignSchedule(state, dialog.arg);
  if (dialog.kind === 'campaign' || dialog.kind === 'campaign-edit') return campaignEditor(state, dialog.kind, dialog.arg);
  if (dialog.kind === 'invite') return invite(state);
  if (dialog.kind === 'change-password') return changePasswordDialog(state);
  if (dialog.kind === 'ownership-offer') return ownershipOffer(state, dialog.arg);
  if (dialog.kind === 'saved-inbox-view') return savedInboxView(state, dialog.arg);
  if (dialog.kind === 'workspace-label') return workspaceLabel(state, dialog.arg);
  if (dialog.kind === 'retire-label') return retireLabelDialog(state, dialog.arg);
  if (dialog.kind === 'inline-label') return inlineLabel(state, dialog.arg);
  if (dialog.kind === 'automation-delete') return automationDelete(state, dialog.arg);
  if (dialog.kind === 'whatsapp-template') return whatsappTemplatePicker(state);
  return dialogShell(
    state,
    t(state, 'غير متاح', 'Not available'),
    [h('p', {}, [t(state, 'لا يوجد محتوى لهذه النافذة.', 'There is nothing to show here.')])],
    [closeButton(state)],
  );
}

function whatsappTemplatePicker(state: AppState): HTMLElement {
  const resource = state.live.conversationTemplates;
  const templates = rowsOf(resource);
  const selectedId = state.dialogForm['whatsappTemplateId'] ?? '';
  const selected = templates.find((item) => item.id === selectedId);
  const parameterValues = Object.fromEntries((selected?.parameters ?? []).map((parameter) => [parameter.key, state.dialogForm[whatsappParameterKey(parameter.key)] ?? '']));
  const direction = selected?.language.toLowerCase().startsWith('ar') ? 'rtl' : 'ltr';
  const statusLabel = (value: string): string => ({ approved: t(state, 'معتمد', 'Approved'), pending: t(state, 'قيد المراجعة', 'Pending'), paused: t(state, 'متوقف مؤقتًا', 'Paused'), rejected: t(state, 'مرفوض', 'Rejected'), disabled: t(state, 'غير متاح', 'Disabled') }[value] ?? value);
  const languages = [...new Set(templates.map((item) => item.language))].sort();
  const categories = [...new Set(templates.map((item) => item.category))].sort();
  const search = h('input', { class: 'input', type: 'search', value: state.dialogForm['whatsappTemplateSearch'] ?? '', placeholder: t(state, 'ابحث بالاسم أو اللغة أو الفئة', 'Search name, language or category'), 'aria-label': t(state, 'بحث القوالب', 'Search templates'), 'data-act': 'form', 'data-form': 'whatsappTemplateSearch' });
  return dialogShell(state, t(state, 'قوالب واتساب', 'WhatsApp Templates'), [
    h('div', { class: 'wa-template-toolbar' }, [
      search,
      selectControl({ act: 'form', form: 'whatsappTemplateLanguage', value: state.dialogForm['whatsappTemplateLanguage'] ?? '', options: [{ value: '', label: t(state, 'كل اللغات', 'All languages') }, ...languages.map((value) => ({ value, label: value }))] }),
      selectControl({ act: 'form', form: 'whatsappTemplateCategory', value: state.dialogForm['whatsappTemplateCategory'] ?? '', options: [{ value: '', label: t(state, 'كل الفئات', 'All categories') }, ...categories.map((value) => ({ value, label: value }))] }),
      selectControl({ act: 'form', form: 'whatsappTemplateStatus', value: state.dialogForm['whatsappTemplateStatus'] ?? 'approved', options: [
        { value: 'approved', label: t(state, 'المعتمد', 'Approved') }, { value: 'pending', label: t(state, 'قيد المراجعة', 'Pending') },
        { value: 'paused', label: t(state, 'متوقف مؤقتًا', 'Paused') }, { value: 'rejected', label: t(state, 'مرفوض', 'Rejected') }, { value: 'disabled', label: t(state, 'غير متاح', 'Disabled') },
      ] }),
      button({ label: t(state, 'بحث', 'Search'), act: 'live-whatsapp-template-search', variant: 'default', small: true }),
      button({ label: t(state, 'تحديث الكتالوج', 'Refresh catalogue'), icon: 'refresh', act: 'live-whatsapp-template-refresh', variant: 'ghost', small: true, busy: state.live.busy === 'whatsapp-template-refresh' }),
    ]),
    state.live.error === null ? null : inlineError(state, state.live.error),
    resource.status === 'loading' || resource.status === 'idle'
      ? h('p', { class: 'field__hint', role: 'status' }, [t(state, 'جارٍ تحميل القوالب المعتمدة…', 'Loading approved templates…')])
      : resource.status === 'error'
        ? notice('warning', 'alert', t(state, 'تعذر تحميل الكتالوج. جرّب التحديث.', 'Could not load the catalogue. Try refreshing.'))
        : null,
    h('div', { class: 'wa-template-layout' }, [
      h('div', { class: 'wa-template-list', role: 'listbox', 'aria-label': t(state, 'القوالب المعتمدة', 'Approved templates') }, [
        ...(templates.length === 0 ? [h('p', { class: 'empty__body' }, [t(state, 'لا توجد قوالب في الكتالوج بعد. حدّثه من Meta.', 'No templates are in the local catalogue yet. Refresh from Meta.')])] : templates.map((template) => h('button', {
            type: 'button', class: `wa-template-option${template.id === selectedId ? ' is-selected' : ''}`, role: 'option', 'aria-selected': String(template.id === selectedId),
            'data-act': 'live-whatsapp-template-select', 'data-arg': template.id,
          }, [
            h('span', { class: 'wa-template-option__title' }, [template.name]),
            h('span', { class: 'wa-template-option__meta' }, [`${template.language} · ${template.category} · ${statusLabel(template.status)}`]),
            h('span', { class: 'wa-template-option__preview', dir: template.language.toLowerCase().startsWith('ar') ? 'rtl' : 'ltr' }, [template.components.find((component) => component.type === 'body')?.text ?? t(state, 'قالب بدون نص', 'Template without text')]),
            template.parameters.length === 0 ? null : h('span', { class: 'wa-template-option__count' }, [t(state, `${template.parameters.length} متغير`, `${template.parameters.length} variables`)]),
          ]))),
        state.live.conversationTemplateCursor === null ? null : button({ label: t(state, 'تحميل المزيد', 'Load more'), act: 'live-whatsapp-template-more', variant: 'ghost', small: true, busy: state.live.busy === 'whatsapp-template-more' }),
      ]),
      h('section', { class: 'wa-template-detail', 'aria-label': t(state, 'معاينة القالب', 'Template preview') }, selected === undefined
        ? [h('p', { class: 'field__hint' }, [t(state, 'اختر قالبًا لمعاينته وإدخال المتغيرات.', 'Select a template to preview it and enter its parameters.')])]
        : [
            h('div', { class: 'wa-template-detail__heading' }, [h('strong', {}, [selected.name]), h('span', { class: `badge ${selected.status === 'approved' ? 'badge--success' : 'badge--neutral'}` }, [statusLabel(selected.status)])]),
            h('div', { class: 'wa-template-preview', dir: direction }, [
              ...selected.components.filter((component) => component.type !== 'buttons').map((component) => component.text === null ? null : h('p', { class: `wa-template-preview__${component.type}` }, templatePreviewChildren(component.text, component.type, parameterValues))),
              ...selected.components.filter((component) => component.type === 'buttons').flatMap((component) => component.buttons.map((buttonInfo) => h('span', { class: 'wa-template-preview__button', 'aria-hidden': 'true' }, [buttonInfo.text]))),
            ]),
            selected.components.some((component) => component.type === 'header' && component.format !== null && component.format !== 'TEXT')
              ? notice('warning', 'alert', t(state, 'رأس الوسائط غير مدعوم حاليًا؛ لن يُرسل القالب.', 'Media header is not supported yet; this template cannot be sent.')) : null,
            selected.sendSupported ? null : h('p', { class: 'field__error', role: 'status' }, [selected.unsupportedReason ?? t(state, 'هذا القالب غير مدعوم للإرسال.', 'This template is not supported for sending.')]),
            ...selected.parameters.map((parameter) => {
              const key = whatsappParameterKey(parameter.key);
              const label = parameter.example ? `${parameter.component === 'body' ? t(state, 'النص', 'Body') : parameter.component} · ${parameter.position} (${parameter.example})` : `${parameter.component === 'button' ? t(state, 'زر', 'Button') : parameter.component === 'header' ? t(state, 'الرأس', 'Header') : t(state, 'النص', 'Body')} · ${t(state, 'متغير', 'Variable')} ${parameter.position}`;
              return h('label', { class: 'field' }, [h('span', { class: 'field__label' }, [label]), h('input', { class: 'input', maxlength: 1024, value: state.dialogForm[key] ?? '', dir: 'auto', required: true, 'data-act': 'form', 'data-form': key, 'data-wa-parameter': parameter.key })]);
            }),
          ]),
    ]),
  ], [
    closeButton(state),
    button({ label: t(state, 'إرسال القالب', 'Send template'), icon: 'send', act: 'live-whatsapp-template-send', variant: 'primary', busy: state.live.busy === 'send-template', disabled: selected === undefined || selected.status !== 'approved' || !selected.sendSupported }),
  ], { size: 'lg', description: t(state, 'يُرسل كقالب Meta معتمد، ولا يتحول إلى رسالة نصية عادية.', 'Sent as an approved Meta template, never converted into ordinary free-form text.') });
}

function whatsappParameterKey(key: string): string { return `whatsappTemplateParameter_${key.replaceAll(':', '_')}`; }
function templatePreviewChildren(text: string, component: string, values: Readonly<Record<string, string>>): Child[] {
  const result: Child[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) {
    const at = match.index!;
    const token = match[0];
    const position = match[1]!;
    if (at > cursor) result.push(text.slice(cursor, at));
    const key = `${component}:${position}`;
    result.push(h('mark', { class: 'wa-template-preview__variable', 'data-template-preview-key': key }, [values[key] || token]));
    cursor = at + token.length;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

function automationDelete(state: AppState, automationId: string): HTMLElement {
  const automation = rowsOf(state.live.automations).find((item) => item.id === automationId);
  const title = t(state, 'حذف مسودة الأتمتة؟', 'Delete automation draft?');
  if (automation === undefined || automation.state !== 'draft') {
    return dialogShell(state, title, [notice('warning', 'alert', t(state, 'لم تعد هذه المسودة متاحة للحذف. حدّث القائمة.', 'This draft is no longer available to delete. Refresh the list.'))], [closeButton(state)]);
  }
  return dialogShell(state, title, [
    h('p', {}, [h('strong', {}, [`“${automation.name}”`]), ' ', t(state, 'لم تُشغّل من قبل. حذف هذه المسودة يزيلها نهائيًا.', 'has never run. Deleting this draft permanently removes it.')]),
    inlineError(state, state.live.error),
  ], [
    closeButton(state),
    button({ label: t(state, 'حذف المسودة', 'Delete Draft'), act: 'live-automation-delete-confirm', arg: automation.id, variant: 'danger', busy: state.live.busy === `automation-delete:${automation.id}` }),
  ]);
}

function workspaceLabel(state: AppState, labelId: string): HTMLElement {
  const label = rowsOf(state.live.workspaceLabels).find((item) => item.id === labelId);
  const editing = label !== undefined;
  const busy = state.live.busy === `metadata:${editing ? 'update-label' : 'create-label'}${editing ? `:${label.id}` : ''}`;
  const selectedColor = labelColor(state.dialogForm['labelColor'] ?? label?.color ?? '#3B82F6');
  return dialogShell(state, editing ? t(state, 'تعديل التصنيف', 'Edit label') : t(state, 'تصنيف جديد', 'New label'), [
    inlineError(state, state.live.error),
    h('form', { class: 'form-grid', 'data-submit': editing ? 'live-workspace-label-update' : 'live-workspace-label-create', novalidate: true }, [
      textInput('labelName', state.dialogForm['labelName'] ?? label?.name ?? '', t(state, 'الاسم', 'Name'), { required: true }),
      labelColorPicker(state, selectedColor),
    ]),
  ], [closeButton(state), button({ label: editing ? t(state, 'حفظ', 'Save') : t(state, 'إنشاء', 'Create'), act: editing ? 'live-workspace-label-update' : 'live-workspace-label-create', variant: 'primary', busy })]);
}

const LABEL_COLORS = ['#3B82F6', '#14B8A6', '#22C55E', '#EAB308', '#F97316', '#EF4444', '#EC4899', '#8B5CF6'] as const;

function labelColorPicker(state: AppState, color: string): HTMLElement {
  return h('div', { class: 'field' }, [
    h('span', { class: 'field__label' }, [t(state, 'اللون', 'Color')]),
    h('div', { class: 'button-row', 'aria-label': t(state, 'ألوان مقترحة', 'Suggested colours') }, LABEL_COLORS.map((value) => h('button', { type: 'button', class: 'btn btn--sm label-color-choice', style: `--label-color:${value};background:${value}`, title: value, 'aria-label': value, 'aria-pressed': String(value === color), 'data-act': 'form-toggle', 'data-arg': `labelColor:${value}` }, []))),
    h('div', { class: 'input-affix' }, [
      h('input', { class: 'input input--color', type: 'color', value: color, 'data-act': 'form-toggle', 'data-form': 'labelColor' }),
      h('input', { class: 'input', value: state.dialogForm['labelColor'] ?? color, pattern: '^#[0-9A-Fa-f]{6}$', maxlength: 7, placeholder: '#3B82F6', 'data-act': 'form-toggle', 'data-form': 'labelColor', 'aria-label': t(state, 'رمز اللون HEX', 'HEX color') }),
    ]),
    h('div', { class: 'metadata__label', style: `--label-color:${color}` }, [h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }), t(state, 'معاينة التصنيف', 'Label preview')]),
    fieldError(state, 'labelColor'),
  ]);
}

function labelColor(value: string): string { return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : '#3B82F6'; }

function retireLabelDialog(state: AppState, labelId: string): HTMLElement {
  const label = rowsOf(state.live.workspaceLabels).find((item) => item.id === labelId);
  const title = t(state, 'إيقاف التصنيف؟', 'Retire label?');
  if (label === undefined || label.state !== 'active') return dialogShell(state, title, [notice('warning', 'alert', t(state, 'لم يعد هذا التصنيف متاحًا للإيقاف. حدّث القائمة.', 'This label is no longer available to retire. Refresh the list.'))], [closeButton(state)]);
  return dialogShell(state, title, [
    h('p', {}, [h('strong', {}, [`“${label.name}”`]), ' ', t(state, 'لن يكون متاحًا لإسنادات جديدة. سيبقى استخدامه التاريخي ظاهرًا.', 'will no longer be available for new assignments. Existing historical usage will remain.')]),
    inlineError(state, state.live.error),
  ], [closeButton(state), button({ label: t(state, 'إيقاف التصنيف', 'Retire label'), act: 'live-workspace-label-retire-confirm', arg: label.id, variant: 'danger', busy: state.live.busy === `metadata:retire-label:${label.id}` })]);
}

function inlineLabel(state: AppState, arg: string): HTMLElement {
  const [target, entityId] = arg.split('|');
  if ((target !== 'contact' && target !== 'conversation') || entityId === undefined) return dialogShell(state, t(state, 'تصنيف جديد', 'New label'), [notice('warning', 'alert', t(state, 'السجل لم يعد متاحًا. أعد فتحه وحاول مرة أخرى.', 'This record is no longer available. Reopen it and try again.'))], [closeButton(state)]);
  const color = labelColor(state.dialogForm['labelColor'] ?? '#3B82F6');
  return dialogShell(state, t(state, 'تصنيف جديد', 'New label'), [
    inlineError(state, state.live.error),
    h('form', { class: 'form-grid', 'data-submit': 'live-inline-label-create', novalidate: true }, [
      textInput('labelName', state.dialogForm['labelName'] ?? '', t(state, 'الاسم', 'Name'), { required: true }),
      labelColorPicker(state, color),
    ]),
  ], [closeButton(state), button({ label: t(state, 'إنشاء وإضافة', 'Create and assign'), act: 'live-inline-label-create', arg, variant: 'primary', busy: state.live.busy === `metadata:${target}:${entityId}` })]);
}

function savedInboxView(state: AppState, mode: string): HTMLElement {
  const editing = mode === 'update';
  const selected = state.live.savedViews.status === 'ready'
    ? state.live.savedViews.value.find((view) => view.id === state.live.selectedSavedViewId)
    : undefined;
  const form = state.dialogForm;
  const visibility = form['savedViewVisibility'] ?? selected?.visibility ?? 'private';
  const teams = rowsOf(state.live.teams).filter((team) => !team.archived);
  const busy = state.live.busy === 'saved-view-create' || state.live.busy === `saved-view-update:${selected?.id ?? ''}`;
  return dialogShell(
    state,
    editing ? t(state, 'تحديث العرض المحفوظ', 'Update saved view') : t(state, 'حفظ عرض', 'Save view'),
    [
      inlineError(state, state.live.error),
      h('form', { class: 'form-grid', 'data-submit': editing ? 'live-inbox-saved-view-update' : 'live-inbox-saved-view-create', novalidate: true }, [
        textInput('savedViewName', form['savedViewName'] ?? selected?.name ?? '', t(state, 'اسم العرض', 'View name'), { required: true }),
        field(t(state, 'الوصول', 'Visibility'), selectControl({ act: 'form', form: 'savedViewVisibility', value: visibility, options: [
          { value: 'private', label: t(state, 'خاص بي', 'Private') },
          { value: 'team', label: t(state, 'الفريق', 'Team') },
          { value: 'workspace', label: t(state, 'مساحة العمل', 'Workspace') },
        ] })),
        visibility === 'team'
          ? field(t(state, 'الفريق', 'Team'), selectControl({ act: 'form', form: 'savedViewTeamId', value: form['savedViewTeamId'] ?? selected?.teamId ?? '', options: [
            { value: '', label: t(state, 'اختر فريقًا', 'Choose a team') },
            ...teams.map((team) => ({ value: team.id, label: team.name })),
          ] }))
          : null,
        h('p', { class: 'field__hint' }, [t(state, 'سيُحفظ الفلتر الحالي فقط. الأرشيف خارج الـInbox التشغيلي.', 'Only the current filters are saved. Archived conversations stay outside the operational Inbox.')]),
      ]),
    ],
    [
      closeButton(state),
      button({ label: editing ? t(state, 'تحديث', 'Update') : t(state, 'حفظ', 'Save'), act: editing ? 'live-inbox-saved-view-update' : 'live-inbox-saved-view-create', variant: 'primary', busy, disabled: editing && selected === undefined }),
    ],
  );
}

function changePasswordDialog(state: AppState): HTMLElement {
  const busy = state.live.busy === 'change-password';
  return dialogShell(
    state,
    t(state, 'تغيير كلمة المرور', 'Change password'),
    [
      inlineError(state, state.live.error),
      h('form', { class: 'form-grid', 'data-submit': 'live-change-password', novalidate: true }, [
        passwordInput(state, 'currentPassword', t(state, 'كلمة المرور الحالية', 'Current password'), 'current-password'),
        passwordInput(state, 'newPassword', t(state, 'كلمة المرور الجديدة', 'New password'), 'new-password'),
        passwordInput(state, 'confirmPassword', t(state, 'تأكيد كلمة المرور الجديدة', 'Confirm new password'), 'new-password'),
        h('p', { class: 'field__hint' }, [t(state, 'استخدم 12 حرفًا على الأقل. ستُنهى كل الجلسات الأخرى.', 'Use at least 12 characters. Every other session will be signed out.')]),
      ]),
    ],
    [
      closeButton(state),
      button({ label: busy ? t(state, 'جارٍ التحديث…', 'Updating…') : t(state, 'تحديث كلمة المرور', 'Update password'), act: 'live-change-password', variant: 'primary', busy }),
    ],
    { description: t(state, 'تبقى هذه الجلسة مفتوحة بعد نجاح التغيير.', 'This session stays signed in after a successful change.') },
  );
}

function passwordInput(state: AppState, key: string, label: string, autocomplete: string): HTMLElement {
  const error = state.formErrors[key];
  return h('div', { class: 'field' }, [
    h('label', { class: 'field__label', for: key }, [label]),
    h('div', { class: 'input-affix' }, [
      h('input', {
        id: key,
        class: error === undefined ? 'input' : 'input input--invalid',
        type: state.passwordVisible ? 'text' : 'password',
        autocomplete,
        dir: 'ltr',
        required: true,
        value: state.dialogForm[key] ?? '',
        'data-act': 'form',
        'data-form': key,
      }),
      button({
        icon: state.passwordVisible ? 'eyeOff' : 'eye',
        act: 'password-visibility',
        variant: 'ghost',
        small: true,
        pressed: state.passwordVisible,
        title: state.passwordVisible ? t(state, 'إخفاء كلمات المرور', 'Hide passwords') : t(state, 'إظهار كلمات المرور', 'Show passwords'),
        extraClass: 'input-affix__button',
      }),
    ]),
    fieldError(state, key),
  ]);
}

/* --------------------------------------------------------------- channels -- */

/**
 * Connects one provider asset, using the fields the API actually takes.
 *
 * A Meta channel names a Meta app that must already be configured on the server
 * — the browser never sees or sends an app secret. The token is write-only: it
 * goes out once in this request, is stored encrypted, and never comes back.
 */
function connectChannel(state: AppState, kind: string): HTMLElement {
  const item = catalogueItem(kind);
  const live = state.live;
  const form = state.dialogForm;
  if (item === undefined || item.kind === 'telegram') {
    return dialogShell(
      state,
      t(state, 'القناة غير متاحة', 'Channel not available'),
      [notice('info', 'info', t(state, 'هذه القناة غير مدعومة في هذا الإصدار.', 'This channel is not supported in this version.'))],
      [closeButton(state)],
    );
  }
  const name = t(state, item.name.ar, item.name.en);
  const busy = live.busy === 'connect-channel';
  return dialogShell(
    state,
    t(state, `ربط ${name}`, `Connect ${name}`),
    [
      h('div', { class: 'dialog__lead' }, [
        channelTile(item.kind, 'lg'),
        h('p', {}, [
          item.meta
            ? t(state, 'أدخل بيانات الأصل من Meta Business. تبدأ القناة بحالة «بانتظار التحقق» حتى يقبل المزوّد بيانات الاعتماد.', 'Enter the asset details from Meta Business. The channel starts as “Verification needed” until the provider accepts the credential.')
            : t(state, 'سيوقّع خادمك التسليمات بهذا المفتاح. احتفظ به في نظامك المرسل فقط.', 'Your installation signs deliveries with this key. Keep it only in the sending system.'),
        ]),
      ]),
      inlineError(state, live.error),
      h('form', { class: 'form-grid', 'data-submit': 'live-connect-channel', novalidate: true }, [
        item.meta
          ? h('div', { class: 'field' }, [
              h('label', { class: 'field__label', for: 'channel-app' }, [t(state, 'معرّف تطبيق Meta', 'Meta App ID')]),
              textInput('channelProviderApp', form['channelProviderApp'] ?? '', '123456789012345', { id: 'channel-app', inputmode: 'numeric', required: true }),
              h('p', { class: 'field__hint' }, [t(state, 'تطبيق مسجّل مسبقًا على الخادم.', 'An app already registered on the server.')]),
              fieldError(state, 'channelProviderApp'),
            ])
          : null,
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'channel-asset' }, [t(state, item.asset.ar, item.asset.en)]),
          textInput('channelAsset', form['channelAsset'] ?? '', '', { id: 'channel-asset', required: true }),
          fieldError(state, 'channelAsset'),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'channel-name' }, [t(state, 'اسم العرض', 'Display name')]),
          textInput('channelName', form['channelName'] ?? '', t(state, 'مثال: خط التسجيل', 'e.g. Admissions line'), { id: 'channel-name', required: true }),
          fieldError(state, 'channelName'),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'channel-token' }, [
            item.meta ? t(state, 'رمز الوصول', 'Access token') : t(state, 'مفتاح التوقيع', 'Signing key'),
          ]),
          h('input', {
            id: 'channel-token',
            class: 'input',
            type: 'password',
            autocomplete: 'off',
            dir: 'ltr',
            required: true,
            value: form['channelToken'] ?? '',
            'data-act': 'form',
            'data-form': 'channelToken',
          }),
          h('p', { class: 'field__hint' }, [t(state, 'يُحفظ مشفّرًا ولا يُعرض مرة أخرى.', 'Stored encrypted and never shown again.')]),
          fieldError(state, 'channelToken'),
        ]),
      ]),
    ],
    [
      closeButton(state),
      button({
        label: busy ? t(state, 'جارٍ الربط…', 'Connecting…') : t(state, 'ربط القناة', 'Connect channel'),
        act: 'live-connect-channel',
        variant: 'primary',
        busy,
      }),
    ],
  );
}

/** Disconnecting is confirmed, and says what it costs. */
function disconnectChannel(state: AppState, connectionId: string): HTMLElement {
  const live = state.live;
  const connection = rowsOf(live.connections).find((entry) => entry.id === connectionId);
  const title = t(state, 'فصل القناة', 'Disconnect channel');
  if (connection === undefined || connection.disconnected_at !== null) {
    return dialogShell(state, title, [notice('warning', 'alert', t(state, 'هذا الاتصال لم يعد نشطًا. حدّث القائمة.', 'This connection is no longer active. Refresh the list.'))], [closeButton(state)]);
  }
  return dialogShell(
    state,
    title,
    [
      notice('warning', 'alert', h('span', {}, [
        t(state, 'سيُفصل ', 'Disconnecting '),
        h('bdi', {}, [connection.display_name]),
        t(
          state,
          ' وتُلغى بيانات اعتماده المحفوظة. يبقى سجل المحادثات، وتحتاج إلى رمز جديد لإعادة الربط.',
          ' revokes its stored credential. Conversation history is kept; reconnecting needs a new token.',
        ),
      ])),
      inlineError(state, live.error),
    ],
    [
      closeButton(state),
      button({
        label: t(state, 'فصل القناة', 'Disconnect'),
        act: 'live-disconnect-channel',
        arg: connection.id,
        variant: 'danger',
        busy: live.busy === `disconnect-channel:${connection.id}`,
      }),
    ],
  );
}

/* ----------------------------------------------------------------- people -- */

function invite(state: AppState): HTMLElement {
  const live = state.live;
  const roles = rowsOf(live.roles);
  const busy = live.busy === 'invite';
  return dialogShell(
    state,
    t(state, 'دعوة عضو', 'Invite a member'),
    [
      inlineError(state, live.error),
      h('form', { class: 'form-grid', 'data-submit': 'live-invite', novalidate: true }, [
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'invite-email' }, [t(state, 'البريد الإلكتروني', 'Email')]),
          textInput('inviteEmail', state.dialogForm['inviteEmail'] ?? '', 'name@company.com', { id: 'invite-email', type: 'email', autocomplete: 'off', required: true }),
          fieldError(state, 'inviteEmail'),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'invite-role' }, [t(state, 'الدور', 'Role')]),
          selectControl({
            id: 'invite-role',
            value: state.dialogForm['inviteRole'] ?? '',
            form: 'inviteRole',
            options: [{ value: '', label: t(state, 'اختر دورًا', 'Choose a role') }, ...roles.map((role) => ({ value: role.id, label: role.name }))],
          }),
          fieldError(state, 'inviteRole'),
        ]),
      ]),
      notice('plain', 'shield', t(state, 'الدعوة رابط يُستخدم مرة واحدة. لا توجد كلمة مرور افتراضية.', 'The invitation is a single-use link. No default password is created.')),
    ],
    [
      closeButton(state),
      button({ label: t(state, 'إنشاء الدعوة', 'Create invitation'), act: 'live-invite', variant: 'primary', busy }),
    ],
  );
}

/**
 * Offering ownership is confirmed first, and said plainly: it hands the company
 * to somebody else once they accept, and only they can complete it.
 */
function ownershipOffer(state: AppState, membershipId: string): HTMLElement {
  const live = state.live;
  const person = rowsOf(live.people).find((entry) => entry.membership_id === membershipId);
  const title = t(state, 'نقل ملكية مساحة العمل', 'Transfer workspace ownership');
  if (person === undefined) {
    return dialogShell(state, title, [notice('warning', 'alert', t(state, 'لم يعد هذا العضو موجودًا. حدّث القائمة.', 'This member no longer exists. Refresh the list.'))], [closeButton(state)]);
  }
  return dialogShell(
    state,
    title,
    [
      notice('warning', 'shield', h('span', {}, [
        t(state, 'سيُرسل عرض ملكية إلى ', 'An ownership offer will be sent to '),
        h('bdi', {}, [person.email]),
        t(state, '. عند قبوله يصبح المالك، ولا يمكنك التراجع إلا بإلغاء العرض قبل القبول.', '. Once they accept they become the Owner; you can only undo it by cancelling before they accept.'),
      ])),
      inlineError(state, live.error),
    ],
    [
      closeButton(state),
      button({
        label: t(state, 'إرسال العرض', 'Send offer'),
        act: 'live-offer-ownership',
        arg: person.membership_id,
        variant: 'danger',
        busy: live.busy === 'offer-ownership',
      }),
    ],
  );
}

/* -------------------------------------------------------------- campaigns -- */

function missingCampaign(state: AppState, title: string): HTMLElement {
  return dialogShell(
    state,
    title,
    [notice('warning', 'alert', t(state, 'لم تعد الحملة موجودة. حدّث القائمة.', 'The campaign no longer exists. Refresh the list.'))],
    [closeButton(state)],
  );
}

function campaignTestSend(state: AppState, campaignId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'إرسال تجريبي', 'Send a test');
  const campaign = rowsOf(live.campaigns).find((entry) => entry.id === campaignId);
  if (campaign === undefined) return missingCampaign(state, title);
  const recipients = rowsOf(live.testRecipients).filter((entry) => entry.connection_id === campaign.connection_id);
  const selected = state.dialogForm['campaignTestRecipient'] ?? recipients[0]?.id ?? '';
  const status: Child = live.testRecipients.status === 'loading' || live.testRecipients.status === 'idle'
    ? notice('plain', 'clock', t(state, 'جارٍ تحميل المستلمين المصرّح لهم…', 'Loading authorized recipients…'))
    : live.testRecipients.status === 'error'
      ? inlineError(state, live.testRecipients.error)
      : recipients.length === 0
        ? notice('warning', 'shield', t(state, 'لا يوجد مستلم تجريبي مصرّح له على هذه القناة. أضفه من شاشة القنوات.', 'No test recipient is authorized on this channel. Add one from Channels.'))
        : null;
  return dialogShell(
    state,
    title,
    [
      h('p', { class: 'dialog__subject' }, [campaign.name]),
      status,
      recipients.length === 0
        ? null
        : field(
            t(state, 'المستلم التجريبي', 'Test recipient'),
            selectControl({
              value: selected,
              form: 'campaignTestRecipient',
              options: recipients.map((recipient) => ({ value: recipient.id, label: `${recipient.label} · ${recipient.peer_identity}` })),
            }),
            t(state, 'تُرسل النسخة الحالية إلى هذا المستلم فقط، عبر فحوص القناة نفسها.', 'The current revision goes to this recipient only, through the same channel checks.'),
          ),
      inlineError(state, live.error),
    ],
    [
      closeButton(state),
      button({
        label: t(state, 'إرسال الاختبار', 'Send test'),
        icon: 'send',
        act: 'live-campaign-test-send',
        arg: campaign.id,
        variant: 'primary',
        busy: live.busy === `campaign-test-send:${campaign.id}`,
        disabled: recipients.length === 0 || selected === '',
      }),
    ],
  );
}

function campaignSchedule(state: AppState, campaignId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'جدولة الإطلاق', 'Schedule launch');
  const campaign = rowsOf(live.campaigns).find((entry) => entry.id === campaignId);
  if (campaign === undefined) return missingCampaign(state, title);
  return dialogShell(
    state,
    title,
    [
      h('p', { class: 'dialog__subject' }, [campaign.name]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'campaign-schedule' }, [t(state, 'وقت الإطلاق', 'Launch time')]),
        h('input', {
          id: 'campaign-schedule',
          class: 'input',
          type: 'datetime-local',
          value: state.dialogForm['campaignScheduleAt'] ?? '',
          'data-act': 'form',
          'data-form': 'campaignScheduleAt',
        }),
        h('p', { class: 'field__hint' }, [
          t(state, `بتوقيت جهازك. يجب أن يكون وقتًا مستقبليًا.`, `In your device’s time zone. It must be in the future.`),
        ]),
        fieldError(state, 'campaignScheduleAt'),
      ]),
      inlineError(state, live.error),
    ],
    [
      closeButton(state),
      button({
        label: t(state, 'جدولة', 'Schedule'),
        icon: 'calendar',
        act: 'live-campaign-schedule',
        arg: campaign.id,
        variant: 'primary',
        busy: live.busy === `campaign-launch:${campaign.id}`,
      }),
    ],
  );
}

function campaignEditor(state: AppState, kind: string, campaignId: string): HTMLElement {
  const live = state.live;
  const campaign = kind === 'campaign-edit' ? rowsOf(live.campaigns).find((entry) => entry.id === campaignId) : undefined;
  if (kind === 'campaign-edit' && campaign === undefined) {
    return missingCampaign(state, t(state, 'تعديل الحملة', 'Edit campaign'));
  }
  const connections = rowsOf(live.connections).filter(
    (connection) => connection.status === 'healthy' || connection.id === campaign?.connection_id,
  );
  const form = state.dialogForm;
  const initialMessage = typeof campaign?.content['text'] === 'string' ? campaign.content['text'] : '';
  const initialSearch = typeof campaign?.audience_filter['search'] === 'string' ? campaign.audience_filter['search'] : '';
  const busy = live.busy === 'campaign-create' || (campaign !== undefined && live.busy === `campaign-update:${campaign.id}`);
  return dialogShell(
    state,
    campaign === undefined ? t(state, 'حملة جديدة', 'New campaign') : t(state, 'تعديل الحملة', 'Edit campaign'),
    [
      connections.length === 0
        ? notice('warning', 'plug', t(state, 'اربط قناة سليمة أولًا لإنشاء حملة.', 'Connect a healthy channel before creating a campaign.'))
        : null,
      inlineError(state, live.error),
      h('form', { class: 'form-grid', 'data-submit': campaign === undefined ? 'live-campaign-create' : 'live-campaign-update', 'data-arg': campaign?.id, novalidate: true }, [
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'campaign-name' }, [t(state, 'اسم الحملة', 'Campaign name')]),
          textInput('campaignName', form['campaignName'] ?? campaign?.name ?? '', t(state, 'مثال: تذكير المحاضرة المباشرة', 'e.g. Live session reminder'), { id: 'campaign-name', required: true }),
          fieldError(state, 'campaignName'),
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', for: 'campaign-channel' }, [t(state, 'القناة', 'Channel')]),
          selectControl({
            id: 'campaign-channel',
            value: form['campaignConnection'] ?? campaign?.connection_id ?? connections[0]?.id ?? '',
            form: 'campaignConnection',
            options: connections.map((connection) => ({ value: connection.id, label: connection.display_name })),
          }),
        ]),
        h('div', { class: 'field field--wide' }, [
          h('label', { class: 'field__label', for: 'campaign-objective' }, [t(state, 'الهدف (اختياري)', 'Objective (optional)')]),
          textInput('campaignObjective', form['campaignObjective'] ?? campaign?.objective ?? '', t(state, 'مثال: تأكيد التسجيل', 'e.g. Confirm enrolment'), { id: 'campaign-objective' }),
        ]),
        h('div', { class: 'field field--wide' }, [
          h('label', { class: 'field__label', for: 'campaign-message' }, [t(state, 'نص الرسالة', 'Message')]),
          h('textarea', {
            id: 'campaign-message',
            class: 'input textarea',
            rows: '4',
            dir: 'auto',
            'data-act': 'form',
            'data-form': 'campaignMessage',
            placeholder: t(state, 'مرحبًا {{display_name}}، …', 'Hello {{display_name}}, …'),
          }, [form['campaignMessage'] ?? initialMessage]),
          h('p', { class: 'field__hint' }, [t(state, 'استخدم {{display_name}} لإدراج اسم العميل كما هو محفوظ عند تثبيت الجمهور.', 'Use {{display_name}} to insert the name frozen with the audience.')]),
          fieldError(state, 'campaignMessage'),
        ]),
        h('div', { class: 'field field--wide' }, [
          h('label', { class: 'field__label', for: 'campaign-search' }, [t(state, 'تصفية الجمهور بالاسم (اختياري)', 'Audience name filter (optional)')]),
          textInput('campaignSearch', form['campaignSearch'] ?? initialSearch, t(state, 'اتركه فارغًا لكل جهات الاتصال المؤهلة', 'Leave empty for every eligible contact'), { id: 'campaign-search' }),
        ]),
      ]),
      notice('info', 'shield', campaign === undefined
        ? t(state, 'بعد الإنشاء: ثبّت الجمهور، اعتمد النسخة، ثم أطلقها.', 'After creating: freeze the audience, approve the revision, then launch.')
        : t(state, 'تغيير الرسالة أو الجمهور ينشئ نسخة جديدة تحتاج تثبيتًا واعتمادًا من جديد.', 'Changing the message or audience creates a new revision that needs freezing and approval again.')),
    ],
    [
      closeButton(state),
      button({
        label: campaign === undefined ? t(state, 'إنشاء المسودة', 'Create draft') : t(state, 'حفظ التغييرات', 'Save changes'),
        act: campaign === undefined ? 'live-campaign-create' : 'live-campaign-update',
        arg: campaign?.id,
        variant: 'primary',
        busy,
        disabled: connections.length === 0,
      }),
    ],
    { size: 'lg' },
  );
}
