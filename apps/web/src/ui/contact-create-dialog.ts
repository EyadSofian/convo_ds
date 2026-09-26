import type { CustomField } from '../api/metadata.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { hasPermission } from '../live/ability.js';
import { idList, toggled } from '../live/audience.js';
import { channelIdHint, customFieldKey, STANDARD_CONTACT_FIELDS, standardFieldKey } from '../live/contact-profile.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { icon } from '../icons.js';
import { channelMark } from './channel-mark.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import { button, dialogShell, inlineError, isolated, sectionTitle, selectControl, textInput } from './parts.js';

/**
 * Adding a customer by hand.
 *
 * Laid out the way support tools present a new customer card: who they are
 * and where they are reached first — an explicit channel identity is the one
 * required part — then the details a team keeps on a customer, their labels,
 * and any consent the operator can vouch for. Consent is never implied by
 * creating a contact; ticking it records the operator's own statement.
 */
export function contactCreateDialog(state: AppState): HTMLElement {
  const live = state.live;
  const form = state.dialogForm;
  const connections = rowsOf(live.connections).filter((connection) => connection.disconnected_at === null);
  const connectionId = form['contactCreateConnection'] ?? '';
  const kind = connections.find((connection) => connection.id === connectionId)?.kind;
  const busy = live.busy === 'contact:create';
  return dialogShell(
    state,
    t(state, 'جهة اتصال جديدة', 'New contact'),
    [
      inlineError(state, live.error),
      h('form', { class: 'contact-new', 'data-submit': 'live-contact-create', novalidate: true }, [
        h('section', { class: 'contact-new__section contact-new__who', 'aria-labelledby': 'contact-new-who' }, [
          sectionTitle('user', 'blue', t(state, 'العميل وطريقة الوصول إليه', 'Who and where'), 'contact-new-who'),
          h('div', { class: 'contact-new__grid' }, [
            input(state, 'contactCreateName', t(state, 'الاسم الكامل', 'Full name'), t(state, 'مثال: منى خليل', 'e.g. Mona Khalil'), { required: true, wide: true }),
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', for: 'contact-new-channel' }, [t(state, 'القناة', 'Channel'), requiredMark()]),
              connections.length === 0
                ? live.connections.status === 'ready'
                  ? h('p', { class: 'contact-new__empty', role: 'status' }, [t(state, 'لا توجد قناة متصلة. اربط قناة أولًا.', 'No connected channel. Connect one first.')])
                  : h('p', { class: 'contact-new__empty', role: 'status' }, [live.connections.status === 'error'
                      ? live.connections.error.message
                      : t(state, 'جارٍ تحميل القنوات…', 'Loading channels…')])
                : selectControl({
                    id: 'contact-new-channel',
                    form: 'contactCreateConnection',
                    value: connectionId,
                    options: [
                      { value: '', label: t(state, 'اختر قناة متصلة', 'Choose a connected channel') },
                      ...connections.map((connection) => ({ value: connection.id, label: `${phrase(state, CHANNEL_NAMES, connection.kind)} · ${connection.display_name}` })),
                    ],
                  }),
              fieldError(state, 'contactCreateConnection'),
            ]),
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', for: 'contact-new-external' }, [
                kind === undefined ? null : h('span', { class: `contact-new__mark channel-tile--${kind}`, 'aria-hidden': 'true' }, [channelMark(kind, 12)]),
                t(state, 'معرّف العميل على القناة', 'Customer channel ID'),
                requiredMark(),
              ]),
              h('input', { id: 'contact-new-external', class: 'input', type: 'text', dir: 'ltr', value: form['contactCreateExternalId'] ?? '', placeholder: kind === 'whatsapp' ? '201001234567' : '', 'data-act': 'form', 'data-form': 'contactCreateExternalId' }),
              h('p', { class: 'field__hint' }, [channelIdHint(kind, state.lang)]),
              fieldError(state, 'contactCreateExternalId'),
            ]),
          ]),
        ]),
        profileSection(state),
        labelsSection(state),
        hasPermission(live, 'consent.record') ? consentSection(state) : null,
      ]),
    ],
    [
      button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' }),
      button({ label: t(state, 'إضافة جهة الاتصال', 'Add contact'), icon: 'userPlus', act: 'live-contact-create', variant: 'primary', busy, disabled: connections.length === 0 }),
    ],
    { size: 'lg', description: t(state, 'الإضافة لا تسجّل أي موافقة إلا ما تختاره صراحةً بالأسفل.', 'Adding a contact records no consent beyond what you tick below.') },
  );
}

function requiredMark(): HTMLElement {
  return h('span', { class: 'contact-new__required', 'aria-hidden': 'true' }, ['*']);
}

function fieldError(state: AppState, key: string): HTMLElement | null {
  const message = state.formErrors[key];
  return message === undefined ? null : h('p', { class: 'field__error', role: 'alert' }, [message]);
}

function input(
  state: AppState,
  key: string,
  label: string,
  placeholder: string,
  options: { readonly required?: boolean; readonly wide?: boolean; readonly type?: string | undefined; readonly ltr?: boolean } = {},
): HTMLElement {
  const control = textInput(key, state.dialogForm[key] ?? '', placeholder, { id: `field-${key}` });
  if (options.type !== undefined) control.type = options.type;
  if (options.ltr === true) control.dir = 'ltr';
  return h('div', { class: `field${options.wide === true ? ' field--wide' : ''}` }, [
    h('label', { class: 'field__label', for: `field-${key}` }, [label, options.required === true ? requiredMark() : null]),
    control,
    fieldError(state, key),
  ]);
}

const INPUT_TYPE: Readonly<Record<string, string>> = { email: 'email', phone: 'tel', number: 'number', date: 'date' };

/**
 * The details a team keeps on a customer. Standard ones show whether or not
 * the catalogue has them yet when the operator may add them to it; other
 * contact fields the company defined follow, in their own types.
 */
function profileSection(state: AppState): HTMLElement | null {
  const live = state.live;
  const catalogue = rowsOf(live.customFields).filter((field) => field.target === 'contact' && field.state === 'active');
  const mayManage = hasPermission(live, 'catalog.manage');
  const standard = STANDARD_CONTACT_FIELDS.filter((entry) => mayManage || catalogue.some((field) => field.key === entry.key));
  const others = catalogue.filter((field) => !STANDARD_CONTACT_FIELDS.some((entry) => entry.key === field.key));
  if (standard.length === 0 && others.length === 0) return null;
  return h('section', { class: 'contact-new__section', 'aria-labelledby': 'contact-new-profile' }, [
    sectionTitle('contacts', 'violet', t(state, 'بيانات العميل', 'Profile details'), 'contact-new-profile'),
    h('div', { class: 'contact-new__grid' }, [
      ...standard.map((entry) => {
        const existing = catalogue.find((field) => field.key === entry.key);
        const type = existing?.type ?? entry.type;
        return input(state, standardFieldKey(entry.key), t(state, entry.ar, entry.en), entry.placeholder, {
          wide: entry.wide === true,
          type: INPUT_TYPE[type],
          ltr: type === 'email' || type === 'phone',
        });
      }),
      ...others.map((field) => customInput(state, field)),
    ]),
  ]);
}

function customInput(state: AppState, field: CustomField): HTMLElement {
  const key = customFieldKey(field.id);
  const value = state.dialogForm[key] ?? '';
  if (field.type === 'boolean' || field.type === 'single_select') {
    const options = field.type === 'boolean'
      ? [{ value: 'true', label: t(state, 'نعم', 'Yes') }, { value: 'false', label: t(state, 'لا', 'No') }]
      : field.options.map((option) => ({ value: option, label: option }));
    return h('div', { class: 'field' }, [
      h('label', { class: 'field__label', for: `field-${key}` }, [field.name]),
      selectControl({ id: `field-${key}`, form: key, value, options: [{ value: '', label: t(state, 'غير محدد', 'Not set') }, ...options] }),
    ]);
  }
  return input(state, key, field.name, field.type === 'multi_select' ? t(state, 'قيم مفصولة بفاصلة', 'Comma-separated values') : '', {
    type: INPUT_TYPE[field.type],
    ltr: field.type === 'email' || field.type === 'phone',
  });
}

function labelsSection(state: AppState): HTMLElement | null {
  const labels = rowsOf(state.live.labels).filter((label) => label.state === 'active');
  if (labels.length === 0) return null;
  const chosen = idList(state.dialogForm['newContactLabels'] ?? '');
  return h('section', { class: 'contact-new__section', 'aria-labelledby': 'contact-new-labels' }, [
    sectionTitle('tag', 'amber', t(state, 'التصنيفات', 'Labels'), 'contact-new-labels'),
    h('div', { class: 'audience__chips' }, labels.map((label) => h('button', {
      type: 'button',
      class: 'audience-chip',
      style: `--label-color:${label.color}`,
      'aria-pressed': String(chosen.includes(label.id)),
      'data-act': 'form-toggle',
      'data-arg': `newContactLabels:${toggled(chosen, label.id)}`,
    }, [
      h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }),
      isolated(label.name),
      chosen.includes(label.id) ? icon('check', 14) : null,
    ]))),
  ]);
}

function consentSection(state: AppState): HTMLElement {
  const option = (key: string, title: string, body: string): Child => {
    const on = state.dialogForm[key] === 'true';
    return h('button', {
      type: 'button',
      class: 'contact-new__consent',
      role: 'checkbox',
      'aria-checked': String(on),
      'data-act': 'form-toggle',
      'data-arg': `${key}:${on ? '' : 'true'}`,
    }, [
      h('span', { class: 'contact-new__check', 'aria-hidden': 'true' }, [on ? icon('check', 14) : null]),
      h('span', { class: 'contact-new__consent-text' }, [h('strong', {}, [title]), h('span', {}, [body])]),
    ]);
  };
  return h('section', { class: 'contact-new__section', 'aria-labelledby': 'contact-new-consent' }, [
    sectionTitle('shield', 'green', t(state, 'الموافقة', 'Consent'), 'contact-new-consent'),
    h('div', { class: 'contact-new__consents' }, [
      option('newContactMarketing',
        t(state, 'وافق على الرسائل التسويقية', 'Agreed to marketing messages'),
        t(state, 'لديك دليل على موافقته. بدونها لا تصله الحملات.', 'You hold evidence of it. Without it, no campaign reaches them.')),
      option('newContactService',
        t(state, 'وافق على رسائل الخدمة', 'Agreed to service messages'),
        t(state, 'للردود والتحديثات عن طلباته.', 'For replies and updates about their requests.')),
    ]),
  ]);
}
