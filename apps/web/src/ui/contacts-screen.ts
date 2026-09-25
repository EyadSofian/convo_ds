import { previewContactCsv, type ContactSummary } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { formatNumber, initials } from '../format.js';
import { hasPermission } from '../live/ability.js';
import type { IconName } from '../icons.js';
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
  notice,
  page,
  panel,
  refreshButton,
  selectControl,
  skeleton,
  textInput,
} from './parts.js';

/**
 * The Contacts directory.
 *
 * A scoped directory with explicit channel-identity create/import, while
 * preserving consent as a separate, reviewable permission record.
 *
 * The page opens on the people, not on forms: a brand hero with what the list
 * holds, then the directory beside the open profile. Adding one contact and
 * importing many are tools the operator opens from the hero, one at a time.
 */
export function renderContacts(state: AppState): HTMLElement {
  const live = state.live;
  return page('contacts', null, [
    contactsHero(state, live),
    // No dialog opens over this screen, so a refusal is always shown here.
    inlineError(state, live.error),
    openTool(state, live),
    h('div', { class: 'split split--contacts' }, [
      h('section', { class: 'panel split__list contacts-directory', 'aria-label': t(state, 'جهات الاتصال', 'Contacts') }, [
        h('div', { class: 'panel__header panel__header--stack contacts-directory__head' }, [
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
      h('section', { class: 'panel split__detail contacts-profile', 'aria-label': t(state, 'بيانات جهة الاتصال', 'Contact details') }, [selectedBody(state, live)]),
    ]),
    catalogPanel(state, live),
  ]);
}

type ContactsTool = 'create' | 'import';

function currentTool(state: AppState): ContactsTool | null {
  const tool = state.dialogForm['contactsTool'];
  return tool === 'create' || tool === 'import' ? tool : null;
}

/**
 * The hero: what this directory is, what the loaded list holds, and the three
 * things one does to it. The counts describe the rows on screen — a search or
 * filter narrows them — so they are labelled as this list, never as a total
 * the server did not send.
 */
function contactsHero(state: AppState, live: LiveState): HTMLElement {
  const mayCreate = hasPermission(live, 'contact.edit');
  const mayExport = hasPermission(live, 'contact.export');
  const tool = currentTool(state);
  const rows = live.contacts.status === 'ready' ? live.contacts.value : null;
  const reachable = rows?.filter((contact) => contact.identities.some((identity) => identity.validTo === null)).length;
  const channels = rows === null ? undefined : new Set(rows.flatMap((contact) => contact.identities.filter((identity) => identity.validTo === null).map((identity) => identity.kind))).size;
  const labelled = rows?.filter((contact) => contact.labels.length > 0).length;
  return h('section', { class: 'contacts-hero', 'aria-labelledby': 'contacts-hero-title' }, [
    h('div', { class: 'contacts-hero__top' }, [
      h('div', { class: 'contacts-hero__intro' }, [
        h('span', { class: 'contacts-hero__icon', 'aria-hidden': 'true' }, [icon('contacts', 22)]),
        h('div', { class: 'contacts-hero__copy' }, [
          h('h2', { class: 'contacts-hero__title', id: 'contacts-hero-title' }, [t(state, 'دليل العملاء', 'Customer directory')]),
          h('p', { class: 'contacts-hero__lede' }, [t(state, 'كل عملائك وهوياتهم على قنواتك في مكان واحد.', 'Every customer and their channel identities, in one place.')]),
        ]),
      ]),
      h('div', { class: 'contacts-hero__actions' }, [
        refreshButton(state, 'live-contacts-reload', live.contacts.status === 'loading', false, 'contacts-hero__ghost'),
        mayExport ? button({ label: t(state, 'تصدير CSV', 'Export CSV'), icon: 'download', act: 'live-contacts-export', small: true, busy: live.busy === 'contacts:export', extraClass: 'contacts-hero__ghost' }) : null,
        mayCreate ? toolButton(state, 'import', tool) : null,
        mayCreate ? toolButton(state, 'create', tool) : null,
      ]),
    ]),
    h('dl', { class: 'contacts-hero__stats' }, [
      stat(state, 'users', t(state, 'في هذه القائمة', 'In this list'), rows?.length, 'blue'),
      stat(state, 'checkDouble', t(state, 'يمكن مراسلتهم', 'Reachable now'), reachable, 'green'),
      stat(state, 'layers', t(state, 'قنوات مستخدمة', 'Channels in use'), channels, 'violet'),
      stat(state, 'tag', t(state, 'مصنّفون', 'Labelled'), labelled, 'lime'),
    ]),
  ]);
}

function stat(state: AppState, name: IconName, label: string, value: number | undefined, tone: string): HTMLElement {
  return h('div', { class: `contacts-stat contacts-stat--${tone}` }, [
    h('span', { class: 'contacts-stat__icon', 'aria-hidden': 'true' }, [icon(name, 16)]),
    h('dt', { class: 'contacts-stat__label' }, [label]),
    h('dd', { class: 'contacts-stat__value' }, [value === undefined ? '—' : formatNumber(value, state.lang)]),
  ]);
}

function toolButton(state: AppState, which: ContactsTool, open: ContactsTool | null): HTMLButtonElement {
  const pressed = open === which;
  return button({
    label: which === 'create' ? t(state, 'إضافة جهة اتصال', 'Add contact') : t(state, 'استيراد CSV', 'Import CSV'),
    icon: which === 'create' ? 'userPlus' : 'arrowIn',
    act: 'live-contacts-tool',
    arg: pressed ? '' : which,
    small: true,
    expanded: pressed,
    controls: `contacts-tool-${which}`,
    extraClass: which === 'create' ? 'contacts-hero__primary' : 'contacts-hero__ghost',
  });
}

function openTool(state: AppState, live: LiveState): HTMLElement | null {
  const tool = currentTool(state);
  if (tool === null || !hasPermission(live, 'contact.edit')) return null;
  return tool === 'create' ? createContactForm(state, live) : importPanel(state, live);
}

function toolHead(state: AppState, which: ContactsTool, title: string, hint: string): HTMLElement {
  return h('div', { class: 'contact-tool__head' }, [
    h('span', { class: `contact-tool__icon contact-tool__icon--${which}`, 'aria-hidden': 'true' }, [icon(which === 'create' ? 'userPlus' : 'arrowIn', 18)]),
    h('div', { class: 'contact-tool__titles' }, [
      h('h2', { class: 'panel__title', id: `contacts-tool-${which}-title` }, [title]),
      h('p', { class: 'field__hint' }, [hint]),
    ]),
    button({ icon: 'close', act: 'live-contacts-tool', arg: '', variant: 'ghost', small: true, title: t(state, 'إغلاق', 'Close') }),
  ]);
}

function createContactForm(state: AppState, live: LiveState): HTMLElement {
  const connections = rowsOf(live.connections).filter((connection) => connection.disconnected_at === null);
  return h('form', { class: 'panel contact-tool contact-create', id: 'contacts-tool-create', 'data-submit': 'live-contact-create', 'aria-labelledby': 'contacts-tool-create-title' }, [
    toolHead(
      state,
      'create',
      t(state, 'إضافة جهة اتصال', 'Add a contact'),
      t(state, 'اربط السجل بهوية قناة محددة. الإضافة لا تسجّل موافقة تسويقية.', 'Attach the record to a specific channel identity. Creating a contact does not record marketing consent.'),
    ),
    h('div', { class: 'contact-create__fields' }, [
      field(t(state, 'اسم العميل', 'Customer name'), textInput('contactCreateName', state.dialogForm['contactCreateName'] ?? '', t(state, 'الاسم المعروض', 'Display name'))),
      field(t(state, 'القناة', 'Channel'), selectControl({ act: 'form', form: 'contactCreateConnection', value: state.dialogForm['contactCreateConnection'] ?? '', options: [
        { value: '', label: t(state, 'اختر قناة متصلة', 'Choose a connected channel') },
        ...connections.map((connection) => ({ value: connection.id, label: `${phrase(state, CHANNEL_NAMES, connection.kind)} · ${connection.display_name}` })),
      ] })),
      field(t(state, 'معرّف العميل على القناة', 'Customer channel ID'), h('input', { class: 'input', type: 'text', dir: 'ltr', value: state.dialogForm['contactCreateExternalId'] ?? '', placeholder: t(state, 'رقم أو معرّف القناة', 'Channel phone or provider ID'), 'data-act': 'form', 'data-form': 'contactCreateExternalId' })),
      live.connections.status === 'idle' || live.connections.status === 'error' || live.connections.status === 'loading'
        ? button({ label: t(state, 'تحميل القنوات', 'Load channels'), act: 'live-contact-connections', variant: 'ghost', busy: live.connections.status === 'loading' })
        : button({ label: t(state, 'إنشاء جهة الاتصال', 'Create contact'), icon: 'check', act: 'live-contact-create', variant: 'primary', disabled: connections.length === 0 || live.busy !== null }),
    ]),
    connections.length === 0 ? h('p', { class: 'contact-create__notice', role: 'status' }, [t(state, 'لا توجد قناة متاحة لإنشاء هوية عليها. اربط قناة أولاً.', 'No channel is available for an identity. Connect a channel first.')]) : null,
  ]);
}

function importPanel(state: AppState, live: LiveState): HTMLElement {
  const csv = state.dialogForm['contactImportCsv'] ?? '';
  const preview = csv === '' ? null : previewContactCsv(csv);
  const connections = rowsOf(live.connections).filter((connection) => connection.disconnected_at === null);
  return h('section', { class: 'panel contact-tool contact-transfer', id: 'contacts-tool-import', 'aria-labelledby': 'contacts-tool-import-title' }, [
    toolHead(
      state,
      'import',
      t(state, 'استيراد جهات الاتصال', 'Import contacts'),
      t(state, 'الاستيراد ينشئ هويات على قناة واحدة ولا يضيف موافقة تسويقية تلقائيًا.', 'Imports attach identities to one channel and never add marketing consent automatically.'),
    ),
    h('div', { class: 'contact-transfer__import' }, [
      field(t(state, 'قناة الهويات', 'Identity channel'), selectControl({
        form: 'contactImportConnection', value: state.dialogForm['contactImportConnection'] ?? '',
        options: [{ value: '', label: t(state, 'اختر قناة متصلة', 'Choose a connected channel') }, ...connections.map((entry) => ({ value: entry.id, label: `${phrase(state, CHANNEL_NAMES, entry.kind)} · ${entry.display_name}` }))],
      })),
      h('label', { class: 'field contact-transfer__file' }, [
        h('span', { class: 'field__label' }, [t(state, 'ملف CSV', 'CSV file')]),
        h('input', { class: 'input', type: 'file', accept: '.csv,text/csv', 'data-act': 'live-contact-import-file', 'aria-label': t(state, 'اختر ملف جهات الاتصال CSV', 'Choose contacts CSV file') }),
      ]),
      live.connections.status === 'idle' || live.connections.status === 'error'
        ? button({ label: t(state, 'تحميل القنوات', 'Load channels'), act: 'live-contact-connections', variant: 'ghost' }) : null,
      h('a', { class: 'contact-transfer__template', href: `data:text/csv;charset=utf-8,${encodeURIComponent('display_name,external_id\r\nExample Customer,201000000000\r\n')}`, download: 'contacts-template.csv' }, [icon('download', 14), t(state, 'تنزيل نموذج CSV', 'Download CSV template')]),
      state.dialogForm['contactImportError'] === 'size'
        ? notice('warning', 'info', t(state, 'حجم الملف أكبر من 1 ميجابايت.', 'CSV files must be 1 MB or smaller.'))
        : preview === null ? null : preview.ok
        ? h('div', { class: 'contact-transfer__preview', role: 'status' }, [
            h('strong', {}, [t(state, `${String(preview.rows.length)} جهة جاهزة للاستيراد`, `${String(preview.rows.length)} contacts ready to import`)]),
            h('span', {}, [state.dialogForm['contactImportFileName'] ?? 'CSV']),
            h('span', {}, [preview.rows.slice(0, 3).map((row) => `${row.displayName} · ${row.externalId}`).join('، ')]),
          ])
        : notice('warning', 'info', t(state, 'تعذّرت معاينة الملف. تأكد من النموذج وأن الملف لا يتجاوز 1 ميجابايت و500 صف.', `Could not preview this file: ${preview.message}`)),
      button({ label: t(state, 'استيراد جهات الاتصال', 'Import contacts'), icon: 'contacts', act: 'live-contacts-import', variant: 'primary', disabled: preview?.ok !== true || (state.dialogForm['contactImportConnection'] ?? '') === '' || connections.length === 0 || live.busy !== null, busy: live.busy === 'contacts:import' }),
    ]),
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
  return h('ul', { class: 'contactlist' }, resource.value.map((contact, index) => contactRow(state, contact, live.selectedContactId === contact.id, index)));
}

function contactRow(state: AppState, contact: ContactSummary, selected: boolean, index: number): HTMLElement {
  const identities = contact.identities.filter((identity) => identity.validTo === null);
  const labels = contact.labels;
  // `--i` staggers the list's entrance; past a screenful the rows arrive together.
  return h('li', { style: `--i:${String(Math.min(index, 12))}` }, [
    h('button', {
      type: 'button',
      class: 'contactrow',
      'data-act': 'live-contact-open',
      'data-arg': contact.id,
      'aria-current': selected ? 'true' : 'false',
    }, [
      avatar({ initials: initials(contact.displayName), seed: contact.displayName, channel: identities[0]?.kind }),
      h('span', { class: 'contactrow__main' }, [
        h('span', { class: 'contactrow__name' }, [isolated(contact.displayName)]),
        h('span', { class: 'contactrow__meta' }, [
          identities.length === 0
            ? t(state, 'لا توجد هوية سارية', 'No live identity')
            : identities.map((identity) => phrase(state, CHANNEL_NAMES, identity.kind)).join(' · '),
        ]),
      ]),
      h('span', { class: 'contactrow__channels', 'aria-hidden': 'true' }, identities.slice(0, 3).map((identity) => h('span', { class: `contactrow__channel channel-tile--${identity.kind}` }, [channelMark(identity.kind, 13)]))),
      labels.length === 0
        ? null
        : h('span', { class: 'contactrow__labels' }, labels.slice(0, 2).map((label) =>
            h('span', { class: 'metadata__label', style: `--label-color:${label.color}` }, [h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }), label.name]),
          )),
      h('span', { class: 'contactrow__chevron', 'aria-hidden': 'true' }, [icon('chevronEnd', 16)]),
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
  ], { description: t(state, 'تُستخدم في المحادثات وجهات الاتصال ويمكن التصفية بها.', 'Shared by conversations and contacts, and usable as filters.'), extraClass: 'catalog-panel' });
}
