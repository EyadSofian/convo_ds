import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadInboxScreen } from './inbox-actions.js';
import { forTenant } from './store.js';

/**
 * Working through the archive: bring conversations back into the inbox, or
 * remove them. Ticking only changes the selection, so choosing never needs
 * the server, and it outlives the confirmation dialog.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

const REFUSAL: Readonly<Record<string, readonly [string, string]>> = {
  active_conversation_exists: ['للعميل محادثة جارية أحدث', 'the customer has a newer live conversation'],
  permission_denied: ['لا تملك صلاحية عليها', 'you may not change it'],
  conversation_not_archived: ['لم تعد مؤرشفة', 'it is no longer archived'],
  resource_not_found: ['لم تعد موجودة', 'it no longer exists'],
};

/** Sets the ticked conversations: a comma list of ids, or '' for none. */
export function tickArchived(context: LiveContext, arg: string): void {
  context.live.archivedSelection = arg.split(',').filter((id) => id !== '');
  context.refresh();
}

export async function manageArchived(context: LiveContext, action: 'restore' | 'delete'): Promise<boolean> {
  const ids = context.live.archivedSelection;
  if (ids.length === 0) return false;
  return forTenant(context, false, async (tenantId) => {
    const { live, state } = context;
    live.busy = `archived-${action}`;
    context.refresh();
    const result = await live.conversationsApi.archived(tenantId, action, ids);
    live.busy = null;
    if (!result.ok) {
      pushToast(state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    if (state.dialog?.kind === 'archived-delete') state.dialog = null;
    live.archivedSelection = [];
    const count = String(result.data.done.length);
    const done = action === 'restore'
      ? t(context, `أُعيدت ${count} محادثة إلى الصندوق.`, `${count} conversation(s) back in the inbox.`)
      : t(context, `حُذفت ${count} محادثة.`, `${count} conversation(s) deleted.`);
    const reasons = [...new Set(result.data.refused.map((refusal) => refusal.code))].map((code) => {
      const [ar, en] = REFUSAL[code] ?? [code, code];
      return t(context, ar, en);
    });
    pushToast(state, reasons.length === 0 ? done
      : `${done} ${t(context, `لم تتغير ${String(result.data.refused.length)}: ${reasons.join('، ')}.`, `${String(result.data.refused.length)} unchanged: ${reasons.join('; ')}.`)}`,
    reasons.length === 0 ? 'default' : 'danger');
    await loadInboxScreen(context);
    return true;
  });
}
