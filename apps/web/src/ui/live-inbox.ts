import type { Conversation, QueueCard, TimelineMessage } from '../api/conversations.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { clockTime, dayLabel, initials, relativeTime } from '../format.js';
import { icon } from '../icons.js';
import { INBOX_FILTER_CATALOGUE, type InboxFilter, type InboxFilterDefinition } from '@convo/domain';
import { routingAbility } from '../live/ability.js';
import { activeFilterCount } from '../live/inbox-query.js';
import { isDenial, rowsOf } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { LIST_WIDTH_MAX, LIST_WIDTH_MIN } from '../state.js';
import { renderContactPanel } from './contact-panel.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import type { Phrase } from './copy.js';
import {
  episodesSection,
  lifecycleControls,
  lifecycleForm,
  lifecycleNotice,
  notesSection,
  statusBadge,
} from './lifecycle-panel.js';
import { metadataSection } from './metadata-section.js';
import {
  avatar,
  button,
  emptyState,
  errorState,
  isolated,
  segmented,
  selectControl,
  skeleton,
} from './parts.js';
import { movedAway, priorityBadge, routingSection } from './routing-panel.js';

/**
 * The Inbox, backed entirely by the API.
 *
 * Three zones, and each one shows exactly what the server is willing to say:
 *
 * - **Queue** — the Unassigned work, as *projected cards*. A card carries a
 *   masked label and no message text, because that is what the server sends to
 *   somebody who has not claimed the conversation (IAM-11).
 * - **Mine** — conversations this caller may actually read, as records.
 * - **Thread** — the timeline of one conversation, with a reply composer only
 *   once it is theirs, and a private-note composer that never reaches the
 *   customer.
 *
 * The live connection's state is on screen, deliberately. A stream that has
 * stopped delivering looks exactly like a quiet inbox.
 */

const DELIVERY_LABEL: Readonly<Record<string, Phrase>> = {
  sent: { ar: 'أُرسلت', en: 'Sent' },
  delivered: { ar: 'سُلّمت', en: 'Delivered' },
  read: { ar: 'قُرئت', en: 'Read' },
};

const COMMAND_LABEL: Readonly<Record<string, Phrase>> = {
  queued: { ar: 'في الانتظار', en: 'Queued' },
  dispatching: { ar: 'جارٍ الإرسال', en: 'Sending' },
  provider_accepted: { ar: 'قبلها المزوّد', en: 'Accepted' },
  rejected: { ar: 'مرفوضة', en: 'Rejected' },
  retry_scheduled: { ar: 'ستُعاد المحاولة', en: 'Retry scheduled' },
  skipped: { ar: 'تم تخطيها', en: 'Skipped' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  failed: { ar: 'فشلت', en: 'Failed' },
  outcome_unknown: { ar: 'النتيجة غير معروفة', en: 'Outcome unknown' },
};

/* ------------------------------------------------------------------ shell -- */

export function renderInbox(state: AppState): HTMLElement {
  const live = state.live;
  const open = live.openConversationId !== null;
  const supervisorMode = live.supervisorAgentId !== null;
  return h(
    'div',
    {
      class: 'inbox',
      'data-list': state.listOpen ? 'open' : 'closed',
      'data-panel': open && state.panelOpen ? 'open' : 'closed',
      'data-panel-drawer': open && state.panelDrawer ? 'open' : 'closed',
      style: `--list-width:${String(state.listWidth)}px`,
    },
    [
      renderListZone(state, live),
      h('button', {
        type: 'button',
        class: 'zone-scrim zone-scrim--list',
        'data-act': 'close-overlays',
        'data-arg': 'list',
        'data-scrim': 'true',
        'aria-label': t(state, 'إغلاق قائمة المحادثات', 'Close conversation list'),
        tabindex: '-1',
      }),
      renderThreadZone(state, live),
      open
        ? h('button', {
            type: 'button',
            class: 'zone-scrim zone-scrim--panel',
            'data-act': 'close-overlays',
            'data-arg': 'panel-drawer',
            'data-scrim': 'true',
            'aria-label': t(state, 'إغلاق التفاصيل', 'Close details'),
            tabindex: '-1',
          })
        : null,
      open
        ? renderContactPanel(state, live, [
            live.openConversation.status === 'ready'
              ? metadataSection(state, live, 'conversation', live.openConversation.value, { readOnly: supervisorMode })
              : null,
            !supervisorMode && live.openConversation.status === 'ready'
              ? routingSection(state, live, live.openConversation.value, routingAbility(live))
              : null,
            supervisorMode ? null : notesSection(state, live),
            episodesSection(state, live),
          ])
        : null,
    ],
  );
}

/**
 * The draggable edge of the queue column. A `separator` with a value range, so
 * the width is adjustable from the keyboard as well as by pointer.
 */
function listResizer(state: AppState): HTMLElement {
  return h('button', {
    type: 'button',
    class: 'list-resizer',
    'data-act': 'resize-list-step',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t(state, 'عرض قائمة المحادثات', 'Conversation list width'),
    'aria-valuemin': String(LIST_WIDTH_MIN),
    'aria-valuemax': String(LIST_WIDTH_MAX),
    'aria-valuenow': String(state.listWidth),
  });
}

/* ------------------------------------------------------------------- list -- */

function renderListZone(state: AppState, live: LiveState): HTMLElement {
  const supervisorMode = live.supervisorAgentId !== null;
  const activeFilters = activeFilterCount(live.inboxQuery);
  return h('section', { class: 'zone zone--list', 'aria-label': t(state, 'قائمة المحادثات', 'Conversation list') }, [
    h('header', { class: 'listhead' }, [
      supervisorMode ? h('div', { class: 'listhead__supervisor', role: 'status' }, [
        icon('eye', 15), t(state, 'عرض إشرافي للقراءة فقط', 'Read-only supervisor view'),
      ]) : segmented(
        [
          { value: 'unassigned', label: t(state, 'غير مسندة', 'Unassigned'), count: countOf(live.unassigned) },
          { value: 'mine', label: t(state, 'محادثاتي', 'Mine'), count: countOf(live.conversations) },
        ],
        state.inboxQueue,
        'live-inbox-queue',
        t(state, 'طابور المحادثات', 'Conversation queue'),
      ),
      h('div', { class: 'listhead__tools' }, [
        h('div', { class: 'menu-anchor' }, [
          button({
            label: t(state, 'إضافة فلتر', 'Add filter'),
            icon: 'plus',
            act: 'menu',
            arg: 'inbox-filters',
            variant: 'ghost',
            small: true,
            expanded: state.openMenu === 'inbox-filters',
            haspopup: 'dialog',
            title: activeFilters === 0
              ? t(state, 'تصفية', 'Filter')
              : t(state, `تصفية (${String(activeFilters)} مفعّلة)`, `Filter (${String(activeFilters)} active)`),
            extraClass: activeFilters === 0 ? undefined : 'btn--active',
          }),
          state.openMenu === 'inbox-filters' ? inboxFilters(state, live) : null,
        ]),
        button({
          label: t(state, 'عرض فريق', 'View team'), icon: 'eye', act: 'live-supervisor-open', variant: 'ghost', small: true,
          busy: live.supervisorAgents.status === 'loading', title: t(state, 'عرض المحادثات المسندة لوكيل ضمن نطاقك', 'View an in-scope agent’s assigned conversations'),
        }),
        selectControl({
          act: 'live-inbox-sort', value: live.inboxQuery.sort,
          ariaLabel: t(state, 'ترتيب المحادثات', 'Sort conversations'),
          options: [
            { value: 'activity_desc', label: t(state, 'أحدث نشاط', 'Newest activity') },
            { value: 'activity_asc', label: t(state, 'أقدم نشاط', 'Oldest activity') },
            { value: 'created_desc', label: t(state, 'أحدث إنشاء', 'Newest created') },
            { value: 'created_asc', label: t(state, 'أقدم إنشاء', 'Oldest created') },
            { value: 'waiting_desc', label: t(state, 'الأطول انتظارًا', 'Waiting longest') },
            { value: 'priority_desc', label: t(state, 'الأولوية', 'Priority') },
          ],
        }),
        h('div', { class: 'menu-anchor' }, [
          button({
            icon: 'bookmark', act: 'menu', arg: 'inbox-saved-views', variant: 'ghost', small: true,
            expanded: state.openMenu === 'inbox-saved-views', haspopup: 'dialog',
            title: t(state, 'العروض المحفوظة', 'Saved views'),
            extraClass: live.selectedSavedViewId === null ? undefined : 'btn--active',
          }),
          state.openMenu === 'inbox-saved-views' ? savedViewsMenu(state, live) : null,
        ]),
        button({
          icon: 'refresh',
          act: 'live-inbox-reload',
          variant: 'ghost',
          small: true,
          busy: live.unassigned.status === 'loading',
          title: t(state, 'تحديث', 'Refresh'),
        }),
        button({
          icon: 'close',
          act: 'close-overlays',
          arg: 'list',
          variant: 'ghost',
          small: true,
          title: t(state, 'إغلاق القائمة', 'Close list'),
          extraClass: 'listhead__close',
        }),
      ]),
    ]),
    inboxSearch(state, live),
    supervisorPicker(state, live),
    supervisorBanner(state, live),
    activeFilterChips(state, live),
    connectionNotice(state, live),
    listResizer(state),
    h('div', { class: 'zone__body', 'data-scroll': 'list' }, [
      supervisorMode || state.inboxQueue === 'mine' ? mineList(state, live) : queueList(state, live),
    ]),
  ]);
}

function supervisorPicker(state: AppState, live: LiveState): Child {
  if (live.supervisorAgents.status === 'idle') return null;
  if (live.supervisorAgents.status === 'loading') return h('p', { class: 'empty-copy' }, [t(state, 'جارٍ تحميل الوكلاء المتاحين…', 'Loading in-scope agents…')]);
  if (live.supervisorAgents.status === 'error') return h('p', { class: 'empty-copy', role: 'status' }, [t(state, 'لا تملك صلاحية العرض الإشرافي.', 'Supervisor view is not available to this role.')]);
  const agents = live.supervisorAgents.value;
  if (agents.length === 0) return h('p', { class: 'empty-copy' }, [t(state, 'لا يوجد وكلاء نشطون ضمن نطاقك.', 'No active agents are available in your scope.')]);
  const options = [{ value: '', label: t(state, 'اختر وكيلًا للعرض', 'Choose an agent to view') }, ...agents.map((agent) => ({ value: agent.membershipId, label: `${agent.name} · ${agent.email}${agent.teams.length === 0 ? '' : ` · ${agent.teams.join(', ')}`}` }))];
  return h('label', { class: 'field field--row inbox-supervisor-picker' }, [
    h('span', { class: 'field__label' }, [t(state, 'عرض وكيل', 'View agent')]),
    selectControl({ act: 'live-supervisor-agent', value: live.supervisorAgentId ?? '', ariaLabel: t(state, 'اختر وكيلًا', 'Choose agent'), options }),
  ]);
}

/** A server-backed operational summary; never an inference from a loaded page. */
function supervisorBanner(state: AppState, live: LiveState): Child {
  const agentId = live.supervisorAgentId;
  if (agentId === null) return null;
  const agent = rowsOf(live.supervisorAgents).find((entry) => entry.membershipId === agentId);
  const workload = live.supervisorWorkload.status === 'ready' ? live.supervisorWorkload.value : null;
  const name = agent?.name ?? t(state, 'الوكيل المحدد', 'Selected agent');
  const teams = agent?.teams ?? workload?.agent.teams ?? [];
  const count = workload?.current.assigned ?? 0;
  const detail = workload?.current;
  return h('section', { class: 'inbox-supervisor-banner', role: 'status', 'aria-live': 'polite' }, [
    h('div', { class: 'inbox-supervisor-banner__identity' }, [
      h('strong', {}, [t(state, `عرض حمل ${name}`, `Viewing ${name}'s workload`)]),
      teams.length === 0 ? null : h('span', { class: 'inbox-supervisor-banner__teams' }, [teams.join(' · ')]),
      live.supervisorWorkload.status === 'loading'
        ? h('span', { class: 'inbox-supervisor-banner__count' }, [t(state, 'جارٍ تحميل الحمل…', 'Loading workload…')])
        : h('span', { class: 'inbox-supervisor-banner__count' }, [t(state, `${String(count)} محادثات نشطة`, `${String(count)} active conversations`)]),
    ]),
    h('div', { class: 'inbox-supervisor-banner__metrics', 'aria-label': t(state, 'ملخص حمل الوكيل', 'Agent workload summary') }, [
      supervisorMetric(t(state, 'مفتوحة', 'Open'), detail?.open ?? 0),
      supervisorMetric(t(state, 'معلّقة', 'Pending'), detail?.pending ?? 0),
      supervisorMetric(t(state, 'مؤجلة', 'Snoozed'), detail?.snoozed ?? 0),
      supervisorMetric(t(state, 'دون رد', 'Unreplied'), detail?.unreplied ?? 0),
    ]),
    h('div', { class: 'inbox-supervisor-banner__actions' }, [
      button({ label: t(state, 'فتح تقرير الوكيل', 'Open agent report'), act: 'live-supervisor-open-report', arg: agentId, variant: 'ghost', small: true }),
      button({ label: t(state, 'إنهاء العرض', 'Exit'), act: 'live-supervisor-exit', variant: 'ghost', small: true }),
    ]),
  ]);
}

function supervisorMetric(label: string, value: number): HTMLElement {
  return h('span', { class: 'inbox-supervisor-banner__metric' }, [
    h('span', { class: 'inbox-supervisor-banner__metric-label' }, [label]),
    h('strong', {}, [String(value)]),
  ]);
}

function countOf(resource: Resource<readonly unknown[]>): number | undefined {
  return resource.status === 'ready' ? resource.value.length : undefined;
}

function inboxFilters(state: AppState, live: LiveState): HTMLElement {
  const search = state.dialogForm['inboxFilterCatalogueSearch'] ?? '';
  const definitions = INBOX_FILTER_CATALOGUE.filter((definition) => definition.inbox && filterLabel(state, definition).toLowerCase().includes(search.toLowerCase()));
  const selectedKey = state.dialogForm['inboxFilterKey'] ?? definitions[0]?.key ?? '';
  const selected = INBOX_FILTER_CATALOGUE.find((definition) => definition.key === selectedKey) ?? definitions[0];
  const selectedField = selected?.key === 'custom_field'
    ? rowsOf(live.customFields).find((field) => field.id === (state.dialogForm['inboxFilterFieldId'] ?? ''))
    : undefined;
  const operators = selected?.key === 'custom_field' ? customFieldOperators(selectedField?.type) : selected?.operators ?? [];
  const requestedOperator = state.dialogForm['inboxFilterOperator'] ?? '';
  const operator = operators.includes(requestedOperator) ? requestedOperator : operators[0] ?? '';
  const row = (label: string, control: HTMLElement): HTMLElement => h('label', { class: 'field field--row' }, [h('span', { class: 'field__label' }, [label]), control]);
  return h('div', { class: 'popover inbox-filter-popover', role: 'dialog', 'data-overlay': 'popover', 'data-trap': 'mobile-inbox-filters', 'aria-label': t(state, 'تصفية المحادثات', 'Filter conversations') }, [
    h('div', { class: 'inbox-filter-popover__head' }, [
      h('strong', {}, [t(state, 'الفلاتر', 'Filters')]),
      button({ icon: 'close', act: 'close-menu', variant: 'ghost', small: true, title: t(state, 'إغلاق الفلاتر', 'Close filters') }),
    ]),
    h('input', { class: 'input input--sm', type: 'search', value: search, placeholder: t(state, 'ابحث عن فلتر', 'Find a filter'), 'data-act': 'form-toggle', 'data-form': 'inboxFilterCatalogueSearch' }),
    ...(selected === undefined ? [h('p', { class: 'empty-copy' }, [t(state, 'لا يوجد فلتر مطابق.', 'No matching filter.')])] : [
      row(t(state, 'الحقل', 'Field'), selectControl({ act: 'form-toggle', form: 'inboxFilterKey', value: selected.key, options: definitions.map((definition) => ({ value: definition.key, label: filterLabel(state, definition) })) })),
      row(t(state, 'المطابقة', 'Match'), selectControl({ act: 'form-toggle', form: 'inboxFilterOperator', value: operator, options: operators.map((value) => ({ value, label: operatorLabel(state, value) })) })),
      filterValueEditor(state, live, selected, operator),
      button({ label: t(state, 'إضافة فلتر', 'Add filter'), act: 'live-inbox-filter-apply', variant: 'primary', small: true, disabled: live.busy !== null || (selected.key === 'custom_field' && selectedField === undefined) }),
    ]),
  ]);
}

function inboxSearch(state: AppState, live: LiveState): HTMLElement {
  return h('div', { class: 'inbox-search' }, [
    icon('search', 16),
    h('input', {
      class: 'inbox-search__input', type: 'search', value: live.inboxSearchDraft,
      placeholder: t(state, 'ابحث بالاسم أو الهاتف أو المعرّف', 'Search name, phone or ID'),
      'aria-label': t(state, 'بحث في المحادثات', 'Search conversations'), 'data-act': 'live-inbox-search',
    }),
    live.inboxSearchDraft === '' ? null : button({ icon: 'close', act: 'live-inbox-search', arg: '', variant: 'ghost', small: true, title: t(state, 'مسح البحث', 'Clear search') }),
  ]);
}

function activeFilterChips(state: AppState, live: LiveState): Child {
  if (live.inboxQuery.filters.length === 0) return null;
  return h('div', { class: 'inbox-filter-chips', role: 'list', 'aria-label': t(state, 'الفلاتر المطبقة', 'Applied filters') }, [
    ...live.inboxQuery.filters.map((filter, index) => h('span', { class: 'inbox-filter-chip', role: 'listitem' }, [
      filterDescription(state, live, filter),
      button({ icon: 'close', act: 'live-inbox-filter-remove', arg: String(index), variant: 'ghost', small: true, title: t(state, 'إزالة الفلتر', 'Remove filter') }),
    ])),
    button({ label: t(state, 'مسح الكل', 'Clear all'), act: 'live-inbox-filter-clear', variant: 'ghost', small: true }),
  ]);
}

function filterValueEditor(state: AppState, live: LiveState, definition: InboxFilterDefinition, operator: string): HTMLElement | null {
  if (operator === 'is_set' || operator === 'is_not_set') return null;
  const form = state.dialogForm;
  const key = 'inboxFilterValue';
  const row = (label: string, control: HTMLElement): HTMLElement => h('label', { class: 'field field--row' }, [h('span', { class: 'field__label' }, [label]), control]);
  if (definition.key === 'custom_field') {
    const fields = rowsOf(live.customFields).filter((field) => field.target === 'conversation' && field.state === 'active');
    const selectedField = fields.find((field) => field.id === (form['inboxFilterFieldId'] ?? ''));
    return h('div', { class: 'filter-value-editor' }, [
      row(t(state, 'الحقل المخصص', 'Custom field'), selectControl({ act: 'form-toggle', form: 'inboxFilterFieldId', value: form['inboxFilterFieldId'] ?? '', options: [{ value: '', label: t(state, 'اختر حقلاً', 'Choose a field') }, ...fields.map((field) => ({ value: field.id, label: field.name }))] })),
      selectedField === undefined
        ? h('p', { class: 'field__hint' }, [t(state, 'اختر حقلاً لإظهار قيمة مناسبة لنوعه.', 'Choose a field to show the value control for its type.')])
        : customFieldValueControl(state, selectedField.type, selectedField.options, key),
    ]);
  }
  return valueControl(state, live, definition, key);
}

/** Only operators the server validates for this typed custom field. */
function customFieldOperators(type: string | undefined): readonly string[] {
  if (type === 'boolean') return ['eq', 'neq', 'is_set', 'is_not_set'];
  if (type === 'number' || type === 'date' || type === 'single_select') return ['eq', 'neq', 'is_set', 'is_not_set'];
  if (type === 'text' || type === 'email' || type === 'phone') return ['eq', 'contains', 'is_set', 'is_not_set'];
  // Multi-select has no comparison semantics in the API yet; existence tests
  // remain useful and, unlike a guessed containment query, are unambiguous.
  if (type === 'multi_select') return ['is_set', 'is_not_set'];
  return ['eq', 'is_set', 'is_not_set'];
}

function customFieldValueControl(state: AppState, type: string, options: readonly string[], key: string): HTMLElement {
  const value = state.dialogForm[key] ?? '';
  const ariaLabel = t(state, 'قيمة الفلتر', 'Filter value');
  if (type === 'boolean') return selectControl({ act: 'form', form: key, value, ariaLabel, options: [{ value: '', label: t(state, 'اختر', 'Choose') }, { value: 'true', label: t(state, 'نعم', 'Yes') }, { value: 'false', label: t(state, 'لا', 'No') }] });
  if (type === 'single_select') return selectControl({ act: 'form', form: key, value, ariaLabel, options: [{ value: '', label: t(state, 'اختر', 'Choose') }, ...options.map((option) => ({ value: option, label: option }))] });
  const inputType = type === 'date' ? 'date' : type === 'number' ? 'number' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
  return h('input', { class: 'input', type: inputType, value, placeholder: t(state, 'القيمة', 'Value'), 'aria-label': ariaLabel, 'data-act': 'form', 'data-form': key, dir: inputType === 'text' ? undefined : 'ltr' });
}

function valueControl(state: AppState, live: LiveState, definition: InboxFilterDefinition, key: string): HTMLElement {
  const value = state.dialogForm[key] ?? '';
  const ariaLabel = t(state, 'قيمة الفلتر', 'Filter value');
  const enumValues = enumOptions(state, definition.key);
  if (definition.valueType === 'boolean') return selectControl({ act: 'form', form: key, value, ariaLabel, options: [{ value: '', label: t(state, 'اختر', 'Choose') }, { value: 'true', label: t(state, 'نعم', 'Yes') }, { value: 'false', label: t(state, 'لا', 'No') }] });
  if (enumValues !== null) return selectControl({ act: 'form', form: key, value, ariaLabel, options: [{ value: '', label: t(state, 'اختر', 'Choose') }, ...enumValues] });
  const picked = pickerOptions(live, definition);
  if (definition.valueType === 'label_id' && (state.dialogForm['inboxFilterOperator'] === 'in' || state.dialogForm['inboxFilterOperator'] === 'not_in')) {
    const selected = new Set(value.split(',').filter(Boolean));
    return h('div', { class: 'inbox-filter-picker', role: 'group', 'aria-label': t(state, 'اختر التصنيفات', 'Choose labels') }, [
      ...picked!.map((option) => button({
        label: option.label,
        act: 'live-inbox-filter-value-toggle',
        arg: option.value,
        variant: selected.has(option.value) ? 'primary' : 'ghost',
        small: true,
        pressed: selected.has(option.value),
      })),
    ]);
  }
  if (picked !== null) return selectControl({ act: 'form', form: key, value, ariaLabel, disabled: picked.length === 0, options: [{ value: '', label: picked.length === 0 ? t(state, 'لا توجد قيم متاحة', 'No available values') : t(state, 'اختر', 'Choose') }, ...picked] });
  return h('input', { class: 'input', type: definition.valueType === 'date' ? 'date' : 'text', value, placeholder: t(state, 'القيمة', 'Value'), 'aria-label': ariaLabel, 'data-act': 'form', 'data-form': key, dir: definition.valueType === 'text' || definition.valueType === 'custom_field' ? undefined : 'ltr' });
}

/** Converts server-backed resources into labels before they reach a picker. */
function pickerOptions(live: LiveState, definition: InboxFilterDefinition): readonly { readonly value: string; readonly label: string }[] | null {
  if (definition.valueType === 'membership_id') {
    return rowsOf(live.people).filter((person) => person.status === 'active').map((person) => ({ value: person.membership_id, label: person.email }));
  }
  if (definition.valueType === 'team_id') {
    return rowsOf(live.teams).filter((team) => !team.archived).map((team) => ({ value: team.id, label: team.name }));
  }
  if (definition.valueType === 'connection_id') {
    return rowsOf(live.connections).filter((connection) => connection.disconnected_at === null).map((connection) => ({ value: connection.id, label: connection.display_name }));
  }
  if (definition.valueType === 'label_id') {
    return rowsOf(live.labels).filter((label) => label.state === 'active').map((label) => ({ value: label.id, label: label.name }));
  }
  if (definition.valueType === 'campaign_id') {
    return rowsOf(live.campaigns).map((campaign) => ({ value: campaign.id, label: campaign.name }));
  }
  return null;
}

function enumOptions(state: AppState, key: string): readonly { readonly value: string; readonly label: string }[] | null {
  if (key === 'status') return ['open', 'pending', 'snoozed', 'resolved'].map((value) => ({ value, label: value }));
  if (key === 'priority') return ['urgent', 'high', 'normal', 'low'].map((value) => ({ value, label: phrase(state, { urgent: { ar: 'عاجلة', en: 'Urgent' }, high: { ar: 'مرتفعة', en: 'High' }, normal: { ar: 'عادية', en: 'Normal' }, low: { ar: 'منخفضة', en: 'Low' } }, value) }));
  if (key === 'channel') return ['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'].map((value) => ({ value, label: phrase(state, CHANNEL_NAMES, value) }));
  if (key === 'assignment_state') return [{ value: 'assigned', label: t(state, 'مسندة', 'Assigned') }, { value: 'unassigned', label: t(state, 'غير مسندة', 'Unassigned') }];
  return null;
}

function filterLabel(state: AppState, definition: InboxFilterDefinition): string {
  const labels: Readonly<Record<InboxFilterDefinition['key'], readonly [string, string]>> = {
    status: ['الحالة', 'Status'], assignment_state: ['الإسناد', 'Assignment'], assigned_agent_id: ['الوكيل', 'Agent'], team_id: ['الفريق', 'Team'], channel: ['القناة', 'Channel'], connection_id: ['الاتصال', 'Connection'], label_id: ['التصنيف', 'Label'], priority: ['الأولوية', 'Priority'], unread: ['القراءة', 'Read state'], unreplied: ['بانتظار رد', 'Awaiting reply'], created_at: ['تاريخ الإنشاء', 'Created'], last_activity_at: ['آخر نشاط', 'Last activity'], waiting_since: ['بانتظار منذ', 'Waiting since'], customer_name: ['اسم العميل', 'Customer name'], customer_phone: ['هاتف العميل', 'Customer phone'], collaborator_id: ['متعاون', 'Collaborator'], participant_id: ['مشارك', 'Participant'], handoff_target_id: ['تحويل إلى', 'Handoff target'], campaign_id: ['الحملة', 'Campaign'], custom_field: ['حقل مخصص', 'Custom field'],
  };
  const label = labels[definition.key];
  return t(state, label[0], label[1]);
}

function operatorLabel(state: AppState, operator: string): string {
  const labels: Record<string, readonly [string, string]> = { eq: ['يساوي', 'is'], neq: ['لا يساوي', 'is not'], in: ['ضمن', 'is any of'], not_in: ['ليس ضمن', 'is none of'], contains: ['يتضمن', 'contains'], before: ['قبل', 'before'], after: ['بعد', 'after'], is_set: ['موجود', 'is set'], is_not_set: ['غير موجود', 'is not set'] };
  const label = labels[operator];
  return label === undefined ? operator : t(state, label[0], label[1]);
}

function filterDescription(state: AppState, live: LiveState, filter: InboxFilter): string {
  const definition = INBOX_FILTER_CATALOGUE.find((entry) => entry.key === filter.key);
  const name = definition === undefined ? filter.key : filterLabel(state, definition);
  const values = filter.value === undefined ? [] : Array.isArray(filter.value) ? filter.value : [String(filter.value)];
  const value = values.map((entry) => filterValueLabel(live, filter, entry)).join(filter.key === 'label_id' ? ' + ' : ', ');
  const operator = filter.key === 'label_id' && filter.operator === 'in'
    ? t(state, 'تطابق جميع التصنيفات', 'matches all labels')
    : operatorLabel(state, filter.operator);
  return `${name} ${operator}${value === '' ? '' : ` ${value}`}`;
}

function filterValueLabel(live: LiveState, filter: InboxFilter, value: string): string {
  if (filter.key === 'assigned_agent_id' || filter.key === 'collaborator_id' || filter.key === 'participant_id' || filter.key === 'handoff_target_id') {
    return rowsOf(live.people).find((person) => person.membership_id === value)?.email ?? pendingValue();
  }
  if (filter.key === 'team_id') return rowsOf(live.teams).find((team) => team.id === value)?.name ?? pendingValue();
  if (filter.key === 'connection_id') return rowsOf(live.connections).find((connection) => connection.id === value)?.display_name ?? pendingValue();
  if (filter.key === 'label_id') return rowsOf(live.labels).find((label) => label.id === value)?.name ?? pendingValue();
  if (filter.key === 'campaign_id') return rowsOf(live.campaigns).find((campaign) => campaign.id === value)?.name ?? pendingValue();
  return value;
}

/** The fallback avoids leaking opaque query identifiers into the visual UI. */
function pendingValue(): string { return '…'; }

function savedViewsMenu(state: AppState, live: LiveState): HTMLElement {
  const views = live.savedViews.status === 'ready' ? live.savedViews.value : [];
  return h('div', { class: 'popover inbox-saved-views', role: 'group', 'data-overlay': 'popover', 'aria-label': t(state, 'العروض المحفوظة', 'Saved views') }, [
    ...views.map((view) => button({ label: view.name, act: 'live-inbox-saved-view-apply', arg: view.id, variant: view.id === live.selectedSavedViewId ? 'primary' : 'ghost', small: true })),
    views.length === 0 ? h('p', { class: 'empty-copy' }, [t(state, 'لا توجد عروض محفوظة.', 'No saved views yet.')]) : null,
    button({ label: t(state, 'حفظ العرض الحالي', 'Save current view'), act: 'open-dialog', arg: 'saved-inbox-view:create', variant: 'default', small: true }),
    live.selectedSavedViewId === null ? null : h('div', { class: 'inbox-saved-views__actions' }, [
      button({ label: t(state, 'تحديث', 'Update'), act: 'open-dialog', arg: 'saved-inbox-view:update', variant: 'ghost', small: true }),
      button({ label: t(state, 'حذف', 'Delete'), act: 'live-inbox-saved-view-retire', arg: live.selectedSavedViewId, variant: 'danger', small: true }),
    ]),
  ]);
}

/**
 * What the live connection is doing, in words. A stream that is not delivering
 * looks exactly like an inbox with nothing happening in it.
 */
function connectionNotice(state: AppState, live: LiveState): Child {
  const realtime = live.realtime;
  if (realtime.status === 'live') {
    return h('p', { class: 'realtime realtime--live', 'data-realtime': 'live' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'تحديث مباشر', 'Live'),
    ]);
  }
  if (realtime.status === 'stale') {
    return h('p', { class: 'realtime realtime--stale', 'data-realtime': 'stale', role: 'status' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'انقطع التحديث المباشر — جارٍ إعادة الاتصال', 'Live updates paused — reconnecting'),
    ]);
  }
  if (realtime.status === 'stopped') {
    return h('p', { class: 'realtime realtime--stopped', 'data-realtime': 'stopped', role: 'status' }, [
      h('span', { class: 'realtime__dot', 'aria-hidden': 'true' }),
      t(state, 'توقف التحديث المباشر لتغيّر صلاحياتك. حدّث الصفحة.', 'Live updates stopped because your access changed. Refresh.'),
    ]);
  }
  return null;
}

function queueList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.unassigned,
    {
      title: t(state, 'لا توجد محادثات بانتظار الاستلام', 'Nothing waiting to be claimed'),
      body: t(state, 'ستظهر هنا المحادثات الجديدة في صناديقك.', 'New conversations in your inboxes appear here.'),
    },
    (cards) => h('div', { class: 'convlist', role: 'list' }, cards.map((card) => queueRow(state, live, card))),
  );
}

function mineList(state: AppState, live: LiveState): Child {
  return listBody(
    state,
    live.conversations,
    {
      title: t(state, 'لا توجد محادثات مسندة إليك', 'Nothing assigned to you'),
      body: t(state, 'استلم محادثة من «غير مسندة» لتبدأ.', 'Claim one from Unassigned to start.'),
    },
    (rows) => h('div', { class: 'convlist', role: 'list' }, [
      ...rows.map((conversation) => conversationRow(state, live, conversation)),
      live.inboxNextCursor === null ? null : h('div', { class: 'inbox-more' }, [
        button({ label: t(state, 'تحميل المزيد', 'Load more'), act: 'live-inbox-load-more', variant: 'ghost', small: true, busy: live.busy === 'inbox-load-more' }),
      ]),
    ]),
  );
}

function listBody<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: { title: string; body: string },
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return skeleton(state, 6);
  }
  if (resource.status === 'error') {
    return errorState(state, resource.error, 'live-inbox-reload');
  }
  if (resource.value.length === 0) {
    return emptyState({ icon: 'inboxEmpty', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

/**
 * The cue a row carries for priority: nothing for ordinary work. A priority
 * this build has no word for is shown as itself rather than hidden.
 */
function priorityCue(state: AppState, priority: string): Child {
  return priority === 'normal' || priority === 'low' ? null : priorityBadge(state, priority);
}

/**
 * A queue card. Everything on it came from the server's projection; there is
 * no snippet because there is no snippet to render.
 */
function queueRow(state: AppState, live: LiveState, card: QueueCard): HTMLElement {
  return h('article', { class: 'convrow convrow--card', role: 'listitem', 'data-conversation': card.id }, [
    avatar({ initials: '', channel: card.channel }),
    h('div', { class: 'convrow__main' }, [
      h('div', { class: 'convrow__line' }, [
        h('span', { class: 'convrow__name' }, [isolated(card.maskedLabel)]),
        h('span', { class: 'convrow__time' }, [
          // A conversation opened by an outbound message has nobody waiting on
          // it, and the row says so rather than showing a made-up duration.
          card.waitingSinceAt === null
            ? t(state, 'لم ينتظر بعد', 'Not waiting')
            : relativeTime(card.waitingSinceAt, state.clock, state.lang),
        ]),
      ]),
      h('div', { class: 'convrow__line convrow__meta' }, [
        h('span', { class: 'convrow__where' }, [`${phrase(state, CHANNEL_NAMES, card.channel)} · ${card.inboxLabel}`]),
        priorityCue(state, card.priority),
      ]),
    ]),
    button({
      label: t(state, 'استلام', 'Claim'),
      act: 'live-inbox-claim',
      // The version travels with the click, so the claim carries the version
      // this agent actually saw (IAM-13).
      arg: `${card.id}:${String(card.version)}`,
      small: true,
      busy: live.busy === `claim:${card.id}`,
      disabled: !card.claimable,
      extraClass: 'convrow__claim',
    }),
  ]);
}

function conversationRow(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  const open = live.openConversationId === conversation.id;
  // `unread` is this caller's own bookkeeping. A row with no answer is not
  // marked: absent is not the same as read.
  const unread = conversation.unread === true;
  return h(
    'button',
    {
      type: 'button',
      class: unread ? 'convrow convrow--record convrow--unread' : 'convrow convrow--record',
      role: 'listitem',
      'data-act': 'live-inbox-open',
      'data-arg': conversation.id,
      'data-conversation': conversation.id,
      'aria-current': open ? 'true' : 'false',
    },
    [
      avatar({ initials: initials(conversation.peerIdentity), channel: conversation.channel }),
      h('span', { class: 'convrow__main' }, [
        h('span', { class: 'convrow__line' }, [
          h('span', { class: 'convrow__name' }, [isolated(conversation.peerIdentity)]),
          h('span', { class: 'convrow__time' }, [relativeTime(conversation.lastActivityAt, state.clock, state.lang)]),
        ]),
        h('span', { class: 'convrow__line convrow__meta' }, [
          h('span', { class: 'convrow__where' }, [`${phrase(state, CHANNEL_NAMES, conversation.channel)} · ${conversation.inboxLabel}`]),
          conversation.status === 'open' ? null : statusBadge(state, conversation.status),
          priorityCue(state, conversation.priority),
          unread
            ? h('span', { class: 'convrow__dot' }, [h('span', { class: 'visually-hidden' }, [t(state, 'غير مقروءة', 'Unread')])])
            : null,
        ]),
      ]),
    ],
  );
}

/* ----------------------------------------------------------------- thread -- */

function threadZone(state: AppState, children: readonly Child[]): HTMLElement {
  return h('section', { class: 'zone zone--thread thread', 'aria-label': t(state, 'المحادثة', 'Conversation') }, children);
}

function listToggle(state: AppState): HTMLElement {
  return button({
    icon: 'inbox',
    act: 'list',
    variant: 'ghost',
    small: true,
    expanded: state.listOpen,
    title: t(state, 'قائمة المحادثات', 'Conversation list'),
    extraClass: 'thread__listtoggle',
  });
}

function renderThreadZone(state: AppState, live: LiveState): HTMLElement {
  if (live.openConversationId === null) {
    return threadZone(state, [
      h('div', { class: 'thread__placeholder' }, [
        emptyState({
          icon: 'chat',
          title: t(state, 'اختر محادثة', 'Choose a conversation'),
          body: t(state, 'افتح محادثة من القائمة لقراءة سجلها والرد عليها.', 'Open one from the list to read its history and reply.'),
          action: { label: t(state, 'عرض المحادثات', 'Show conversations'), act: 'list' },
        }),
      ]),
    ]);
  }
  if (live.openConversation.status === 'error') {
    return threadZone(state, [
      h('div', { class: 'thread__placeholder' }, [
        // A permission loss here is a normal outcome of routing — a handoff or
        // a reassignment moves a conversation away — so it is named as such.
        live.lostAccess && isDenial(live.openConversation.error)
          ? movedAway(state)
          : errorState(state, live.openConversation.error, 'live-inbox-reload'),
      ]),
    ]);
  }
  if (live.openConversation.status !== 'ready') {
    return threadZone(state, [h('div', { class: 'thread__placeholder' }, [skeleton(state, 4)])]);
  }

  const conversation = live.openConversation.value;
  const supervisorMode = live.supervisorAgentId !== null;
  return threadZone(state, [
    threadHeader(state, live, conversation, supervisorMode),
    supervisorMode ? null : lifecycleForm(state, live, conversation),
    lifecycleNotice(state, conversation),
    timelineView(state, live),
    // An archived conversation is immutable, so it gets no composer. The notice
    // above says why; a disabled box would say only that something is wrong.
    conversation.status === 'archived' || supervisorMode ? null : composer(state, live, conversation),
  ]);
}

function threadHeader(state: AppState, live: LiveState, conversation: Conversation, supervisorMode: boolean): HTMLElement {
  return h('header', { class: 'thread__header' }, [
    listToggle(state),
    avatar({ initials: initials(conversation.peerIdentity), channel: conversation.channel }),
    h('div', { class: 'thread__names' }, [
      h('h2', { class: 'thread__name' }, [isolated(conversation.peerIdentity)]),
      h('p', { class: 'thread__sub' }, [
        `${phrase(state, CHANNEL_NAMES, conversation.channel)} · ${conversation.inboxLabel}`,
      ]),
    ]),
    h('div', { class: 'thread__badges' }, [
      statusBadge(state, conversation.status),
      conversation.priority === 'normal' ? null : priorityBadge(state, conversation.priority),
    ]),
    h('div', { class: 'thread__toolbar' }, [
      supervisorMode ? h('span', { class: 'badge badge--neutral' }, [t(state, 'قراءة فقط', 'Read-only')]) : lifecycleControls(state, live, conversation),
      button({
        icon: 'panel',
        act: 'panel',
        variant: 'ghost',
        small: true,
        pressed: state.panelOpen,
        title: t(state, 'تفاصيل العميل', 'Customer details'),
        extraClass: 'thread__paneltoggle thread__paneltoggle--inline',
      }),
      button({
        icon: 'panel',
        act: 'panel-drawer',
        variant: 'ghost',
        small: true,
        expanded: state.panelDrawer,
        title: t(state, 'تفاصيل العميل', 'Customer details'),
        extraClass: 'thread__paneltoggle thread__paneltoggle--drawer',
      }),
    ]),
  ]);
}

function timelineView(state: AppState, live: LiveState): Child {
  const timeline = live.timeline;
  if (timeline.status === 'idle' || timeline.status === 'loading') {
    return h('div', { class: 'thread__body' }, [skeleton(state, 4)]);
  }
  if (timeline.status === 'error') {
    return h('div', { class: 'thread__body' }, [errorState(state, timeline.error, 'live-inbox-reload')]);
  }
  if (timeline.value.length === 0) {
    return h('div', { class: 'thread__body' }, [
      emptyState({
        icon: 'chat',
        title: t(state, 'لا توجد رسائل بعد', 'No messages yet'),
        body: t(state, 'ستظهر الرسائل هنا فور وصولها.', 'Messages appear here as they arrive.'),
      }),
    ]);
  }
  const items: Child[] = [];
  let lastDay = '';
  for (const message of timeline.value) {
    const day = dayLabel(message.at, state.clock, state.lang);
    if (day !== lastDay) {
      items.push(h('div', { class: 'daysep', role: 'separator' }, [h('span', {}, [day])]));
      lastDay = day;
    }
    items.push(messageBubble(state, message));
  }
  return h(
    'div',
    {
      class: 'thread__body',
      // A scrollable region has to be reachable by keyboard, and a conversation
      // that grows while it is on screen is a log.
      role: 'log',
      tabindex: '0',
      'data-scroll': 'timeline',
      'aria-label': t(state, 'سجل المحادثة', 'Conversation log'),
    },
    [
      live.timelineCursor === null
        ? null
        : h('div', { class: 'thread__older' }, [
            button({
              label: t(state, 'تحميل الرسائل الأقدم', 'Load older messages'),
              act: 'live-inbox-older',
              small: true,
              variant: 'ghost',
              busy: live.busy === 'load-older',
            }),
          ]),
      ...items,
    ],
  );
}

function messageBubble(state: AppState, message: TimelineMessage): HTMLElement {
  return h('article', { class: message.direction === 'out' ? 'msg msg--out' : 'msg msg--in', 'data-message': message.id }, [
    message.template_name === undefined || message.template_name === null ? null : h('div', { class: 'msg__template-label' }, [t(state, `قالب واتساب · ${message.template_name}`, `WhatsApp template · ${message.template_name}`)]),
    h('div', { class: 'msg__bubble' }, [message.template_preview ?? message.text ?? '']),
    h('div', { class: 'msg__meta' }, [
      h('time', { datetime: message.at }, [clockTime(message.at, state.lang)]),
      ...deliveryNote(state, message),
    ]),
  ]);
}

/**
 * What we know about an outbound message, said plainly.
 *
 * Two facts, not one: what we asked the provider to do and what it later said
 * happened. A screen that folded them into a single tick would be inventing
 * agreement between two things that can genuinely disagree.
 */
function deliveryNote(state: AppState, message: TimelineMessage): readonly Child[] {
  if (message.direction === 'in') {
    return [];
  }
  const parts: Child[] = [];
  if (message.command_state !== null) {
    parts.push(h('span', { class: `msg__state msg__state--${message.command_state}` }, [phrase(state, COMMAND_LABEL, message.command_state)]));
  }
  if (message.delivery_state !== null) {
    parts.push(
      h('span', { class: `msg__delivery msg__delivery--${message.delivery_state}` }, [
        icon(message.delivery_state === 'sent' ? 'check' : 'checkDouble', 14),
        phrase(state, DELIVERY_LABEL, message.delivery_state),
      ]),
    );
  }
  if (message.delivery_anomaly !== null) {
    // Recorded rather than smoothed over: a receipt disagreeing with an earlier
    // one is a fact worth showing the person who has to explain it.
    parts.push(
      h('span', { class: 'msg__anomaly', title: message.delivery_anomaly }, [
        t(state, 'إيصالات متعارضة', 'Conflicting receipts'),
      ]),
    );
  }
  return parts;
}

/* --------------------------------------------------------------- composer -- */

/**
 * The composer, with the reply and the private note as two separate tabs.
 *
 * Separate drafts, separate controls and a different surface, because one field
 * that sends to two places is how an internal remark reaches a customer.
 */
function composer(state: AppState, live: LiveState, conversation: Conversation): HTMLElement {
  const mode = state.composerTab;
  const tabs = h('div', { class: 'composer__tabs', role: 'tablist', 'aria-label': t(state, 'نوع الرسالة', 'Message type') }, [
    composerTab(state, 'reply', t(state, 'رد', 'Reply'), 'reply'),
    composerTab(state, 'note', t(state, 'ملاحظة داخلية', 'Private note'), 'note'),
  ]);
  return h('div', { class: `composer composer--${mode}` }, [
    h('div', { class: 'composer__panel', role: 'tabpanel', id: 'composer-panel', 'aria-labelledby': `composer-tab-${mode}` }, [
      mode === 'note' ? noteComposer(state, live, tabs) : replyComposer(state, live, conversation, tabs),
    ]),
  ]);
}

function composerTab(state: AppState, value: 'reply' | 'note', label: string, iconName: 'reply' | 'note'): HTMLElement {
  const selected = state.composerTab === value;
  return h(
    'button',
    {
      type: 'button',
      class: 'composer__tab',
      role: 'tab',
      id: `composer-tab-${value}`,
      'aria-selected': String(selected),
      'aria-controls': 'composer-panel',
      tabindex: selected ? '0' : '-1',
      'data-act': 'composer-tab',
      'data-arg': value,
    },
    [icon(iconName, 14), label],
  );
}

/**
 * The reply box, present only when the caller may actually send. An unclaimed
 * conversation gets a Claim button instead: it is not that replying is
 * unavailable, it is that the conversation is not this agent's yet.
 */
function replyComposer(state: AppState, live: LiveState, conversation: Conversation, tabs: HTMLElement): HTMLElement {
  if (conversation.assigneeMembershipId === null) {
    return h('div', { class: 'composer__toolbar composer__toolbar--claim' }, [
      tabs,
      h('p', { class: 'composer__blocked' }, [
        t(state, 'استلم المحادثة لتتمكن من الرد.', 'Claim the conversation to reply.'),
      ]),
      button({
        label: t(state, 'استلام', 'Claim'),
        act: 'live-inbox-claim',
        arg: `${conversation.id}:${String(conversation.version)}`,
        variant: 'primary',
        small: true,
        busy: live.busy === `claim:${conversation.id}`,
      }),
    ]);
  }
  // Fail closed if the server could not determine the WhatsApp window. Sending
  // free-form text is only legal when current conversation evidence says open.
  if (conversation.channel === 'whatsapp' && conversation.serviceWindow?.status !== 'open') {
    const unknown = conversation.serviceWindow?.status === 'unknown' || conversation.serviceWindow === undefined;
    return h('div', { class: 'composer__closed-window' }, [
      tabs,
      h('div', { class: 'composer__closed-window-copy', role: 'status', 'aria-live': 'polite' }, [
        h('strong', {}, [unknown
          ? t(state, 'تعذّر التحقق من نافذة خدمة واتساب', 'We cannot verify an active WhatsApp customer service window')
          : t(state, 'انتهت نافذة المحادثة لمدة 24 ساعة', '24-hour messaging window closed')]),
        h('p', {}, [t(state, 'استخدم قالبًا معتمدًا لمتابعة المحادثة.', 'Use an approved template to continue this conversation.')]),
      ]),
      whatsappTemplateButton(state, live, conversation.id, conversation.connectionId),
    ]);
  }
  return h('div', { class: 'composer__box' }, [
    // The text is the element's **content**, not a `value` attribute: a textarea
    // ignores that attribute, so rendering it that way would empty the composer
    // on every re-render — and a realtime event mid-sentence is a re-render.
    h(
      'textarea',
      {
        class: 'composer__input',
        rows: '1',
        dir: 'auto',
        'data-act': 'live-composer',
        'data-enables': 'live-inbox-send',
        'aria-label': t(state, 'نص الرد', 'Reply text'),
        placeholder: t(state, 'اكتب ردًا للعميل…', 'Write a reply to the customer…'),
      },
      [live.composer],
    ),
    h('div', { class: 'composer__toolbar' }, [
      tabs,
      live.error === null
        ? h('span', { class: 'composer__hint' }, [t(state, 'يُرسل إلى العميل عبر القناة', 'Sent to the customer on this channel')])
        : h('span', { class: 'composer__hint composer__hint--error', role: 'alert' }, [live.error.message]),
      button({
        label: t(state, 'إرسال', 'Send'),
        icon: 'send',
        act: 'live-inbox-send',
        variant: 'primary',
        small: true,
        busy: live.busy === 'send-reply',
        disabled: live.composer.trim() === '',
      }),
      whatsappTemplateButton(state, live, conversation.id, conversation.connectionId),
    ]),
  ]);
}

function whatsappTemplateButton(state: AppState, live: LiveState, conversationId: string, connectionId: string): HTMLElement | null {
  const connection = live.connections.status === 'ready' ? live.connections.value.find((item) => item.id === connectionId) : undefined;
  if (connection?.kind !== 'whatsapp' || !connection.capabilities.templates) return null;
  return button({ label: t(state, 'قوالب واتساب', 'WhatsApp Templates'), icon: 'chat', act: 'live-whatsapp-template-open', arg: conversationId, variant: 'default', small: true });
}

function noteComposer(state: AppState, live: LiveState, tabs: HTMLElement): HTMLElement {
  // The composer is only drawn beside an open conversation.
  const busy = live.busy === `note:${String(live.openConversationId)}`;
  return h('div', { class: 'composer__box composer__box--note' }, [
    h(
      'textarea',
      {
        class: 'composer__input composer__input--note',
        rows: '1',
        dir: 'auto',
        maxlength: '4000',
        'data-act': 'live-note-draft',
        'data-enables': 'live-note-add',
        'aria-label': t(state, 'ملاحظة داخلية جديدة', 'New private note'),
        placeholder: t(state, 'ملاحظة لفريقك — لا يراها العميل', 'A note for your team — the customer never sees it'),
      },
      [live.noteDraft],
    ),
    h('div', { class: 'composer__toolbar' }, [
      tabs,
      h('span', { class: 'composer__hint' }, [icon('lock', 14), t(state, 'مرئية لفريقك فقط', 'Visible to your team only')]),
      button({
        label: t(state, 'إضافة ملاحظة', 'Add note'),
        act: 'live-note-add',
        small: true,
        busy,
        disabled: live.noteDraft.trim() === '',
      }),
    ]),
  ]);
}
