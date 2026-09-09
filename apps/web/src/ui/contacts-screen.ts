import type { ContactSummary } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { contactBody, contactError, labelFor } from './contact-panel.js';
import { button, isolated, pill, stateBox, textInput } from './parts.js';

/**
 * The Contacts directory.
 *
 * A list, a search over display names, and one record at a time. What is
 * deliberately absent is as much of the design as what is here:
 *
 * - **No "new contact".** A contact exists because somebody wrote to us. A form
 *   that made one from a typed-in phone number would be an identity claim
 *   nobody verified.
 * - **No merge.** Whether two identities are one person is a reviewed decision
 *   with an audit trail, and neither exists yet. An unreviewable merge button
 *   would be worse than none.
 * - **No search by number.** Matching on a similar identity is the inference
 *   the model refuses; the search is over the name a human wrote.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

const CHANNEL_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  messenger: { ar: 'ماسنجر', en: 'Messenger' },
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  web_chat: { ar: 'محادثة الموقع', en: 'Website chat' },
  custom: { ar: 'قناة مخصّصة', en: 'Custom channel' },
};

export function renderContacts(state: AppState): HTMLElement {
  const live = state.live;

  if (live.session.status !== 'signed_in') {
    return frame(state, [
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'تحتاج جلسة', 'You need a session'),
        body: t(
          state,
          'شاشة جهات الاتصال تقرأ من الخادم. سجّل الدخول للمتابعة.',
          'The Contacts screen reads from the server. Sign in to continue.',
        ),
        actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
        act: 'live-contacts-reload',
      }),
    ]);
  }
  if (live.session.tenantId === null) {
    return frame(state, [
      stateBox({
        kind: 'info',
        iconName: 'users',
        title: t(state, 'لا توجد عضوية نشطة', 'No active membership'),
        body: t(
          state,
          'حسابك لا ينتمي إلى شركة نشطة، فلا توجد جهات اتصال لعرضها.',
          'Your account does not belong to an active company, so there are no contacts to show.',
        ),
      }),
    ]);
  }

  return frame(state, [
    h('section', { class: 'card', 'aria-label': t(state, 'بحث', 'Search') }, [
      h('div', { class: 'card__header' }, [
        h('h2', { class: 'card__title' }, [t(state, 'ابحث بالاسم', 'Search by name')]),
      ]),
      h('div', { class: 'formrow' }, [
        textInput(
          'contactQuery',
          live.contactQuery,
          t(state, 'اسم جهة الاتصال', 'A contact’s name'),
        ),
        button({
          label: t(state, 'بحث', 'Search'),
          act: 'live-contacts-search',
          disabled: live.busy !== null,
        }),
      ]),
      h('p', { class: 'field__hint' }, [
        t(
          state,
          'البحث على الاسم الذي كتبه إنسان. لا بحث بالرقم: مطابقة رقم مشابه استنتاج للهوية، وهو ما يرفضه النموذج.',
          'The search is over the name a human wrote. There is no search by number: matching a similar one would be an identity inference the model refuses.',
        ),
      ]),
    ]),

    h('div', { class: 'contacts' }, [
      h('section', { class: 'card', 'aria-label': t(state, 'جهات الاتصال', 'Contacts') }, [
        listBody(state, live),
      ]),
      h('section', { class: 'card', 'aria-label': t(state, 'السجل', 'The record') }, [
        selectedBody(state, live),
      ]),
    ]),
  ]);
}

function frame(state: AppState, children: readonly Child[]): HTMLElement {
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    h('div', { class: 'workspace__intro' }, [
      h('div', { class: 'workspace__introtext' }, [
        h('h1', { class: 'workspace__heading' }, [t(state, 'جهات الاتصال', 'Contacts')]),
        h('p', { class: 'workspace__lede' }, [
          t(
            state,
            'كل جهة اتصال نشأت لأن أحدهم راسلنا. الهوية مرتبطة بالقناة التي وصلت منها، ولا تُدمج هويتان تلقائيًا مهما تشابهتا.',
            'Every contact exists because somebody wrote to us. An identity belongs to the channel it arrived on, and two identities are never merged automatically however alike they look.',
          ),
        ]),
      ]),
    ]),
    ...children,
  ]);
}

function listBody(state: AppState, live: LiveState): Child {
  return resourceView(state, live.contacts, (contacts) =>
    h(
      'ul',
      { class: 'contactlist' },
      contacts.map((contact) => contactRow(state, contact, live.selectedContactId === contact.id)),
    ),
  );
}

function contactRow(state: AppState, contact: ContactSummary, selected: boolean): HTMLElement {
  const live = contact.identities.filter((identity) => identity.validTo === null);
  return h('li', {}, [
    h(
      'button',
      {
        type: 'button',
        class: 'contactrow',
        'data-act': 'live-contact-open',
        'data-arg': contact.id,
        'aria-current': selected ? 'true' : 'false',
      },
      [
        h('span', { class: 'contactrow__name' }, [isolated(contact.displayName)]),
        h(
          'span',
          { class: 'contactrow__channels' },
          live.length === 0
            ? [pill(t(state, 'لا هوية سارية', 'No live identity'), 'neutral')]
            : live.map((identity) => pill(labelFor(state, CHANNEL_LABEL, identity.kind))),
        ),
      ],
    ),
  ]);
}

function selectedBody(state: AppState, live: LiveState): Child {
  if (live.selectedContactId === null) {
    return stateBox({
      kind: 'empty',
      iconName: 'users',
      title: t(state, 'اختر جهة اتصال', 'Pick a contact'),
      body: t(
        state,
        'اختر واحدة من القائمة لقراءة هوياتها وسجل موافقاتها.',
        'Choose one from the list to read its identities and its consent history.',
      ),
    });
  }
  if (live.selectedContact.status === 'error') {
    return contactError(state, live.selectedContact.error);
  }
  if (live.selectedContact.status !== 'ready') {
    return busy(state);
  }
  return contactBody(state, live.selectedContact.value, live, 'screen');
}

/**
 * The one place a list decides which of its five states it is in.
 *
 * The rows are handed to `render` rather than re-read from the resource, so
 * there is no second, weaker status check that could disagree with this one.
 */
function resourceView<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return busy(state);
  }
  if (resource.status === 'error') {
    return contactError(state, resource.error, 'live-contacts-reload');
  }
  if (resource.value.length === 0) {
    return stateBox({
      kind: 'empty',
      iconName: 'users',
      title: t(state, 'لا جهات اتصال', 'No contacts'),
      body: t(
        state,
        'ستظهر هنا أول ما يراسلنا أحد.',
        'They appear here as soon as somebody writes to us.',
      ),
    });
  }
  return render(resource.value);
}

function busy(state: AppState): HTMLElement {
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
  ]);
}
