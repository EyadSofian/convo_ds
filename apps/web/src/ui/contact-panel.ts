import type { ApiError } from '../api/client.js';
import type { ConsentRecord, Contact, ContactIdentity } from '../api/contacts.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { relativeTime } from '../format.js';
import { contactNameField } from '../live/dispatch.js';
import { isDenial, isUnauthenticated } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { button, isolated, pill, stateBox } from './parts.js';
import type { Tone } from './parts.js';

/**
 * The customer beside the conversation.
 *
 * Three things, and the order is the argument:
 *
 * 1. **Who they are** — the display name an agent may correct, and the business
 *    fields the company keeps.
 * 2. **How we reach them** — every identity, each with the channel it belongs
 *    to and whether it is still live. A page-scoped id is shown as a
 *    page-scoped id; the panel never implies that two identities are one
 *    person, because the server never claimed they were.
 * 3. **What they agreed to** — consent as a history, newest first, with the
 *    **suppression shown above it**. A suppression outranks any consent, and a
 *    panel that showed a green "opted in" over an opt-out would be the exact
 *    lie the model exists to prevent.
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

const SOURCE_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  customer_message: { ar: 'رسالة من العميل', en: 'The customer wrote' },
  agent_recorded: { ar: 'سجّلها موظّف', en: 'Recorded by an agent' },
  import: { ar: 'استيراد', en: 'Import' },
  web_form: { ar: 'نموذج على الموقع', en: 'Web form' },
};

const PURPOSE_LABEL: Readonly<Record<string, { ar: string; en: string }>> = {
  service: { ar: 'خدمة', en: 'Service' },
  marketing: { ar: 'تسويق', en: 'Marketing' },
};

export function labelFor(
  state: AppState,
  table: Readonly<Record<string, { ar: string; en: string }>>,
  key: string,
): string {
  const entry = table[key];
  return entry === undefined ? key : t(state, entry.ar, entry.en);
}

/**
 * The panel beside the conversation.
 *
 * `extra` is what the inbox stacks under the customer — the internal notes and
 * the reporting episodes. They are passed in rather than imported here because
 * they are facts about the *conversation*, not about the person, and a customer
 * panel that reached for the open conversation's notes would be a second place
 * that decides which conversation is open.
 */
export function renderContactPanel(
  state: AppState,
  live: LiveState,
  extra: readonly Child[] = [],
): HTMLElement {
  return h(
    'aside',
    { class: 'zone zone--panel', 'aria-label': t(state, 'بيانات العميل', 'Customer details') },
    [h('div', { class: 'zone__body' }, [panelBody(state, live.openContact, live), ...extra])],
  );
}

function panelBody(state: AppState, resource: Resource<Contact>, live: LiveState): Child {
  if (resource.status === 'idle') {
    return stateBox({
      kind: 'empty',
      iconName: 'users',
      title: t(state, 'لا يوجد سجل عميل بعد', 'No customer record yet'),
      body: t(
        state,
        'يُنشأ السجل عند أول رسالة يرسلها العميل. محادثة بدأناها نحن لا تُنشئ سجلًا من رقم.',
        'The record is created by the customer’s first message. A conversation we started does not invent one from a number.',
      ),
    });
  }
  if (resource.status === 'loading') {
    return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
      h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
      h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
      h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
    ]);
  }
  if (resource.status === 'error') {
    return contactError(state, resource.error);
  }
  return contactBody(state, resource.value, live, 'panel');
}

export function contactError(state: AppState, error: ApiError, retryAct?: string): HTMLElement {
  if (isUnauthenticated(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'انتهت الجلسة', 'Your session ended'),
      body: t(state, 'سجّل الدخول من جديد للمتابعة.', 'Sign in again to continue.'),
    });
  }
  if (isDenial(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'غير مسموح', 'Not permitted'),
      body: t(
        state,
        'دورك لا يصل إلى بيانات هذا العميل.',
        'Your role does not reach this customer’s record.',
      ),
    });
  }
  return stateBox({
    kind: 'offline',
    iconName: 'refresh',
    title: t(state, 'تعذّر الوصول للخادم', 'The server could not be reached'),
    body: error.message,
    ...(retryAct === undefined
      ? {}
      : { actionLabel: t(state, 'إعادة المحاولة', 'Try again'), act: retryAct }),
  });
}

/**
 * The contact itself, shared by the panel and the Contacts screen.
 *
 * `where` distinguishes the two only for the action names, so a save from the
 * panel and a save from the screen cannot be confused with one another while
 * both are on screen.
 */
export function contactBody(
  state: AppState,
  contact: Contact,
  live: LiveState,
  where: 'panel' | 'screen',
): HTMLElement {
  const busy = live.busy === `contact:${contact.id}`;
  return h('div', { class: 'contact', 'data-contact': contact.id }, [
    h('section', { class: 'contact__section' }, [
      h('h3', { class: 'contact__heading' }, [t(state, 'من هو', 'Who they are')]),
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
          'aria-label': t(state, 'الاسم المعروض', 'Display name'),
        }),
      ]),
      h('p', { class: 'field__hint' }, [
        t(
          state,
          'تصحيح الاسم لا يربط ولا يفكّ أي هوية — الاسم ليس هوية.',
          'Correcting a name links nothing and unlinks nothing: a name is not an identity.',
        ),
      ]),
      button({
        label: t(state, 'حفظ', 'Save'),
        act: `live-contact-save-${where}`,
        arg: contact.id,
        small: true,
        disabled: busy,
      }),
      attributeList(state, contact),
    ]),

    h('section', { class: 'contact__section' }, [
      h('h3', { class: 'contact__heading' }, [t(state, 'كيف نصل إليه', 'How we reach them')]),
      contact.identities.length === 0
        ? h('p', { class: 'field__hint' }, [t(state, 'لا هويات مسجّلة.', 'No identities recorded.')])
        : h(
            'ul',
            { class: 'contact__identities' },
            contact.identities.map((identity) => identityRow(state, identity)),
          ),
    ]),

    consentSection(state, contact, live, where),
  ]);
}

function attributeList(state: AppState, contact: Contact): Child {
  const entries = Object.entries(contact.attributes);
  if (entries.length === 0) {
    return h('p', { class: 'field__hint' }, [
      t(state, 'لا حقول عمل مسجّلة.', 'No business fields recorded.'),
    ]);
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
    pill(labelFor(state, CHANNEL_LABEL, identity.kind)),
    h('span', { class: 'contact__identityvalue' }, [isolated(identity.externalId, true)]),
    identity.validTo === null
      ? pill(t(state, 'سارية', 'Live'), 'success')
      : // A closed interval is shown, not hidden: messages sent while it was
        // live belong to whoever held it then.
        pill(t(state, 'منتهية', 'Ended'), 'neutral'),
  ]);
}

function consentSection(
  state: AppState,
  contact: Contact,
  live: LiveState,
  where: 'panel' | 'screen',
): HTMLElement {
  const suppressed = contact.suppressed;
  const history = contact.consent;
  const busy = live.busy === `consent:${contact.id}`;
  return h('section', { class: 'contact__section' }, [
    h('h3', { class: 'contact__heading' }, [t(state, 'ما وافق عليه', 'What they agreed to')]),
    ...suppressed.map((channel) =>
      // Above the consent history, deliberately: it outranks everything below.
      h('p', { class: 'consent__suppressed', role: 'status' }, [
        t(
          state,
          `انسحب على ${labelFor(state, CHANNEL_LABEL, channel)} — الانسحاب يعلو أي موافقة.`,
          `Opted out on ${labelFor(state, CHANNEL_LABEL, channel)} — an opt-out outranks any consent.`,
        ),
      ]),
    ),
    history.length === 0
      ? h('p', { class: 'field__hint' }, [
          t(state, 'لا سجل موافقات.', 'No consent has been recorded.'),
        ])
      : h(
          'ul',
          { class: 'consent__list' },
          history.map((record) => consentRow(state, record)),
        ),
    h('div', { class: 'consent__actions' }, [
      button({
        label: t(state, 'تسجيل انسحاب', 'Record a withdrawal'),
        act: `live-consent-${where}`,
        arg: `${contact.id}:withdrawn`,
        small: true,
        disabled: busy,
      }),
      button({
        label: t(state, 'تسجيل موافقة', 'Record consent'),
        act: `live-consent-${where}`,
        arg: `${contact.id}:granted`,
        small: true,
        disabled: busy,
      }),
    ]),
    h('p', { class: 'field__hint' }, [
      t(
        state,
        'الموافقة دليل لا مفتاح: كل تسجيل صف جديد، والسحب لا يمحو ما قبله.',
        'Consent is evidence, not a switch: each record is a new row, and a withdrawal does not erase what came before.',
      ),
    ]),
  ]);
}

function consentRow(state: AppState, record: ConsentRecord): HTMLElement {
  const tone: Tone = record.state === 'granted' ? 'success' : 'warning';
  return h('li', { class: 'consent__row' }, [
    pill(
      record.state === 'granted' ? t(state, 'موافقة', 'Granted') : t(state, 'انسحاب', 'Withdrawn'),
      tone,
    ),
    h('span', {}, [
      `${labelFor(state, CHANNEL_LABEL, record.channel)} · ${labelFor(state, PURPOSE_LABEL, record.purpose)}`,
    ]),
    h('span', { class: 'consent__source' }, [labelFor(state, SOURCE_LABEL, record.source)]),
    h('span', { class: 'consent__when' }, [
      relativeTime(record.recordedAt, state.clock, state.lang),
    ]),
  ]);
}
