import { previewContactCsv, type Contact } from '../api/contacts.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import type { NewContactField } from './contact-profile.js';
import { forTenant, fromResult, LOADING, ready, refetching, rowsOf } from './store.js';
import { loadMetadataCatalog } from './metadata-catalog.js';

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
    live.openContact = fromResult(result, context.now());
    context.refresh();
  });
}

/* ----------------------------------------------------------------- screen -- */

export async function loadContactsScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    live.contacts = refetching(live, live.contacts);
    context.refresh();
    const result = await live.contactsApi.list(tenantId, {
      query: live.contactQuery,
      labelId: live.contactFilters.labelId,
      fieldId: live.contactFilters.fieldId,
      fieldValue: live.contactFilters.fieldValue,
    });
    live.contacts = fromResult(result, context.now());
    context.refresh();
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
  readonly connectionId: string;
  readonly externalId: string;
  /** Profile details; a standard field with no id is created in the catalogue first. */
  readonly fields: readonly NewContactField[];
  readonly labelIds: readonly string[];
  /**
   * Consent the operator has evidence for now, recorded as their own
   * statement, on the channel of the identity it is about.
   */
  readonly consents: readonly { readonly purpose: 'marketing' | 'service'; readonly channel: string }[];
}

/**
 * Creates a contact on one explicit channel identity, then — as separate,
 * attributable steps — writes its profile details and labels and records any
 * consent the operator vouched for. The contact exists once the first step
 * succeeds; a later step that is refused is reported, not rolled back, so a
 * rejected email never costs the operator the customer they just added.
 */
export async function createContact(context: LiveContext, input: NewContactInput): Promise<boolean> {
  const { live } = context;
  if (input.displayName.trim() === '' || input.connectionId === '' || input.externalId.trim() === '') return false;
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'contact:create';
    live.error = null;
    context.refresh();
    const result = await live.contactsApi.create(tenantId, { displayName: input.displayName.trim(), connectionId: input.connectionId, externalId: input.externalId.trim() });
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
    const enriched = input.fields.length + input.labelIds.length + input.consents.length > 0;
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

/** Writes the profile, labels and consent of a contact just created; returns what was refused. */
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
  for (const consent of input.consents) {
    const recorded = await live.contactsApi.recordConsent(tenantId, contact.id, { ...consent, state: 'granted', source: 'agent_recorded', proofRef: null });
    if (!recorded.ok) problems.push(t(context, `الموافقة (${recorded.error.message})`, `consent (${recorded.error.message})`));
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
    context.refresh();
    const result = await live.contactsApi.read(tenantId, contactId);
    live.selectedContact = fromResult(result, context.now());
    context.refresh();
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
