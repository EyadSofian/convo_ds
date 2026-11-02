import { buildWhatsAppTemplateComponents } from '@convo/domain';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import { quickWhatsAppNumber } from './quick-whatsapp-phone.js';
import { templateDefinition } from './template-binding.js';
import { forTenant, LOADING, ready, failed } from './store.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function openQuickWhatsApp(context: LiveContext): Promise<boolean> {
  if (context.live.supervisorAgentId !== null || context.live.busy !== null) return false;
  context.state.dialog = { kind: 'quick-whatsapp', arg: '' };
  context.state.dialogForm = { quickCountry: 'EG' };
  context.live.quickWhatsAppLookup = null;
  context.state.formErrors = {};
  context.live.error = null;
  context.refresh();
  await forTenant(context, undefined, async (tenantId) => {
    context.live.quickWhatsAppOptions = LOADING;
    context.refresh();
    const result = await context.live.channels.quickWhatsAppOptions(tenantId);
    context.live.quickWhatsAppOptions = result.ok ? ready(result.data, context.now()) : failed(result.error);
    context.refresh();
  });
  return true;
}

function numberAndConnection(context: LiveContext) {
  const form = context.state.dialogForm;
  const options = context.live.quickWhatsAppOptions;
  return {
    peerIdentity: quickWhatsAppNumber(form['quickPeerIdentity'] ?? '', form['quickCountry'] ?? 'EG'),
    connectionId: form['quickConnectionId'] ?? (options.status === 'ready' ? options.value.connections[0]?.id ?? '' : ''),
  };
}

/** Debounce exact-number checks and discard answers for an edited/closed dialog. */
export function changeQuickWhatsApp(context: LiveContext, arg: string): boolean {
  if (context.state.dialog?.kind !== 'quick-whatsapp') return false;
  const separator = arg.indexOf(':');
  const name = arg.slice(0, separator);
  if (separator === -1 || !['quickPeerIdentity', 'quickCountry', 'quickConnectionId'].includes(name)) return false;
  context.state.dialogForm[name] = arg.slice(separator + 1);
  context.state.formErrors = {};
  context.live.error = null;
  const { peerIdentity, connectionId } = numberAndConnection(context);
  context.live.quickWhatsAppLookup = null;
  if (peerIdentity !== null && connectionId !== '') {
    const pending = { key: `${connectionId}:${peerIdentity}`, result: LOADING };
    context.live.quickWhatsAppLookup = pending;
    setTimeout(() => {
      if (context.live.quickWhatsAppLookup === pending && context.state.dialog?.kind === 'quick-whatsapp') void checkQuickWhatsApp(context);
    }, 350);
  }
  context.refresh();
  return true;
}

export async function checkQuickWhatsApp(context: LiveContext): Promise<boolean> {
  if (context.state.dialog?.kind !== 'quick-whatsapp') return false;
  const { peerIdentity, connectionId } = numberAndConnection(context);
  if (peerIdentity === null || connectionId === '') {
    context.state.formErrors = { quickPeerIdentity: t(context, 'أدخل رقمًا صحيحًا واختر رقم الإرسال.', 'Enter a valid number and choose a sending line.') };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    const pending = { key: `${connectionId}:${peerIdentity}`, result: LOADING };
    context.live.quickWhatsAppLookup = pending;
    context.refresh();
    const result = await context.live.channels.lookupQuickWhatsApp(tenantId, connectionId, peerIdentity);
    const current = numberAndConnection(context);
    if (context.state.dialog?.kind !== 'quick-whatsapp' || context.live.quickWhatsAppLookup !== pending || current.peerIdentity !== peerIdentity || current.connectionId !== connectionId) return false;
    context.live.quickWhatsAppLookup = { key: pending.key, result: result.ok ? ready(result.data, context.now()) : failed(result.error) };
    context.refresh();
    return result.ok;
  });
}

export async function openQuickWhatsAppCustomer(context: LiveContext): Promise<boolean> {
  if (context.state.dialog?.kind !== 'quick-whatsapp' || context.live.busy !== null) return false;
  if (!await checkQuickWhatsApp(context)) return false;
  const lookup = context.live.quickWhatsAppLookup?.result;
  if (lookup?.status !== 'ready') return false;
  const customer = lookup.value.customer;
  if (customer?.state !== 'mine' || customer.conversationId === null) return false;
  context.state.dialog = null;
  context.state.dialogForm = {};
  context.state.inboxQueue = 'mine';
  context.live.inboxQuery = { ...context.live.inboxQuery, queue: 'mine', cursor: null };
  await loadInboxScreen(context);
  await openConversation(context, customer.conversationId);
  return true;
}

export async function sendQuickWhatsApp(context: LiveContext): Promise<boolean> {
  const { state, live } = context;
  if (state.dialog?.kind !== 'quick-whatsapp' || live.busy !== null) return false;
  const options = live.quickWhatsAppOptions.status === 'ready' ? live.quickWhatsAppOptions.value : null;
  const connectionId = state.dialogForm['quickConnectionId'] ?? options?.connections[0]?.id ?? '';
  const connection = options?.connections.find((entry) => entry.id === connectionId);
  const template = options?.templates.find((entry) => entry.id === state.dialogForm['quickTemplateId'] && entry.connectionId === connectionId && entry.status === 'approved');
  const definition = template === undefined ? null : templateDefinition(template);
  const parameters = Object.fromEntries((definition?.parameters ?? []).map((entry) => [entry.key, (state.dialogForm[`quickParam_${entry.key.replaceAll(':', '_')}`] ?? '').trim()]));
  const peerIdentity = quickWhatsAppNumber(state.dialogForm['quickPeerIdentity'] ?? '', state.dialogForm['quickCountry'] ?? 'EG');
  if (peerIdentity === null) {
    state.formErrors = { quickPeerIdentity: t(context, 'أدخل رقمًا صحيحًا للدولة المختارة.', 'Enter a valid number for the selected country.') };
    context.refresh();
    return false;
  }
  if (!await checkQuickWhatsApp(context)) return false;
  const lookup = live.quickWhatsAppLookup?.result;
  if (lookup?.status !== 'ready') return false;
  const customer = lookup.value.customer;
  if (customer?.state === 'mine') return openQuickWhatsAppCustomer(context);
  if (customer?.state === 'other') return false;
  if (connection === undefined || template === undefined || definition === null || !definition.sendSupported || buildWhatsAppTemplateComponents(definition, parameters) === null) {
    state.formErrors = { quickWhatsApp: t(context, 'اختر قالبًا معتمدًا وأكمل بياناته.', 'Choose an approved template and complete its values.') };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'quick-whatsapp-send';
    live.error = null;
    state.formErrors = {};
    context.refresh();
    const signature = JSON.stringify([connectionId, peerIdentity, template.id, parameters]);
    const clientMessageId = state.dialogForm['quickSignature'] === signature && state.dialogForm['quickMessageId']
      ? state.dialogForm['quickMessageId']! : context.newKey();
    state.dialogForm = { ...state.dialogForm, quickSignature: signature, quickMessageId: clientMessageId };
    const result = await live.channels.sendQuickWhatsApp(tenantId, connectionId, { peerIdentity, template: { id: template.id, parameters }, clientMessageId });
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      context.refresh();
      return false;
    }
    state.dialog = null;
    state.dialogForm = {};
    state.inboxQueue = 'mine';
    live.inboxQuery = { ...live.inboxQuery, queue: 'mine', cursor: null };
    pushToast(state, t(context, 'أُضيف القالب إلى طابور الإرسال. راقب حالة التسليم.', 'Template queued. Check delivery status.'));
    await loadInboxScreen(context);
    await openConversation(context, result.data.conversationId);
    return true;
  });
}
