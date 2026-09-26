import type { CustomField } from '../api/metadata.js';
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
 * and where they are reached first — a channel identity, optional, since the
 * people who write in get theirs automatically — then the details a team
 * keeps on a customer and their labels. Consent is recorded later, on the profile, when there is evidence.
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
              h('label', { class: 'field__label', for: 'contact-new-channel' }, [t(state, 'القناة (اختياري)', 'Channel (optional)')]),
              connections.length === 0
                ? h('p', { class: 'contact-new__empty', role: 'status' }, [live.connections.status === 'ready'
                    ? t(state, 'لا توجد قناة متصلة بعد. يمكنك إضافة العميل الآن وربطه بقناة لاحقًا.', 'No channel is connected yet. Add the customer now and attach a channel later.')
                    : live.connections.status === 'error'
                      ? live.connections.error.message
                      : t(state, 'جارٍ تحميل القنوات…', 'Loading channels…')])
                : selectControl({
                    id: 'contact-new-channel',
                    form: 'contactCreateConnection',
                    value: connectionId,
                    options: [
                      { value: '', label: t(state, 'بدون قناة الآن', 'No channel yet') },
                      ...connections.map((connection) => ({ value: connection.id, label: `${phrase(state, CHANNEL_NAMES, connection.kind)} · ${connection.display_name}` })),
                    ],
                  }),
              h('p', { class: 'field__hint' }, [t(state,
                'من يراسلك يُضاف تلقائيًا بقناته. هنا تضيف أحدًا بنفسك.',
                'People who message you are added with their channel automatically. Here you add someone yourself.')]),
              fieldError(state, 'contactCreateConnection'),
            ]),
            kind === undefined ? null : h('div', { class: 'field' }, [
              h('label', { class: 'field__label', for: 'contact-new-external' }, [
                h('span', { class: `contact-new__mark channel-tile--${kind}`, 'aria-hidden': 'true' }, [channelMark(kind, 12)]),
                t(state, 'معرّف العميل على القناة', 'Customer channel ID'),
                kind === 'whatsapp' ? null : requiredMark(),
              ]),
              h('input', { id: 'contact-new-external', class: 'input', type: 'text', dir: 'ltr', value: form['contactCreateExternalId'] ?? '', placeholder: kind === 'whatsapp' ? '201001234567' : '', 'data-act': 'form', 'data-form': 'contactCreateExternalId' }),
              h('p', { class: 'field__hint' }, [kind === 'whatsapp'
                ? t(state, 'اتركه فارغًا ليُستخدم رقم الهاتف المكتوب بالأسفل.', 'Leave it empty to use the phone number below.')
                : channelIdHint(kind, state.lang)]),
              fieldError(state, 'contactCreateExternalId'),
            ]),
          ]),
        ]),
        profileSection(state),
        labelsSection(state),
      ]),
    ],
    [
      button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' }),
      button({ label: t(state, 'إضافة جهة الاتصال', 'Add contact'), icon: 'userPlus', act: 'live-contact-create', variant: 'primary', busy }),
    ],
    { size: 'lg' },
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
