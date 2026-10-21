import { buildWhatsAppTemplateComponents } from '@convo/domain';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadInboxScreen, openConversation } from './inbox-actions.js';
import { templateDefinition } from './template-binding.js';
import { forTenant, LOADING, ready, failed } from './store.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function openQuickWhatsApp(context: LiveContext): Promise<boolean> {
  if (context.live.supervisorAgentId !== null || context.live.busy !== null) return false;
  context.state.dialog = { kind: 'quick-whatsapp', arg: '' };
  context.state.dialogForm = {};
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

export async function sendQuickWhatsApp(context: LiveContext): Promise<boolean> {
  const { state, live } = context;
  if (state.dialog?.kind !== 'quick-whatsapp' || live.busy !== null) return false;
  const options = live.quickWhatsAppOptions.status === 'ready' ? live.quickWhatsAppOptions.value : null;
  const connectionId = state.dialogForm['quickConnectionId'] ?? options?.connections[0]?.id ?? '';
  const connection = options?.connections.find((entry) => entry.id === connectionId);
  const template = options?.templates.find((entry) => entry.id === state.dialogForm['quickTemplateId'] && entry.connectionId === connectionId && entry.status === 'approved');
  const definition = template === undefined ? null : templateDefinition(template);
  const parameters = Object.fromEntries((definition?.parameters ?? []).map((entry) => [entry.key, (state.dialogForm[`quickParam_${entry.key.replaceAll(':', '_')}`] ?? '').trim()]));
  const peerIdentity = (state.dialogForm['quickPeerIdentity'] ?? '').trim();
  const consentReference = (state.dialogForm['quickConsentReference'] ?? '').trim();
  if (connection === undefined || template === undefined || definition === null || !definition.sendSupported || buildWhatsAppTemplateComponents(definition, parameters) === null || !/^\+?[1-9][0-9\s().-]{7,20}$/.test(peerIdentity) || consentReference.length < 3 || consentReference.length > 500) {
    state.formErrors = { quickWhatsApp: t(context, 'أدخل رقمًا دوليًا صحيحًا، وقالبًا معتمدًا مكتمل القيم، ومرجع موافقة العميل.', 'Enter a valid international number, complete approved template, and customer opt-in reference.') };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'quick-whatsapp-send';
    live.error = null;
    state.formErrors = {};
    context.refresh();
    const signature = JSON.stringify([connectionId, peerIdentity, template.id, parameters, consentReference]);
    const clientMessageId = state.dialogForm['quickSignature'] === signature && state.dialogForm['quickMessageId']
      ? state.dialogForm['quickMessageId']! : context.newKey();
    state.dialogForm = { ...state.dialogForm, quickSignature: signature, quickMessageId: clientMessageId };
    const result = await live.channels.sendQuickWhatsApp(tenantId, connectionId, { peerIdentity, consentReference, template: { id: template.id, parameters }, clientMessageId });
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
