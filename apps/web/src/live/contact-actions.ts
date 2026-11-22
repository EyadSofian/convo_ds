import { previewContactCsv, type Contact } from '../api/contacts.js';
import { pushToast, type AppState } from '../state.js';
import type { LiveContext } from './actions.js';
import type { NewContactField } from './contact-profile.js';
import { claimRead, forTenant, fromResult, LOADING, ready, refetching, rowsOf } from './store.js';
import { loadMetadataCatalog } from './metadata-catalog.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import { templateDefinition } from './template-binding.js';
import { buildWhatsAppTemplateComponents } from '@convo/domain';
import { hasPermission } from './ability.js';

/**
 * Contacts, against the real API.
 *
 * Two shapes, deliberately kept apart:
 *
 * - the **customer panel** beside an open conversation, which reads the contact
 *   that conversation resolved to;
 * - the **Contacts screen**, which lists and searches.
 *
 * They read the same endpoints and hold separate state, because an agent
 * searching the directory should not disturb the panel of the conversation they
 * are in the middle of.
 *
 * Manual and CSV creation require an explicit connection-scoped identity. No
 * identity is guessed and no marketing consent is inferred.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/* ------------------------------------------------------------------ panel -- */

/**
 * Loads the contact behind the open conversation.
 *
 * A conversation opened by an outbound message has no contact yet — nobody has
 * written to us — and the panel says so rather than showing an empty record.
 */
export async function loadOpenContact(context: LiveContext, contactId: string | null): Promise<void> {
  const { live } = context;
  if (contactId === null) {
    live.openContact = { status: 'idle' };
    context.refresh();
    return;
  }
  return forTenant(context, undefined, async (tenantId) => {
    live.openContact = LOADING;
    context.refresh();
    const result = await live.contactsApi.read(tenantId, contactId);
    // The customer beside the thread is the open thread's customer; an answer
    // for the previous one must not take its place.
    const open = live.openConversation;
    if (open.status === 'ready' && open.value.contactId !== contactId) return;
    live.openContact = fromResult(result, context.now());
    context.refresh();
  });
}

/* ----------------------------------------------------------------- screen -- */

export async function loadContactsScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    // Each keystroke of a search is a read; only the newest may write.
    const current = claimRead(live, 'contacts');
    live.contacts = refetching(live, live.contacts);
    context.refresh();
    const result = await live.contactsApi.list(tenantId, {
      query: live.contactQuery,
      labelId: live.contactFilters.labelId,
      fieldId: live.contactFilters.fieldId,
      fieldValue: live.contactFilters.fieldValue,
    });
    if (current()) {
      live.contacts = fromResult(result, context.now());
      context.refresh();
    }
    if (live.labels.status === 'idle') await loadMetadataCatalog(context);
  });
}

export async function loadContactConnections(context: LiveContext): Promise<boolean> {
  const tenantId = context.live.session.status === 'signed_in' ? context.live.session.tenantId : null;
  if (tenantId === null) return false;
  context.live.connections = LOADING;
  context.refresh();
  const result = await context.live.channels.connections(tenantId);
  context.live.connections = fromResult(result, context.now());
  context.refresh();
  return result.ok;
}

/**
 * Opens the new-contact dialog and fetches what it offers — the connected
 * channels an identity can be created on, and the label and field catalogues.
 */
export async function openNewContact(context: LiveContext): Promise<boolean> {
  context.state.dialog = { kind: 'contact-create', arg: '' };
  context.state.openMenu = null;
  context.state.dialogForm = {};
  context.state.formErrors = {};
  context.live.error = null;
  context.refresh();
  const status = context.live.connections.status;
  await Promise.all([
    status === 'idle' || status === 'error' ? loadContactConnections(context) : null,
    context.live.labels.status === 'idle' ? loadMetadataCatalog(context) : null,
  ]);
  return true;
}

export interface NewContactInput {
  readonly displayName: string;
  /** Empty for a contact with no channel yet; the id then is empty too. */
  readonly connectionId: string;
  readonly externalId: string;
  /** Profile details; a standard field with no id is created in the catalogue first. */
  readonly fields: readonly NewContactField[];
  readonly labelIds: readonly string[];
}

/**
 * Creates a contact on one explicit channel identity, then — as a separate,
 * attributable step — writes its profile details and labels. Consent is not
 * part of adding someone; it is recorded on the profile, with its evidence.
 * The contact exists once the first step
 * succeeds; a later step that is refused is reported, not rolled back, so a
 * rejected email never costs the operator the customer they just added.
 */
export async function createContact(context: LiveContext, input: NewContactInput): Promise<boolean> {
  const { live } = context;
  // A channel is optional, but half of one — a channel with no id — is not.
  if (input.displayName.trim() === '' || (input.connectionId !== '') !== (input.externalId.trim() !== '')) return false;
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'contact:create';
    live.error = null;
    context.refresh();
    const result = await live.contactsApi.create(tenantId, {
      displayName: input.displayName.trim(),
      ...(input.connectionId === '' ? {} : { connectionId: input.connectionId, externalId: input.externalId.trim() }),
    });
    if (!result.ok) {
      live.busy = null;
      live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    const problems = await enrichContact(context, tenantId, result.data, input);
    // Whatever was written after the create is read back, so the profile shows
    // what the server stored rather than what was typed.
    const enriched = input.fields.length + input.labelIds.length > 0;
    const reread = enriched ? await live.contactsApi.read(tenantId, result.data.id) : null;
    live.busy = null;
    live.selectedContactId = result.data.id;
    live.selectedContact = ready(reread?.ok === true ? reread.data : result.data, context.now());
    if (context.state.dialog?.kind === 'contact-create') context.state.dialog = null;
    context.state.dialogForm = { ...context.state.dialogForm, contactsTool: '', contactCreateName: '', contactCreateConnection: '', contactCreateExternalId: '' };
    pushToast(context.state, problems.length === 0
      ? t(context, 'أُضيفت جهة الاتصال.', 'Contact added.')
      : t(context, `أُضيفت جهة الاتصال، لكن لم يُحفظ: ${problems.join('، ')}`, `Contact added, but not everything was saved: ${problems.join('; ')}`),
    problems.length === 0 ? 'default' : 'danger');
    await loadContactsScreen(context);
    return true;
  });
}

/** Makes a contact reachable on one more channel, from their profile. */
export async function addContactIdentity(context: LiveContext, contactId: string, connectionId: string, externalId: string): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    live.busy = `contact-identity:${contactId}`;
    live.error = null;
    context.refresh();
    const result = await live.contactsApi.addIdentity(tenantId, contactId, { connectionId, externalId });
    live.busy = null;
    if (!result.ok) {
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    live.selectedContact = ready(result.data, context.now());
    live.contacts = live.contacts.status === 'ready'
      ? ready(live.contacts.value.map((contact) => (contact.id === contactId ? result.data : contact)), context.now())
      : live.contacts;
    context.state.dialogForm = { ...context.state.dialogForm, [`contactIdentityConnection_${contactId}`]: '', [`contactIdentityExternal_${contactId}`]: '' };
    pushToast(context.state, t(context, 'أُضيفت القناة إلى جهة الاتصال.', 'Channel added to the contact.'));
    context.refresh();
    return true;
  });
}

/** Writes the profile and labels of a contact just created; returns what was refused. */
async function enrichContact(context: LiveContext, tenantId: string, contact: Contact, input: NewContactInput): Promise<readonly string[]> {
  const { live } = context;
  const problems: string[] = [];
  const writes: { fieldId: string; value: unknown }[] = [];
  for (const field of input.fields) {
    if (field.fieldId !== null) {
      writes.push({ fieldId: field.fieldId, value: field.value });
      continue;
    }
    const created = await live.metadataApi.createField(tenantId, { target: 'contact', key: field.key, name: field.name, type: field.type, options: [] });
    if (!created.ok) {
      problems.push(`${field.name} (${created.error.message})`);
      continue;
    }
    live.customFields = ready([...rowsOf(live.customFields), created.data], context.now());
    writes.push({ fieldId: created.data.id, value: field.value });
  }
  const labelIds = input.labelIds;
  if (writes.length > 0 || labelIds.length > 0) {
    const patched = await live.metadataApi.contact(tenantId, contact.id, { version: contact.version, addLabels: labelIds, fields: writes });
    if (!patched.ok) problems.push(t(context, `البيانات والتصنيفات (${patched.error.message})`, `details and labels (${patched.error.message})`));
  }
  return problems;
}

export async function importContacts(context: LiveContext): Promise<boolean> {
  const csv = context.state.dialogForm['contactImportCsv'] ?? '';
  const connectionId = context.state.dialogForm['contactImportConnection'] ?? '';
  const preview = previewContactCsv(csv);
  if (!preview.ok || connectionId === '') return false;
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = 'contacts:import';
    context.live.error = null;
    context.refresh();
    const result = await context.live.contactsApi.import(tenantId, { connectionId, rows: preview.rows });
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    context.state.dialogForm = { ...context.state.dialogForm, contactsTool: '', contactImportCsv: '', contactImportFileName: '', contactImportError: '' };
    pushToast(context.state, t(context,
      `تم استيراد ${String(result.data.created)} جهة اتصال. لم تُسجّل موافقات تسويقية.`,
      `Imported ${String(result.data.created)} contacts. No marketing consent was recorded.`));
    await loadContactsScreen(context);
    return true;
  });
}

export async function exportContacts(context: LiveContext): Promise<boolean> {
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = 'contacts:export';
    context.live.error = null;
    context.refresh();
    const result = await context.live.contactsApi.export(tenantId);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    const file = new Blob([result.data.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.data.filename;
    link.click();
    URL.revokeObjectURL(url);
    pushToast(context.state, t(context, `تم تصدير ${String(result.data.rowCount)} سجل.`, `Exported ${String(result.data.rowCount)} records.`));
    context.refresh();
    return true;
  });
}

export async function openContact(context: LiveContext, contactId: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    live.selectedContactId = contactId;
    live.selectedContact = LOADING;
    live.selectedContactCampaignHistory = hasPermission(live, 'campaign.read') ? LOADING : { status: 'idle' };
    context.refresh();
    const [result, history] = await Promise.all([
      live.contactsApi.read(tenantId, contactId),
      hasPermission(live, 'campaign.read') ? live.contactsApi.campaignHistory(tenantId, contactId) : null,
    ]);
    if (live.selectedContactId !== contactId) return;
    live.selectedContact = fromResult(result, context.now());
    if (history !== null) live.selectedContactCampaignHistory = fromResult(history, context.now());
    context.refresh();
  });
}

export function contactTemplateContact(state: AppState, contactId: string): Contact | null {
  const { openContact, selectedContact } = state.live;
  const active = state.route.screen === 'contacts' ? selectedContact : openContact;
  const fallback = state.route.screen === 'contacts' ? openContact : selectedContact;
  for (const resource of [active, fallback]) {
    if (resource.status === 'ready' && resource.value.id === contactId) return resource.value;
  }
  return null;
}

export function contactTemplateNumbers(contact: Contact): readonly string[] {
  return [...new Set(contact.identities
    .filter((identity) => identity.kind === 'whatsapp' && identity.validTo === null)
    .map((identity) => identity.externalId.replace(/^\+/, ''))
    .filter((number) => /^[1-9][0-9]{7,14}$/.test(number)))];
}

export function contactTemplateLine(form: Readonly<Record<string, string>>, connections: readonly { readonly id: string }[]): string {
  return form['contactTemplateConnection'] ?? (connections.length === 1 ? connections[0]!.id : '');
}

export async function openContactTemplate(context: LiveContext, contactId: string): Promise<boolean> {
  const { state, live } = context;
  if (live.supervisorAgentId !== null || live.busy !== null || contactTemplateContact(state, contactId) === null) return false;
  const dialog = { kind: 'contact-template', arg: contactId };
  state.dialog = dialog;
  state.dialogForm = {};
  state.formErrors = {};
  live.error = null;
  return forTenant(context, false, async (tenantId) => {
    live.quickWhatsAppOptions = LOADING;
    context.refresh();
    const result = await live.channels.quickWhatsAppOptions(tenantId);
    if (state.dialog !== dialog) return false;
    live.quickWhatsAppOptions = fromResult(result, context.now());
    context.refresh();
    return true;
  });
}

export async function sendContactTemplate(context: LiveContext): Promise<boolean> {
  const { live, state } = context;
  const dialog = state.dialog;
  if (dialog?.kind !== 'contact-template' || live.busy !== null) return false;
  const contact = contactTemplateContact(state, dialog.arg);
  if (contact === null || contact.suppressed.includes('whatsapp') || live.quickWhatsAppOptions.status !== 'ready') return false;
  const options = live.quickWhatsAppOptions.value;
  const connectionId = contactTemplateLine(state.dialogForm, options.connections);
  if (!options.connections.some((connection) => connection.id === connectionId)) return false;
  const numbers = contactTemplateNumbers(contact);
  const peerIdentity = state.dialogForm['contactTemplateIdentity'] ?? numbers[0];
  if (peerIdentity === undefined || !numbers.includes(peerIdentity)) return false;
  const template = options.templates.find((entry) => entry.id === state.dialogForm['contactTemplateId'] && entry.connectionId === connectionId && entry.status === 'approved');
  if (template === undefined) return false;
  const definition = templateDefinition(template);
  const parameters = Object.fromEntries(definition.parameters.map((entry) => [entry.key, (state.dialogForm[`contactTemplateParam_${entry.key.replaceAll(':', '_')}`] ?? '').trim()]));
  if (buildWhatsAppTemplateComponents(definition, parameters) === null) {
    state.formErrors = { contactTemplate: t(context, 'أكمل قيم القالب الصحيحة قبل الإرسال.', 'Fill in valid template values before sending.') };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'contact-template-send';
    live.error = null;
    state.formErrors = {};
    const signature = JSON.stringify([connectionId, peerIdentity, template.id, parameters]);
    const clientMessageId = state.dialogForm['contactTemplateSignature'] === signature && state.dialogForm['contactTemplateMessageId']
      ? state.dialogForm['contactTemplateMessageId']! : context.newKey();
    state.dialogForm = { ...state.dialogForm, contactTemplateSignature: signature, contactTemplateMessageId: clientMessageId };
    context.refresh();
    const result = await live.channels.sendQuickWhatsApp(tenantId, connectionId, {
      contactId: contact.id, peerIdentity, template: { id: template.id, parameters }, clientMessageId,
    });
    live.busy = null;
    if (state.dialog !== dialog) { context.refresh(); return result.ok; }
    if (!result.ok) {
      live.error = result.error;
      context.refresh();
      return false;
    }
    state.dialog = null;
    state.dialogForm = {};
    state.inboxQueue = 'mine';
    state.route = { screen: 'inbox', conversationId: result.data.conversationId, params: {} };
    live.inboxQuery = { ...live.inboxQuery, queue: 'mine', cursor: null };
    pushToast(state, t(context, 'أُضيف القالب إلى قائمة الإرسال؛ انتظر حالة التسليم من Meta.', 'Template queued; check Meta delivery status.'));
    await Promise.all([loadInboxScreen(context), openConversation(context, result.data.conversationId)]);
    return true;
  });
}

/* --------------------------------------------------------------- mutating -- */

/**
 * Corrects the business fields.
 *
 * The screen redraws from the record the server returned, not from what was
 * typed: what is on screen after a change is what was stored.
 */
export async function saveContact(
  context: LiveContext,
  contactId: string,
  input: { readonly displayName: string },
): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    live.busy = `contact:${contactId}`;
    live.error = null;
    context.refresh();

    const result = await live.contactsApi.update(tenantId, contactId, input);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    applyContact(context, result.data);
    pushToast(context.state, t(context, 'حُفظت البيانات.', 'Saved.'));
    return true;
  });
}

/**
 * Records consent, or its withdrawal.
 *
 * The two refusals the server makes are reported in the operator's terms rather
 * than as a generic failure: an import is not consent, and a suppression is not
 * something a grant can paper over.
 */
export async function recordConsent(
  context: LiveContext,
  contactId: string,
  input: {
    readonly channel: string;
    readonly purpose: string;
    readonly state: 'granted' | 'withdrawn';
    readonly source: string;
  },
): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    live.busy = `consent:${contactId}`;
    live.error = null;
    context.refresh();

    const result = await live.contactsApi.recordConsent(tenantId, contactId, {
      ...input,
      proofRef: null,
    });
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, consentRefusal(context, result.error.code, result.error.message), 'danger');
      context.refresh();
      return false;
    }
    applyContact(context, result.data);
    pushToast(
      context.state,
      input.purpose === 'marketing'
        ? input.state === 'granted'
          ? t(context, 'سُجّلت موافقة التسويق. يمكن أن تصله الحملات الآن.', 'Marketing consent recorded. Campaigns can now reach this contact.')
          : t(context, 'سُجّل الانسحاب من التسويق.', 'Marketing withdrawal recorded.')
        : input.state === 'granted'
          ? t(context, 'سُجّلت الموافقة.', 'Consent recorded.')
          : t(context, 'سُجّل الانسحاب.', 'Withdrawal recorded.'),
    );
    return true;
  });
}

function consentRefusal(context: LiveContext, code: string, fallback: string): string {
  if (code === 'import_is_not_consent') {
    return t(
      context,
      'الاستيراد ليس موافقة. سجّل دليل موافقة العميل نفسه.',
      'An import is not consent. Record the evidence of the customer agreeing.',
    );
  }
  if (code === 'suppression_outranks_consent') {
    return t(
      context,
      'العميل انسحب على هذه القناة، والانسحاب يعلو الموافقة. رفعه يحتاج موافقة صريحة جديدة.',
      'This customer opted out on that channel, and an opt-out outranks consent. Lifting it needs a new explicit opt-in.',
    );
  }
  return fallback;
}

/** Writes a returned contact into whichever view is showing it. */
function applyContact(context: LiveContext, contact: Contact): void {
  const { live } = context;
  const now = context.now();
  if (live.selectedContactId === contact.id) {
    live.selectedContact = ready(contact, now);
  }
  if (live.openContact.status === 'ready' && live.openContact.value.id === contact.id) {
    live.openContact = ready(contact, now);
  }
  // The list is re-read rather than patched: a rename changes the order, and
  // sorting a local copy would be a second implementation of the server's sort.
  void loadContactsScreen(context);
  context.refresh();
}
