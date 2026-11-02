import { h } from '../dom.js';
import type { AppState } from '../state.js';
import { button, inlineError, notice } from './parts.js';
import { t } from './copy.js';

export function quickWhatsAppCustomer(state: AppState): HTMLElement | null {
  const lookup = state.live.quickWhatsAppLookup;
  if (lookup === null) return null;
  const resource = lookup.result;
  if (resource.status === 'loading') return h('p', { class: 'field__hint', role: 'status' }, [t(state, 'جارٍ فحص الرقم…', 'Checking number…')]);
  if (resource.status === 'error') return h('div', {}, [inlineError(state, resource.error), button({ label: t(state, 'إعادة فحص الرقم', 'Retry number check'), act: 'live-quick-whatsapp-check' })]);
  if (resource.status !== 'ready') return null;
  const customer = resource.value.customer;
  if (customer === null) return notice('info', 'info', t(state, 'لا توجد محادثة لهذا الرقم في الإنبوكسات المتاحة لك. يمكنك بدء المحادثة بالقالب.', 'No conversation for this number in your available inboxes. You can start with a template.'));
  const owner = customer.assigneeName ?? t(state, 'موظف آخر', 'another agent');
  const title = customer.customerName ?? lookup.key.slice(lookup.key.indexOf(':') + 1);
  return h('div', { class: 'quick-customer', role: 'status' }, [
    h('strong', {}, [title]),
    h('p', {}, [customer.state === 'other' ? t(state, `العميل مسجل بالفعل — مسؤول المتابعة: ${owner}`, `Customer already registered — Follow-up owner: ${owner}`) : customer.state === 'mine' ? t(state, 'هذا العميل مسند لك بالفعل. افتح المحادثة الحالية.', 'This customer is already assigned to you. Open the existing conversation.') : t(state, 'العميل موجود بالفعل ومتاح للاستلام.', 'This customer already exists and is available to claim.')]),
    h('p', { class: 'field__hint' }, [customer.connectionName]),
    customer.state === 'mine' && customer.conversationId !== null ? button({ label: t(state, 'فتح المحادثة', 'Open conversation'), act: 'live-quick-whatsapp-existing', icon: 'inbox', variant: 'primary' }) : null,
    customer.state === 'unassigned' && customer.connectionId !== (state.dialogForm['quickConnectionId'] ?? (state.live.quickWhatsAppOptions.status === 'ready' ? state.live.quickWhatsAppOptions.value.connections[0]?.id : undefined))
      ? button({ label: t(state, 'استخدام الإنبوكس الحالي للعميل', 'Use the customer’s existing inbox'), act: 'live-quick-whatsapp-change', arg: `quickConnectionId:${customer.connectionId}` }) : null,
  ]);
}

export function inboxNumberCustomer(state: AppState): HTMLElement | null {
  const lookup = state.live.inboxNumberLookup;
  if (lookup === null || lookup.key !== state.live.inboxSearchDraft || lookup.result.status !== 'ready') return null;
  const customer = lookup.result.value.customer;
  if (customer === null) return null;
  const owner = customer.assigneeName ?? t(state, 'موظف آخر', 'another agent');
  return h('div', { class: 'quick-customer', role: 'status' }, [
    h('strong', {}, [customer.customerName ?? lookup.key]),
    h('p', {}, [customer.state === 'other' ? t(state, `العميل مسجل بالفعل — مسؤول المتابعة: ${owner}`, `Customer already registered — Follow-up owner: ${owner}`) : customer.state === 'mine' ? t(state, 'هذا العميل مسند لك بالفعل.', 'This customer is already assigned to you.') : t(state, 'هذا العميل موجود ومتاح للاستلام.', 'This customer already exists and is available to claim.')]),
    h('p', { class: 'field__hint' }, [customer.connectionName]),
    customer.state === 'mine' && customer.conversationId !== null ? button({ label: t(state, 'فتح المحادثة', 'Open conversation'), act: 'live-inbox-open', arg: customer.conversationId, small: true }) : null,
  ]);
}
