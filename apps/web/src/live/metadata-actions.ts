import type { CustomField, FieldTarget } from '../api/metadata.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { forTenant, fromResult, rowsOf } from './store.js';
import { loadContactsScreen } from './contact-actions.js';
import { refreshOpenConversation } from './inbox-actions.js';
import { loadMetadataCatalog } from './metadata-catalog.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function createLabel(
  context: LiveContext,
  name: string,
  color: string,
): Promise<boolean> {
  return mutate(context, 'metadata:create-label', async (tenantId) => {
    const result = await context.live.metadataApi.createLabel(tenantId, name, color);
    if (result.ok) pushToast(context.state, t(context, 'أُنشئ التصنيف.', 'Label created.'));
    else {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
    }
    return result.ok;
  });
}

export async function createField(
  context: LiveContext,
  input: { readonly target: FieldTarget; readonly key: string; readonly name: string; readonly type: CustomField['type']; readonly options: readonly string[] },
): Promise<boolean> {
  return mutate(context, 'metadata:create-field', async (tenantId) => {
    const result = await context.live.metadataApi.createField(tenantId, input);
    if (result.ok) pushToast(context.state, t(context, 'أُنشئ الحقل.', 'Field created.'));
    else {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
    }
    return result.ok;
  });
}

export async function setEntityLabel(
  context: LiveContext,
  target: FieldTarget,
  entityId: string,
  labelId: string,
  add: boolean,
): Promise<boolean> {
  const version = versionOf(context, target, entityId);
  if (version === null || labelId === '') return false;
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = `metadata:${target}:${entityId}`;
    context.refresh();
    const input = { version, addLabels: add ? [labelId] : [], removeLabels: add ? [] : [labelId] };
    const result = target === 'contact'
      ? await context.live.metadataApi.contact(tenantId, entityId, input)
      : await context.live.metadataApi.conversation(tenantId, entityId, input);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    await refreshEntity(context, tenantId, target, entityId);
    pushToast(context.state, add ? t(context, 'أُضيف التصنيف.', 'Label added.') : t(context, 'أُزيل التصنيف.', 'Label removed.'));
    return true;
  });
}

export async function setFieldValue(
  context: LiveContext,
  target: FieldTarget,
  entityId: string,
  fieldId: string,
  raw: string,
): Promise<boolean> {
  const version = versionOf(context, target, entityId);
  const field = rowsOf(context.live.customFields).find((entry) => entry.id === fieldId && entry.target === target);
  if (version === null || field === undefined) return false;
  const value = browserValue(field, raw);
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = `metadata:${target}:${entityId}`;
    context.refresh();
    const input = { version, fields: [{ fieldId, value }] };
    const result = target === 'contact'
      ? await context.live.metadataApi.contact(tenantId, entityId, input)
      : await context.live.metadataApi.conversation(tenantId, entityId, input);
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    await refreshEntity(context, tenantId, target, entityId);
    pushToast(context.state, t(context, 'حُفظ الحقل.', 'Field saved.'));
    return true;
  });
}

async function mutate(
  context: LiveContext,
  busy: string,
  work: (tenantId: string) => Promise<boolean>,
): Promise<boolean> {
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = busy;
    context.live.error = null;
    context.refresh();
    const ok = await work(tenantId);
    context.live.busy = null;
    if (ok) await loadMetadataCatalog(context);
    else context.refresh();
    return ok;
  });
}

function versionOf(context: LiveContext, target: FieldTarget, id: string): number | null {
  if (target === 'conversation') {
    return context.live.openConversation.status === 'ready' && context.live.openConversation.value.id === id
      ? context.live.openConversation.value.version
      : null;
  }
  for (const resource of [context.live.openContact, context.live.selectedContact]) {
    if (resource.status === 'ready' && resource.value.id === id) return resource.value.version;
  }
  return null;
}

function browserValue(field: CustomField, raw: string): unknown | null {
  if (raw === '') return null;
  if (field.type === 'number') return Number(raw);
  if (field.type === 'boolean') return raw === 'true';
  if (field.type === 'multi_select') return raw.split(',').map((value) => value.trim()).filter(Boolean);
  return raw;
}

async function refreshEntity(
  context: LiveContext,
  tenantId: string,
  target: FieldTarget,
  id: string,
): Promise<void> {
  if (target === 'conversation') {
    // Metadata must not erase an unsent reply or private-note draft. This is an
    // in-place authoritative refresh, not navigation to another conversation.
    await refreshOpenConversation(context, id);
  } else {
    await loadContactsScreen(context);
    if (context.live.selectedContactId === id) {
      const result = await context.live.contactsApi.read(tenantId, id);
      context.live.selectedContact = fromResult(result, context.now());
    }
    if (context.live.openContact.status === 'ready' && context.live.openContact.value.id === id) {
      const result = await context.live.contactsApi.read(tenantId, id);
      context.live.openContact = fromResult(result, context.now());
    }
    context.refresh();
  }
}
