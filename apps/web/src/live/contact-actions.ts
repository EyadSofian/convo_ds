import { previewContactCsv, type Contact } from '../api/contacts.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { forTenant, fromResult, LOADING, ready, refetching } from './store.js';
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

export async function createContact(context: LiveContext, input: { readonly displayName: string; readonly connectionId: string; readonly externalId: string }): Promise<boolean> {
  const { live } = context;
  if (input.displayName.trim() === '' || input.connectionId === '' || input.externalId.trim() === '') return false;
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'contact:create';
    live.error = null;
    context.refresh();
    const result = await live.contactsApi.create(tenantId, { ...input, displayName: input.displayName.trim(), externalId: input.externalId.trim() });
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    live.selectedContactId = result.data.id;
    live.selectedContact = ready(result.data, context.now());
    // The tool closes on success so the operator lands on the new profile.
    context.state.dialogForm = { ...context.state.dialogForm, contactsTool: '', contactCreateName: '', contactCreateConnection: '', contactCreateExternalId: '' };
    pushToast(context.state, t(context,
      'أُضيفت جهة الاتصال. لإضافتها لجمهور حملة، استخدم اسمها في فلتر الجمهور وسجّل موافقة التسويق عند توفرها.',
      'Contact added. To include it in a campaign audience, use its name in the audience filter and record marketing consent when available.'));
    await loadContactsScreen(context);
    return true;
  });
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
      input.state === 'granted'
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
