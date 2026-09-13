import type { ApiError } from '../api/client.js';
import type { ConsentRecord, Contact, ContactIdentity } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { initials, relativeTime } from '../format.js';
import { contactNameField } from '../live/dispatch.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import type { Phrase } from './copy.js';
import { metadataSection } from './metadata-section.js';
import { avatar, badge, button, emptyState, errorState, isolated, skeleton } from './parts.js';

/**
 * The customer beside the conversation.
 *
 * Three things, and the order is the argument:
 *
 * 1. **Who they are** — the display name an agent may correct, and the business
 *    fields the company keeps.
 * 2. **How we reach them** — every identity, each with the channel it belongs
 *    to and whether it is still live. The panel never implies that two
 *    identities are one person, because the server never claimed they were.
 * 3. **What they agreed to** — consent as a history, with any **opt-out shown
 *    above it**. An opt-out outranks any consent, and a green "opted in" over an
 *    opt-out would be the exact lie the model exists to prevent.
 */

const SOURCE_LABEL: Readonly<Record<string, Phrase>> = {
  customer_message: { ar: 'من رسالة العميل', en: 'From the customer' },
  agent_recorded: { ar: 'سجّلها موظف', en: 'Recorded by an agent' },
  import: { ar: 'استيراد', en: 'Import' },
  web_form: { ar: 'نموذج الموقع', en: 'Web form' },
};

const PURPOSE_LABEL: Readonly<Record<string, Phrase>> = {
  service: { ar: 'خدمة', en: 'Service' },
  marketing: { ar: 'تسويق', en: 'Marketing' },
};

/**
 * The panel beside the conversation.
 *
 * `extra` is what the inbox stacks under the customer — labels, assignment,
 * notes and episodes. They are facts about the *conversation*, not the person,
 * so they are passed in rather than read here.
 */
export function renderContactPanel(state: AppState, live: LiveState, extra: readonly Child[] = []): HTMLElement {
  return h('aside', { class: 'zone zone--panel', 'aria-label': t(state, 'تفاصيل العميل', 'Customer details') }, [
    h('header', { class: 'zone__header' }, [
      h('h2', { class: 'zone__title' }, [t(state, 'التفاصيل', 'Details')]),
      button({
        icon: 'close',
        act: 'close-overlays',
        arg: 'panel',
        variant: 'ghost',
        small: true,
        title: t(state, 'إخفاء التفاصيل', 'Hide details'),
      }),
    ]),
    h('div', { class: 'zone__body', 'data-scroll': 'panel' }, [panelBody(state, live.openContact, live), ...extra]),
  ]);
}

function panelBody(state: AppState, resource: Resource<Contact>, live: LiveState): Child {
  if (resource.status === 'idle') {
    return h('section', { class: 'panel-section' }, [
      emptyState({
        icon: 'user',
        title: t(state, 'لا يوجد سجل عميل بعد', 'No customer record yet'),
        body: t(state, 'يُنشأ السجل عند أول رسالة يرسلها العميل.', 'The record is created by the customer’s first message.'),
      }),
    ]);
  }
  if (resource.status === 'loading') {
    return h('section', { class: 'panel-section' }, [skeleton(state, 2)]);
  }
  if (resource.status === 'error') {
    return h('section', { class: 'panel-section' }, [contactError(state, resource.error)]);
  }
  return contactBody(state, resource.value, live, 'panel');
}

export function contactError(state: AppState, error: ApiError, retryAct?: string): HTMLElement {
  return errorState(state, error, retryAct);
}

/**
 * The contact itself, shared by the panel and the Contacts screen. `where`
 * distinguishes the two only for the action names, so a save from one cannot be
 * confused with a save from the other while both are on screen.
 */
export function contactBody(state: AppState, contact: Contact, live: LiveState, where: 'panel' | 'screen'): HTMLElement {
  const busy = live.busy === `contact:${contact.id}`;
  const liveIdentities = contact.identities.filter((identity) => identity.validTo === null);
  return h('div', { class: 'contact', 'data-contact': contact.id }, [
    h('section', { class: 'panel-section contact__who' }, [
      h('div', { class: 'contact__identity-head' }, [
        avatar({ initials: initials(contact.displayName), size: 'lg' }),
        h('div', {}, [
          h('p', { class: 'contact__name' }, [isolated(contact.displayName)]),
          h('p', { class: 'contact__sub' }, [
            liveIdentities.length === 0
              ? t(state, 'لا توجد هوية سارية', 'No live identity')
              : liveIdentities.map((identity) => phrase(state, CHANNEL_NAMES, identity.kind)).join(' · '),
          ]),
        ]),
      ]),
      contact.suppressed.length === 0
        ? null
        : h('p', { class: 'consent__suppressed', role: 'status' }, [
            t(
              state,
              `ألغى الاشتراك على ${contact.suppressed.map((channel) => phrase(state, CHANNEL_NAMES, channel)).join('، ')} — لا تُرسل له حملات حتى مع وجود موافقة.`,
              `Opted out on ${contact.suppressed.map((channel) => phrase(state, CHANNEL_NAMES, channel)).join(', ')} — no campaigns are sent, even where consent is recorded.`,
            ),
          ]),
      h('div', { class: 'inline-form' }, [
        h('label', { class: 'field' }, [
          h('span', { class: 'field__label' }, [t(state, 'الاسم المعروض', 'Display name')]),
          // The shared form action records it without a re-render: a name field
          // that redrew on every keystroke would move the caret.
          h('input', {
            class: 'input',
            type: 'text',
            'data-act': 'form',
            'data-form': contactNameField(contact.id),
            value: state.dialogForm[contactNameField(contact.id)] ?? contact.displayName,
          }),
        ]),
        button({ label: t(state, 'حفظ', 'Save'), act: `live-contact-save-${where}`, arg: contact.id, small: true, busy }),
      ]),
      attributeList(state, contact),
    ]),

    metadataSection(state, live, 'contact', contact),

    h('section', { class: 'panel-section', 'aria-labelledby': `identities-${where}` }, [
      h('h3', { class: 'panel-section__title', id: `identities-${where}` }, [t(state, 'قنوات التواصل', 'Channels')]),
      contact.identities.length === 0
        ? h('p', { class: 'field__hint' }, [t(state, 'لا توجد هويات مسجلة.', 'No identities recorded.')])
        : h('ul', { class: 'contact__identities' }, contact.identities.map((identity) => identityRow(state, identity))),
    ]),

    consentSection(state, contact, live, where),
  ]);
}

function attributeList(state: AppState, contact: Contact): Child {
  const entries = Object.entries(contact.attributes);
  if (entries.length === 0) {
    return null;
  }
  return h(
    'dl',
    { class: 'attrgrid' },
    entries.flatMap(([key, value]) => [
      h('dt', {}, [key]),
      h('dd', {}, [isolated(typeof value === 'string' ? value : JSON.stringify(value))]),
    ]),
  );
}

function identityRow(state: AppState, identity: ContactIdentity): HTMLElement {
  return h('li', { class: 'contact__identity' }, [
    h('span', { class: 'contact__identitykind' }, [phrase(state, CHANNEL_NAMES, identity.kind)]),
    h('span', { class: 'contact__identityvalue' }, [isolated(identity.externalId, true)]),
    identity.validTo === null
      ? badge(t(state, 'سارية', 'Live'), 'success', { dot: true })
      : // A closed interval is shown, not hidden: messages sent while it was
        // live belong to whoever held it then.
        badge(t(state, 'منتهية', 'Ended'), 'neutral'),
  ]);
}

function consentSection(state: AppState, contact: Contact, live: LiveState, where: 'panel' | 'screen'): HTMLElement {
  const busy = live.busy === `consent:${contact.id}`;
  return h('section', { class: 'panel-section', 'aria-labelledby': `consent-${where}` }, [
    h('h3', { class: 'panel-section__title', id: `consent-${where}` }, [t(state, 'الموافقة', 'Consent')]),
    contact.consent.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا يوجد سجل موافقة.', 'No consent recorded.')])
      : h('ul', { class: 'consent__list' }, contact.consent.map((record) => consentRow(state, record))),
    h('div', { class: 'consent__actions' }, [
      button({ label: t(state, 'تسجيل موافقة', 'Record consent'), act: `live-consent-${where}`, arg: `${contact.id}:granted`, small: true, disabled: busy }),
      button({ label: t(state, 'تسجيل انسحاب', 'Record withdrawal'), act: `live-consent-${where}`, arg: `${contact.id}:withdrawn`, small: true, variant: 'ghost', disabled: busy }),
    ]),
    h('p', { class: 'field__hint' }, [
      t(state, 'كل تسجيل يُضاف إلى السجل ولا يمحو ما قبله.', 'Each record is added to the history; nothing earlier is erased.'),
    ]),
  ]);
}

function consentRow(state: AppState, record: ConsentRecord): HTMLElement {
  return h('li', { class: 'consent__row' }, [
    badge(record.state === 'granted' ? t(state, 'موافقة', 'Granted') : t(state, 'انسحاب', 'Withdrawn'), record.state === 'granted' ? 'success' : 'warning'),
    h('span', { class: 'consent__what' }, [`${phrase(state, CHANNEL_NAMES, record.channel)} · ${phrase(state, PURPOSE_LABEL, record.purpose)}`]),
    h('span', { class: 'consent__source' }, [`${phrase(state, SOURCE_LABEL, record.source)} · ${relativeTime(record.recordedAt, state.clock, state.lang)}`]),
  ]);
}
