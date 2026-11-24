import type { ApiResult } from '../api/client.js';
import type { LiveContext } from './actions.js';
import { claimRead, forTenant, fromResult, LOADING } from './store.js';

export async function loadCrmSettings(context: LiveContext): Promise<void> {
  return forTenant(context, undefined, async (tenant) => {
    const { live, state } = context;
    const current = claimRead(live, 'crm-settings');
    live.crmSettings = LOADING;
    context.refresh();
    const result = await live.api.crmSettings(tenant);
    if (!current() || state.live !== live) return;
    live.crmSettings = fromResult(result, context.now());
    context.refresh();
  });
}

export async function createCrmKey(context: LiveContext): Promise<void> {
  const { live, state } = context;
  if (state.dialog?.kind !== 'crm-key' || live.crmSettings.status !== 'ready') return;
  const label = (state.dialogForm['crmLabel'] ?? '').trim();
  const ids = live.crmSettings.value.senders
    .filter((sender) => state.dialogForm[`crmSender_${sender.id}`] === 'yes')
    .map((sender) => sender.id);
  if (label === '' || ids.length === 0) return;
  await mutateKey(context, 'crm-create', (tenant) => live.api.createCrmKey(tenant, label, ids), ({ token }) => {
    // Closing the dialog discards the one-time secret.
    state.dialogForm = { crmToken: token };
  });
}

export async function revokeCrmKey(context: LiveContext, id: string): Promise<void> {
  const { live, state } = context;
  if (live.crmSettings.status !== 'ready' || !live.crmSettings.value.keys.some((key) => key.id === id)) return;
  await mutateKey(context, 'crm-revoke', (tenant) => live.api.revokeCrmKey(tenant, id), () => {
    state.dialog = null;
    state.dialogForm = {};
  });
}

async function mutateKey<T>(
  context: LiveContext,
  busy: string,
  request: (tenantId: string) => Promise<ApiResult<T>>,
  onSuccess: (value: T) => void,
): Promise<void> {
  const { live, state } = context;
  if (live.busy !== null) return;
  await forTenant(context, undefined, async (tenant) => {
    const dialog = state.dialog;
    live.busy = busy;
    live.error = null;
    context.refresh();
    const result = await request(tenant);
    live.busy = null;
    if (state.live !== live) return;
    if (!result.ok) {
      live.error = result.error;
      context.refresh();
      return;
    }
    if (state.dialog === dialog) onSuccess(result.data);
    await loadCrmSettings(context);
  });
}
