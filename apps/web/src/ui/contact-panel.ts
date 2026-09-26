import type { ApiError } from '../api/client.js';
import type { ConsentRecord, Contact, ContactIdentity } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber, initials, relativeTime } from '../format.js';
import { contactNameField } from '../live/dispatch.js';
import { hasPermission } from '../live/ability.js';
import { rowsOf } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { CHANNEL_NAMES, phrase, t } from './copy.js';
import type { Phrase } from './copy.js';
import { metadataSection } from './metadata-section.js';
import { channelMark } from './channel-mark.js';
import { avatar, badge, button, emptyState, errorState, isolated, sectionTitle, selectControl, skeleton } from './parts.js';
import type { Tone } from './parts.js';

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
 *
 * Laid out as a profile rather than a form: a brand hero with who they are and
 * where they can be reached, four facts at a glance, then one card per
 * concern. The Contacts screen sets the cards in two columns; the narrow panel
 * beside a conversation stacks them.
 */
export function contactBody(state: AppState, contact: Contact, live: LiveState, where: 'panel' | 'screen'): HTMLElement {
  const busy = live.busy === `contact:${contact.id}`;
  const liveIdentities = contact.identities.filter((identity) => identity.validTo === null);
  return h('div', { class: `contact contact--${where}`, 'data-contact': contact.id }, [
    h('section', { class: 'contact__who', 'aria-label': t(state, 'ملف العميل', 'Customer profile') }, [
      h('div', { class: 'contact__hero' }, [
        avatar({ initials: initials(contact.displayName), size: 'xl', seed: contact.displayName }),
        h('div', { class: 'contact__hero-copy' }, [
          h('p', { class: 'contact__eyebrow' }, [t(state, 'ملف العميل', 'Customer profile')]),
          h('p', { class: 'contact__name' }, [isolated(contact.displayName)]),
          liveIdentities.length === 0
            ? h('p', { class: 'contact__sub' }, [t(state, 'لا توجد هوية سارية', 'No live identity')])
            : h('ul', { class: 'contact__reach', 'aria-label': t(state, 'متاح على', 'Reachable on') }, liveIdentities.map((identity) =>
                h('li', { class: 'contact__reach-chip' }, [
                  h('span', { class: `contact__reach-mark channel-tile--${identity.kind}`, 'aria-hidden': 'true' }, [channelMark(identity.kind, 12)]),
                  phrase(state, CHANNEL_NAMES, identity.kind),
                ]),
              )),
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
    ]),

    profileFacts(state, contact, liveIdentities.length),

    h('div', { class: 'contact__cards' }, [
      h('section', { class: 'panel-section contact__card contact__details', 'aria-labelledby': `details-${where}` }, [
        sectionTitle('user', 'blue', t(state, 'بيانات العميل', 'Profile details'), `details-${where}`),
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

      h('section', { class: 'panel-section contact__card contact__channels', 'aria-labelledby': `identities-${where}` }, [
        sectionTitle('link', 'cyan', t(state, 'طرق التواصل', 'Contact methods'), `identities-${where}`),
        contact.identities.length === 0
          ? h('p', { class: 'field__hint' }, [t(state, 'لا توجد هويات مسجلة.', 'No identities recorded.')])
          : h('ul', { class: 'contact__identities' }, contact.identities.map((identity) => identityRow(state, identity))),
        hasPermission(live, 'contact.edit') ? addChannel(state, live, contact) : null,
      ]),

      consentSection(state, contact, live, where),

      metadataSection(state, live, 'contact', contact),
    ]),
  ]);
}

/**
 * Four facts, read before any card: how many ways to reach them, whether a
 * campaign may reach them, how they are labelled and how long they have been a
 * customer. The consent fact follows the same order of authority as the panel:
 * an opt-out anywhere outranks a recorded grant.
 */
function profileFacts(state: AppState, contact: Contact, reachable: number): HTMLElement {
  const marketing = contact.consent.find((record) => record.purpose === 'marketing');
  // Broadcasts reach everyone who has not said no.
  const [consentLabel, consentTone]: readonly [string, Tone] = contact.suppressed.length > 0
    ? [t(state, 'ألغى الاشتراك', 'Opted out'), 'danger']
    : marketing?.state === 'withdrawn'
      ? [t(state, 'سحب موافقته', 'Withdrew'), 'warning']
      : [t(state, 'يستلم', 'Receives'), 'success'];
  const since = dateFormat(state.lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(contact.createdAt));
  return h('dl', { class: 'contact__facts' }, [
    fact('blue', t(state, 'وسائل سارية', 'Live channels'), formatNumber(reachable, state.lang)),
    fact(consentTone, t(state, 'البث', 'Broadcasts'), consentLabel),
    fact('violet', t(state, 'التصنيفات', 'Labels'), formatNumber(contact.labels.length, state.lang)),
    fact('neutral', t(state, 'عميل منذ', 'Customer since'), since),
  ]);
}

/** Attaching one more channel: until the channels are read, a way to read them. */
function addChannel(state: AppState, live: LiveState, contact: Contact): HTMLElement {
  const connections = rowsOf(live.connections).filter((connection) => connection.disconnected_at === null);
  if (connections.length === 0) {
    return live.connections.status === 'ready'
      ? h('p', { class: 'field__hint' }, [t(state, 'لا توجد قناة متصلة لإضافتها.', 'No connected channel to add.')])
      : button({ label: t(state, 'إضافة قناة', 'Add a channel'), icon: 'plus', act: 'live-contact-connections', small: true, variant: 'ghost', busy: live.connections.status === 'loading' });
  }
  const connectionKey = `contactIdentityConnection_${contact.id}`;
  const externalKey = `contactIdentityExternal_${contact.id}`;
  return h('div', { class: 'contact__add-channel' }, [
    selectControl({
      form: connectionKey,
      value: state.dialogForm[connectionKey] ?? '',
      ariaLabel: t(state, 'القناة', 'Channel'),
      options: [
        { value: '', label: t(state, 'أضف قناة…', 'Add a channel…') },
        ...connections.map((connection) => ({ value: connection.id, label: `${phrase(state, CHANNEL_NAMES, connection.kind)} · ${connection.display_name}` })),
      ],
    }),
    h('input', {
      class: 'input',
      dir: 'ltr',
      value: state.dialogForm[externalKey] ?? '',
      placeholder: t(state, 'معرّف العميل عليها', 'Their ID on it'),
      'aria-label': t(state, 'معرّف العميل على القناة', 'Customer channel ID'),
      'data-act': 'form',
      'data-form': externalKey,
    }),
    button({ label: t(state, 'إضافة', 'Add'), act: 'live-contact-identity-add', arg: contact.id, small: true, busy: live.busy === `contact-identity:${contact.id}` }),
  ]);
}

function fact(tone: Tone | 'blue' | 'violet', label: string, value: string): HTMLElement {
  return h('div', { class: `contact__fact contact__fact--${tone}` }, [
    h('dt', { class: 'contact__fact-label' }, [label]),
    h('dd', { class: 'contact__fact-value' }, [value]),
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
  return h('li', { class: `contact__identity${identity.validTo === null ? '' : ' contact__identity--ended'}` }, [
    h('span', { class: 'contact__identitykind' }, [
      h('span', { class: `contact__identitymark channel-tile--${identity.kind}`, 'aria-hidden': 'true' }, [channelMark(identity.kind, 14)]),
      phrase(state, CHANNEL_NAMES, identity.kind),
    ]),
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
  return h('section', { class: 'panel-section contact__card contact__consent', 'aria-labelledby': `consent-${where}` }, [
    sectionTitle('shield', 'green', t(state, 'الموافقة', 'Consent'), `consent-${where}`),
    // One row per purpose, marketing first: it is the one a campaign needs,
    // and a service consent never lets a campaign through.
    h('div', { class: 'consent__purposes' }, (['marketing', 'service'] as const).map((purpose) => {
      const latest = contact.consent.find((record) => record.purpose === purpose)?.state;
      return h('div', { class: `consent__purpose consent__purpose--${latest ?? 'none'}` }, [
        h('div', { class: 'consent__purpose-text' }, [
          h('strong', {}, [purpose === 'marketing' ? t(state, 'رسائل تسويقية', 'Marketing messages') : t(state, 'رسائل الخدمة', 'Service messages')]),
          h('span', {}, [purpose === 'marketing' ? t(state, 'الانسحاب يوقف البث إليه', 'A withdrawal stops broadcasts to them') : t(state, 'الردود والتحديثات', 'Replies and updates')]),
        ]),
        latest === undefined
          ? badge(t(state, 'غير مسجلة', 'Not recorded'), 'neutral')
          : badge(latest === 'granted' ? t(state, 'موافقة', 'Granted') : t(state, 'انسحاب', 'Withdrawn'), latest === 'granted' ? 'success' : 'warning', { dot: true }),
        h('div', { class: 'consent__actions' }, [
          button({ label: t(state, 'تسجيل موافقة', 'Record consent'), act: `live-consent-${where}`, arg: `${contact.id}:${purpose}:granted`, small: true, variant: latest === 'granted' ? 'default' : 'primary', disabled: busy }),
          button({ label: t(state, 'تسجيل انسحاب', 'Record withdrawal'), act: `live-consent-${where}`, arg: `${contact.id}:${purpose}:withdrawn`, small: true, variant: 'ghost', disabled: busy }),
        ]),
      ]);
    })),
    contact.consent.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا يوجد سجل موافقة.', 'No consent recorded.')])
      : h('ul', { class: 'consent__list', 'aria-label': t(state, 'سجل الموافقات', 'Consent history') }, contact.consent.map((record) => consentRow(state, record))),
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
