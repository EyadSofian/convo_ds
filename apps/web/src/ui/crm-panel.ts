import { h } from '../dom.js';
import { dateFormat } from '../format.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { badge, button, dialogShell, errorState, field, inlineError, panel, skeleton, textInput } from './parts.js';

export function crmPanel(state: AppState): HTMLElement {
  const resource = state.live.crmSettings;
  const settings = resource.status === 'ready' ? resource.value : null;
  return panel(t(state, 'ربط واتساب بالـ CRM', 'WhatsApp CRM connection'), [
    h('div', { class: 'button-row' }, [
      h('a', { class: 'link', href: '/integrations/crm-whatsapp.md', download: 'Omni-WhatsApp-CRM-Guide.md' }, [t(state, 'دليل الربط', 'Integration guide')]),
      h('a', { class: 'link', href: '/integrations/crm-whatsapp.openapi.json', download: 'Omni-WhatsApp-CRM.openapi.json' }, ['OpenAPI']),
    ]),
    resource.status === 'error'
      ? errorState(state, resource.error, 'live-crm-reload')
      : settings === null ? skeleton(state, 2) : h('div', { class: 'stack stack--sm' }, [
        h('p', {}, [t(state, 'معرّف مساحة العمل', 'Workspace ID'), ' ', h('code', {}, [settings.tenantId])]),
        h('p', {}, [t(state, 'عنوان الربط بعد مسار الموقع', 'API path on this site'), ' ', h('code', {}, [`/api/v1/tenants/${settings.tenantId}/crm/whatsapp`])]),
        h('ul', { class: 'session-list' }, settings.senders.map((sender) => h('li', { class: 'session' }, [
          h('div', { class: 'session__text' }, [
            h('p', { class: 'session__title' }, [sender.displayName, ' ', badge(sender.sendReady ? t(state, 'جاهز', 'Ready') : t(state, 'يحتاج تحقق', 'Needs verification'), sender.sendReady ? 'success' : 'warning')]),
            h('p', { class: 'session__meta' }, [sender.displayPhoneNumber ?? sender.phoneNumberId, ' · ', h('code', {}, [sender.id])]),
          ]),
        ]))),
        settings.keys.length === 0
          ? h('p', { class: 'muted' }, [t(state, 'لا توجد مفاتيح ربط نشطة.', 'There are no active integration keys.')])
          : h('ul', { class: 'session-list' }, settings.keys.map((key) => h('li', { class: 'session' }, [
            h('div', { class: 'session__text' }, [
              h('p', { class: 'session__title' }, [key.label]),
              h('p', { class: 'session__meta' }, [
                key.expires_at === null
                  ? t(state, 'بدون تاريخ انتهاء', 'No expiration')
                  : t(state, 'ينتهي في ', 'Expires ') + dateFormat(state.lang, { dateStyle: 'medium' }).format(new Date(key.expires_at)),
                ' · ', settings.senders.filter((sender) => key.connection_ids.includes(sender.id)).map((sender) => sender.displayName).join(', '),
              ]),
            ]),
            button({ label: t(state, 'إلغاء المفتاح', 'Revoke key'), act: 'dialog', arg: `crm-revoke:${key.id}`, variant: 'danger', small: true }),
          ]))),
      ]),
  ], {
    description: t(state, 'اسمح لخادم الـ CRM بالإرسال من أرقام واتساب تختارها ومتابعة حالة الرسائل.', 'Let your CRM server send from selected WhatsApp numbers and track message status.'),
    actions: [button({
      label: t(state, 'إنشاء مفتاح', 'Create key'), icon: 'key', act: 'dialog', arg: 'crm-key', small: true,
      disabled: settings === null || settings.senders.length === 0,
    })],
  });
}

export function crmDialog(state: AppState, kind: string, id: string): HTMLElement {
  const close = button({ label: t(state, 'إغلاق', 'Close'), act: 'close-dialog', variant: 'ghost' });
  const token = state.dialogForm['crmToken'];
  if (token !== undefined) {
    return dialogShell(state, t(state, 'مفتاح الربط', 'Integration key'), [
      h('p', {}, [t(state, 'انسخ المفتاح الآن واحفظه في خادم الـ CRM. يظهر مرة واحدة فقط.', 'Copy this key now and store it on your CRM server. It is shown only once.')]),
      h('input', { class: 'input', readonly: true, dir: 'ltr', value: token, 'aria-label': t(state, 'مفتاح الربط', 'Integration key') }),
    ], [close]);
  }
  if (kind === 'crm-revoke') {
    const key = state.live.crmSettings.status === 'ready' ? state.live.crmSettings.value.keys.find((item) => item.id === id) : undefined;
    return dialogShell(state, t(state, 'إلغاء مفتاح الربط', 'Revoke integration key'), [
      h('p', {}, [key?.label ?? id]),
      h('p', {}, [t(state, 'يتوقف هذا المفتاح عن قبول الطلبات فورًا.', 'This key will stop accepting requests immediately.')]),
      inlineError(state, state.live.error),
    ], [close, button({
      label: t(state, 'إلغاء المفتاح', 'Revoke key'), act: 'live-crm-revoke-key', arg: id,
      variant: 'danger', busy: state.live.busy === 'crm-revoke', disabled: key === undefined,
    })]);
  }
  const senders = state.live.crmSettings.status === 'ready' ? state.live.crmSettings.value.senders : [];
  const label = state.dialogForm['crmLabel'] ?? '';
  return dialogShell(state, t(state, 'إنشاء مفتاح ربط', 'Create integration key'), [
    field(t(state, 'اسم المفتاح', 'Key name'), textInput('crmLabel', label, 'CRM production', { act: 'form-toggle' })),
    h('fieldset', { class: 'stack stack--sm' }, [
      h('legend', {}, [t(state, 'أرقام الإرسال المسموح بها', 'Allowed WhatsApp senders')]),
      ...senders.map((sender) => h('label', { class: 'permission-row' }, [
        h('input', { type: 'checkbox', value: sender.id, checked: state.dialogForm[`crmSender_${sender.id}`] === 'yes', 'data-act': 'live-crm-sender' }),
        h('span', {}, [sender.displayName, ' · ', sender.displayPhoneNumber ?? sender.phoneNumberId]),
      ])),
    ]),
    h('p', { class: 'muted' }, [t(state, 'المفتاح بدون تاريخ انتهاء. يمكنك إلغاؤه في أي وقت.', 'The key has no expiration date. You can revoke it anytime.')]),
    inlineError(state, state.live.error),
  ], [close, button({
    label: t(state, 'إنشاء المفتاح', 'Create key'), act: 'live-crm-create-key', variant: 'primary',
    busy: state.live.busy === 'crm-create',
    disabled: label.trim() === '' || label.trim().length > 80 || !senders.some((sender) => state.dialogForm[`crmSender_${sender.id}`] === 'yes'),
  })]);
}
