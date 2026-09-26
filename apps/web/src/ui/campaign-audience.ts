import type { AudiencePreview } from '../api/campaigns.js';
import { h } from '../dom.js';
import { formatNumber, initials } from '../format.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import type { AudienceSource } from '../live/audience.js';
import { AUDIENCE_SOURCES, editorAudience, filterFromConditions, previewKey, toggled } from '../live/audience.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import { avatar, button, isolated, sectionTitle, selectControl, textInput } from './parts.js';

/**
 * The audience block of the campaign editor.
 *
 * Five places the people can come from, one narrowing by name, and a count
 * the operator can ask for before creating anything. Campaigns only ever reach
 * contacts with a live identity on the channel who have not opted out or
 * withdrawn consent
 * opt-out, and the block says so up front rather than after a freeze comes
 * back smaller than expected.
 */

const SOURCES: Readonly<Record<AudienceSource, { readonly icon: IconName; readonly ar: readonly [string, string]; readonly en: readonly [string, string] }>> = {
  all: { icon: 'users', ar: ['كل جهات القناة', 'كل من يمكن مراسلته عليها'], en: ['Everyone on the channel', 'Every reachable contact'] },
  labels: { icon: 'tag', ar: ['تصنيفات العملاء', 'يحمل كل التصنيفات المختارة'], en: ['Contact labels', 'Has every chosen label'] },
  conversations: { icon: 'chat', ar: ['تصنيفات المحادثات', 'محادثة تحمل أيًا منها'], en: ['Conversation labels', 'A conversation has any of them'] },
  picked: { icon: 'userCheck', ar: ['اختيار يدوي', 'أشخاص تحددهم بنفسك'], en: ['Pick people', 'Contacts you choose'] },
  saved: { icon: 'bookmark', ar: ['جمهور محفوظ', 'جمهور أنشأته من قبل'], en: ['Saved audience', 'One you saved before'] },
};

export function audienceSection(state: AppState): HTMLElement {
  const { draft, filter, connectionId } = editorAudience(state);
  const live = state.live;
  // Built on its own, an audience narrows: "everyone" and "a saved one" are not new audiences.
  const standalone = state.dialog?.kind === 'audience-new';
  const sources = standalone ? AUDIENCE_SOURCES.filter((source) => source !== 'all' && source !== 'saved') : AUDIENCE_SOURCES;
  return h('section', { class: 'audience field--wide', 'aria-labelledby': 'campaign-audience-title' }, [
    h('div', { class: 'audience__head' }, [
      sectionTitle('users', 'blue', standalone ? t(state, 'من في هذا الجمهور؟', 'Who is in it?') : t(state, 'من سيستلم الحملة؟', 'Who receives it?'), 'campaign-audience-title'),
      h('p', { class: 'field__hint' }, [t(state,
        'تصل لكل من لديه هوية سارية على القناة، ما عدا من ألغى الاشتراك أو سحب موافقته.',
        'Everyone with a live identity on the channel receives it, except those who opted out or withdrew consent.')]),
    ]),
    h('div', { class: 'audience__sources', role: 'radiogroup', 'aria-label': t(state, 'مصدر الجمهور', 'Audience source') }, sources.map((source) => {
      const copy = SOURCES[source];
      const [title, body] = state.lang === 'ar' ? copy.ar : copy.en;
      const chosen = draft.source === source;
      return h('button', {
        type: 'button',
        class: 'audience-source',
        role: 'radio',
        'aria-checked': String(chosen),
        'data-act': 'live-campaign-audience-source',
        'data-arg': source,
      }, [
        h('span', { class: 'audience-source__icon', 'aria-hidden': 'true' }, [icon(copy.icon, 18)]),
        h('span', { class: 'audience-source__title' }, [title]),
        h('span', { class: 'audience-source__body' }, [body]),
      ]);
    })),
    sourcePanel(state, draft.source, draft),
    draft.source === 'saved'
      ? null
      : h('div', { class: 'field audience__search' }, [
          h('label', { class: 'field__label', for: 'campaign-search' }, [t(state, 'ضيّق بالاسم (اختياري)', 'Narrow by name (optional)')]),
          textInput('campaignSearch', draft.search, t(state, 'مثال: أحمد', 'e.g. Ahmed'), { id: 'campaign-search' }),
        ]),
    formError(state, 'campaignAudience'),
    previewBlock(state, filter === null || connectionId === '' ? null : previewKey(connectionId, filter)),
    draft.source === 'all' || draft.source === 'saved'
      ? null
      : h('div', { class: 'audience__save' }, [
          h('div', { class: 'field' }, [
            h('label', { class: 'field__label', for: 'campaign-audience-name' }, [t(state, 'احفظ هذا الجمهور لإعادة استخدامه', 'Save this audience for reuse')]),
            textInput('campaignAudienceName', state.dialogForm['campaignAudienceName'] ?? '', t(state, 'مثال: مهتمون بالكورسات', 'e.g. Interested in courses'), { id: 'campaign-audience-name' }),
            formError(state, 'campaignAudienceName'),
          ]),
          button({ label: t(state, 'حفظ الجمهور', 'Save audience'), icon: 'bookmark', act: 'live-campaign-audience-save', small: true, busy: live.busy === 'audience-save' }),
        ]),
  ]);
}

function formError(state: AppState, key: string): HTMLElement | null {
  const message = state.formErrors[key];
  return message === undefined ? null : h('p', { class: 'field__error', role: 'alert' }, [message]);
}

function sourcePanel(state: AppState, source: AudienceSource, draft: ReturnType<typeof editorAudience>['draft']): HTMLElement | null {
  if (source === 'labels') return labelPicker(state, 'campaignLabelIds', draft.labelIds);
  if (source === 'conversations') return labelPicker(state, 'campaignConversationLabelIds', draft.conversationLabelIds);
  if (source === 'picked') return contactPicker(state, draft.contactIds);
  if (source === 'saved') return savedPicker(state, draft.savedId);
  return null;
}

function labelPicker(state: AppState, key: string, chosen: readonly string[]): HTMLElement {
  const labels = state.live.labels;
  if (labels.status !== 'ready') {
    return h('p', { class: 'audience__panel field__hint', role: 'status' }, [labels.status === 'error'
      ? labels.error.message
      : t(state, 'جارٍ تحميل التصنيفات…', 'Loading labels…')]);
  }
  const active = labels.value.filter((label) => label.state === 'active');
  if (active.length === 0) {
    return h('p', { class: 'audience__panel field__hint' }, [t(state, 'لا توجد تصنيفات بعد. أنشئها من صفحة جهات الاتصال.', 'No labels yet. Create them on the Contacts screen.')]);
  }
  return h('div', { class: 'audience__panel audience__chips' }, active.map((label) => h('button', {
    type: 'button',
    class: 'audience-chip',
    style: `--label-color:${label.color}`,
    'aria-pressed': String(chosen.includes(label.id)),
    'data-act': 'form-toggle',
    'data-arg': `${key}:${toggled(chosen, label.id)}`,
  }, [
    h('span', { class: 'metadata__swatch', 'aria-hidden': 'true' }),
    isolated(label.name),
    chosen.includes(label.id) ? icon('check', 14) : null,
  ])));
}

function contactPicker(state: AppState, chosen: readonly string[]): HTMLElement {
  const contacts = state.live.contacts;
  const people = rowsOf(contacts);
  return h('div', { class: 'audience__panel audience__people' }, [
    h('div', { class: 'audience__people-bar' }, [
      h('div', { class: 'searchbar' }, [
        icon('search', 16),
        textInput('campaignContactQuery', state.dialogForm['campaignContactQuery'] ?? state.live.contactQuery, t(state, 'ابحث في جهات الاتصال', 'Search contacts'), { type: 'search', ariaLabel: t(state, 'ابحث في جهات الاتصال', 'Search contacts') }),
        button({ label: t(state, 'بحث', 'Search'), act: 'live-campaign-contact-search', small: true }),
      ]),
      h('span', { class: 'audience__count', role: 'status' }, [t(state, `${formatNumber(chosen.length, state.lang)} مختار`, `${formatNumber(chosen.length, state.lang)} picked`)]),
    ]),
    contacts.status === 'error'
      ? h('p', { class: 'field__hint' }, [contacts.error.message])
      : contacts.status !== 'ready'
        ? h('p', { class: 'field__hint', role: 'status' }, [t(state, 'جارٍ تحميل جهات الاتصال…', 'Loading contacts…')])
        : people.length === 0
          ? h('p', { class: 'field__hint' }, [t(state, 'لا توجد نتائج.', 'No matches.')])
          : h('ul', { class: 'audience__list' }, people.map((person) => {
              const picked = chosen.includes(person.id);
              const reach = person.identities.filter((identity) => identity.validTo === null).map((identity) => phrase(state, CHANNEL_NAMES, identity.kind));
              return h('li', {}, [h('button', {
                type: 'button',
                class: 'audience-person',
                'aria-pressed': String(picked),
                'data-act': 'form-toggle',
                'data-arg': `campaignContactIds:${toggled(chosen, person.id)}`,
              }, [
                avatar({ initials: initials(person.displayName), size: 'sm', seed: person.displayName }),
                h('span', { class: 'audience-person__text' }, [
                  h('span', { class: 'audience-person__name' }, [isolated(person.displayName)]),
                  h('span', { class: 'audience-person__meta' }, [reach.length === 0 ? t(state, 'لا توجد هوية سارية', 'No live identity') : reach.join(' · ')]),
                ]),
                h('span', { class: 'audience-person__tick', 'aria-hidden': 'true' }, [picked ? icon('check', 14) : null]),
              ])]);
            })),
  ]);
}

function savedPicker(state: AppState, savedId: string): HTMLElement {
  const audiences = state.live.audiences;
  if (audiences.status !== 'ready') {
    return h('p', { class: 'audience__panel field__hint', role: 'status' }, [audiences.status === 'error'
      ? audiences.error.message
      : t(state, 'جارٍ تحميل الجماهير المحفوظة…', 'Loading saved audiences…')]);
  }
  if (audiences.value.length === 0) {
    return h('p', { class: 'audience__panel field__hint' }, [t(state, 'لا يوجد جمهور محفوظ بعد. اختر مصدرًا آخر واحفظه من الأسفل.', 'No saved audiences yet. Build one with another source and save it below.')]);
  }
  return h('div', { class: 'audience__panel field' }, [
    h('label', { class: 'field__label', for: 'campaign-saved-audience' }, [t(state, 'الجمهور المحفوظ', 'Saved audience')]),
    selectControl({
      id: 'campaign-saved-audience',
      form: 'campaignSavedAudience',
      value: savedId,
      options: [
        { value: '', label: t(state, 'اختر جمهورًا', 'Choose an audience') },
        ...audiences.value.map((audience) => ({
          value: audience.id,
          label: filterFromConditions(audience.conditions) === null
            ? t(state, `${audience.name} (غير صالح للحملات)`, `${audience.name} (not usable in campaigns)`)
            : audience.name,
        })),
      ],
    }),
  ]);
}

/**
 * The count for the audience on screen. A count taken for another channel or
 * filter is not shown as if it described this one; the operator is told the
 * audience changed and asked to count again.
 */
function previewBlock(state: AppState, key: string | null): HTMLElement {
  const preview = state.live.audiencePreview;
  const current = preview !== null && preview.key === key ? preview.result : null;
  return h('div', { class: 'audience__preview', 'aria-live': 'polite' }, [
    button({
      label: t(state, 'احسب الجمهور', 'Check audience'),
      icon: 'users',
      act: 'live-campaign-audience-preview',
      small: true,
      busy: current?.status === 'loading',
    }),
    current === null
      ? h('p', { class: 'field__hint' }, [preview === null
          ? t(state, 'اعرف عدد من سيستلم الحملة قبل إنشائها.', 'See how many people it reaches before creating it.')
          : t(state, 'تغيّر الجمهور منذ آخر حساب. احسبه من جديد.', 'The audience changed since the last count. Check it again.')])
      : current.status === 'error'
        ? h('p', { class: 'field__error', role: 'alert' }, [current.error.message])
        : current.status === 'ready'
          ? previewResult(state, current.value)
          : null,
  ]);
}

function previewResult(state: AppState, value: AudiencePreview): HTMLElement {
  const n = (count: number): string => formatNumber(count, state.lang);
  return h('div', { class: 'audience-result' }, [
    h('div', { class: `audience-result__eligible${value.eligible === 0 ? ' audience-result__eligible--none' : ''}` }, [
      h('strong', {}, [n(value.eligible)]),
      h('span', {}, [t(state, 'سيستلمون الحملة', 'will receive it')]),
    ]),
    h('dl', { class: 'audience-result__facts' }, [
      h('div', {}, [h('dt', {}, [t(state, 'المطابقون', 'Matched')]), h('dd', {}, [n(value.total)])]),
      h('div', {}, [h('dt', {}, [t(state, 'سحبوا موافقتهم', 'Withdrew consent')]), h('dd', {}, [n(value.reasons.no_consent)])]),
      h('div', {}, [h('dt', {}, [t(state, 'ألغوا الاشتراك', 'Opted out')]), h('dd', {}, [n(value.reasons.suppressed)])]),
      h('div', {}, [h('dt', {}, [t(state, 'هوية منتهية', 'Inactive identity')]), h('dd', {}, [n(value.reasons.identity_inactive)])]),
    ]),
    value.sample.length === 0
      ? null
      : h('p', { class: 'audience-result__sample' }, [t(state, 'مثل: ', 'For example: '), isolated(value.sample.join(t(state, '، ', ', ')))]),
  ]);
}
