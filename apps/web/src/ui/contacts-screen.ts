import type { ContactSummary } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { initials } from '../format.js';
import { icon } from '../icons.js';
import { channelMark } from './channel-mark.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { contactBody } from './contact-panel.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import {
  avatar,
  button,
  emptyState,
  errorState,
  field,
  inlineError,
  isolated,
  page,
  panel,
  refreshButton,
  selectControl,
  skeleton,
  textInput,
  toolbar,
} from './parts.js';

/**
 * The Contacts directory.
 *
 * A list, a search over display names, and one record at a time. What is
 * deliberately absent is as much of the design as what is here: no "new
 * contact" (a contact exists because somebody wrote to us), no merge (a reviewed
 * decision with an audit trail that does not exist yet), and no search by
 * number (matching a similar number is an identity inference the model refuses).
 */
export function renderContacts(state: AppState): HTMLElement {
  const live = state.live;
  return page('contacts', toolbar(
    t(state, 'كل جهة اتصال نشأت من رسالة وصلت عبر إحدى قنواتك.', 'Every contact was created by a message on one of your channels.'),
    [refreshButton(state, 'live-contacts-reload', live.contacts.status === 'loading')],
  ), [
    // No dialog opens over this screen, so a refusal is always shown here.
    inlineError(state, live.error),
    h('div', { class: 'split split--contacts' }, [
      h('section', { class: 'panel split__list', 'aria-label': t(state, 'جهات الاتصال', 'Contacts') }, [
        h('div', { class: 'panel__header panel__header--stack' }, [
          h('form', { class: 'searchbar', role: 'search', 'data-submit': 'live-contacts-search' }, [
            icon('search', 16),
            textInput('contactQuery', state.dialogForm['contactQuery'] ?? live.contactQuery, t(state, 'ابحث بالاسم', 'Search by name'), {
              type: 'search',
              ariaLabel: t(state, 'ابحث في جهات الاتصال بالاسم', 'Search contacts by name'),
            }),
            button({ label: t(state, 'بحث', 'Search'), act: 'live-contacts-search', small: true }),
          ]),
          filters(state, live),
        ]),
        h('div', { class: 'panel__body panel__body--flush', 'data-scroll': 'contacts' }, [listBody(state, live)]),
      ]),
      h('section', { class: 'panel split__detail', 'aria-label': t(state, 'بيانات جهة الاتصال', 'Contact details') }, [selectedBody(state, live)]),
    ]),
    catalogPanel(state, live),
  ]);
}

function filters(state: AppState, live: LiveState): HTMLElement {
  return h('div', { class: 'contactfilters' }, [
    selectControl({
      value: live.contactFilters.labelId,
      form: 'labelId',
      act: 'live-contact-filter',
      ariaLabel: t(state, 'التصنيف', 'Label'),
      options: [
        { value: '', label: t(state, 'كل التصنيفات', 'Any label') },
        ...rowsOf(live.labels).map((entry) => ({ value: entry.id, label: entry.name })),
      ],
    }),
    selectControl({
      value: live.contactFilters.fieldId,
      form: 'fieldId',
      act: 'live-contact-filter',
      ariaLabel: t(state, 'الحقل المخصّص', 'Custom field'),
      options: [
        { value: '', label: t(state, 'كل الحقول', 'Any field') },
        ...rowsOf(live.customFields)
          .filter((entry) => entry.target === 'contact')
          .map((entry) => ({ value: entry.id, label: entry.name })),
      ],
    }),
    live.contactFilters.fieldId === ''
      ? null
      : h('form', { class: 'inline-form', 'data-submit': 'live-contact-field-filter' }, [
          textInput('contactFieldFilter', live.contactFilters.fieldValue, t(state, 'قيمة الحقل', 'Field value'), { ariaLabel: t(state, 'قيمة الحقل', 'Field value') }),
          button({ label: t(state, 'تطبيق', 'Apply'), act: 'live-contact-field-filter', small: true }),
        ]),
  ]);
}

function listBody(state: AppState, live: LiveState): Child {
  const resource = live.contacts;
  if (resource.status === 'idle' || resource.status === 'loading') {
    return skeleton(state, 5);
  }
  if (resource.status === 'error') {
    return errorState(state, resource.error, 'live-contacts-reload');
  }
  if (resource.value.length === 0) {
    return emptyState({
      icon: 'users',
      title: live.contactQuery === '' ? t(state, 'لا توجد جهات اتصال بعد', 'No contacts yet') : t(state, 'لا نتائج', 'No matches'),
      body: live.contactQuery === ''
        ? t(state, 'تظهر هنا فور أن يراسلك أحد عبر قناة متصلة.', 'They appear as soon as somebody writes to a connected channel.')
        : t(state, 'جرّب اسمًا آخر أو امسح التصفية.', 'Try another name or clear the filters.'),
    });
  }
  return h('ul', { class: 'contactlist' }, resource.value.map((contact) => contactRow(state, contact, live.selectedContactId === contact.id)));
}

function contactRow(state: AppState, contact: ContactSummary, selected: boolean): HTMLElement {
  const identities = contact.identities.filter((identity) => identity.validTo === null);
  const labels = contact.labels;
  return h('li', {}, [
    h('button', {
      type: 'button',
      class: 'contactrow',
      'data-act': 'live-contact-open',
      'data-arg': contact.id,
      'aria-current': selected ? 'true' : 'false',
    }, [
      avatar({ initials: initials(contact.displayName), size: 'sm' }),
      h('span', { class: 'contactrow__main' }, [
        h('span', { class: 'contactrow__name' }, [isolated(contact.displayName)]),
        h('span', { class: 'contactrow__meta' }, [
          identities.length === 0
            ? t(state, 'لا توجد هوية سارية', 'No live identity')
            : identities.map((identity) => phrase(state, CHANNEL_NAMES, identity.kind)).join(' · '),
        ]),
      ]),
      h('span', { class: 'contactrow__channels', 'aria-hidden': 'true' }, identities.slice(0, 3).map((identity) => channelMark(identity.kind, 14))),
      labels.length === 0
        ? null
        : h('span', { class: 'contactrow__labels' }, labels.slice(0, 2).map((label) =>
            h('span', { class: 'metadata__label', style: `--label-color:${label.color}` }, [h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }), label.name]),
          )),
    ]),
  ]);
}

function selectedBody(state: AppState, live: LiveState): Child {
  if (live.selectedContactId === null) {
    return h('div', { class: 'panel__body' }, [
      emptyState({
        icon: 'user',
        title: t(state, 'اختر جهة اتصال', 'Choose a contact'),
        body: t(state, 'اعرض هوياتها وموافقاتها وتصنيفاتها.', 'See its identities, consent and labels.'),
      }),
    ]);
  }
  if (live.selectedContact.status === 'error') {
    return h('div', { class: 'panel__body' }, [errorState(state, live.selectedContact.error, 'live-contacts-reload')]);
  }
  if (live.selectedContact.status !== 'ready') {
    return h('div', { class: 'panel__body' }, [skeleton(state, 3)]);
  }
  return contactBody(state, live.selectedContact.value, live, 'screen');
}

function catalogPanel(state: AppState, live: LiveState): HTMLElement {
  const form = state.dialogForm;
  return panel(t(state, 'التصنيفات والحقول المخصّصة', 'Labels & custom fields'), [
    h('div', { class: 'cataloggrid' }, [
      h('form', { class: 'catalog-form', 'data-submit': 'live-label-create' }, [
        h('h3', { class: 'subsection-title' }, [t(state, 'تصنيف جديد', 'New label')]),
        h('div', { class: 'inline-form' }, [
          field(t(state, 'الاسم', 'Name'), textInput('labelName', form['labelName'] ?? '', t(state, 'مثال: مهتم', 'e.g. Interested'))),
          field(t(state, 'اللون', 'Colour'), h('input', { class: 'input input--color', type: 'color', value: form['labelColor'] ?? '#6558D9', 'data-act': 'form', 'data-form': 'labelColor' })),
          button({ label: t(state, 'إنشاء', 'Create'), act: 'live-label-create', small: true, disabled: live.busy !== null }),
        ]),
      ]),
      h('form', { class: 'catalog-form', 'data-submit': 'live-field-create' }, [
        h('h3', { class: 'subsection-title' }, [t(state, 'حقل جديد', 'New field')]),
        h('div', { class: 'form-grid form-grid--compact' }, [
          field(t(state, 'الاسم', 'Name'), textInput('fieldName', form['fieldName'] ?? '', t(state, 'مثال: مستوى الدورة', 'e.g. Course level'))),
          field(t(state, 'المفتاح', 'Key'), textInput('fieldKey', form['fieldKey'] ?? '', 'course_level')),
          field(t(state, 'السجل', 'Record'), selectControl({ value: form['fieldTarget'] ?? 'contact', form: 'fieldTarget', options: [
            { value: 'contact', label: t(state, 'جهة اتصال', 'Contact') },
            { value: 'conversation', label: t(state, 'محادثة', 'Conversation') },
          ] })),
          field(t(state, 'النوع', 'Type'), selectControl({ value: form['fieldType'] ?? 'text', form: 'fieldType', options: [
            { value: 'text', label: t(state, 'نص', 'Text') },
            { value: 'number', label: t(state, 'رقم', 'Number') },
            { value: 'boolean', label: t(state, 'نعم / لا', 'Yes / No') },
            { value: 'date', label: t(state, 'تاريخ', 'Date') },
            { value: 'email', label: t(state, 'بريد إلكتروني', 'Email') },
            { value: 'phone', label: t(state, 'هاتف دولي', 'International phone') },
            { value: 'single_select', label: t(state, 'اختيار واحد', 'Single choice') },
            { value: 'multi_select', label: t(state, 'اختيارات متعددة', 'Multiple choice') },
          ] })),
          field(t(state, 'الخيارات', 'Options'), textInput('fieldOptions', form['fieldOptions'] ?? '', t(state, 'مفصولة بفاصلة', 'Comma-separated'))),
        ]),
        button({ label: t(state, 'إنشاء الحقل', 'Create field'), act: 'live-field-create', small: true, disabled: live.busy !== null }),
      ]),
    ]),
  ], { description: t(state, 'تُستخدم في المحادثات وجهات الاتصال ويمكن التصفية بها.', 'Shared by conversations and contacts, and usable as filters.') });
}
