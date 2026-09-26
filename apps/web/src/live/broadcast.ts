import type { TemplateBindings } from '@convo/domain';
import type { Campaign } from '../api/campaigns.js';
import type { ApiError, ApiResult } from '../api/client.js';
import { pushToast } from '../state.js';
import type { AppState } from '../state.js';
import { hasPermission } from './ability.js';
import type { LiveContext } from './actions.js';
import { syncWhatsAppTemplates } from './actions.js';
import { audienceProblem, loadWhatsAppTemplates, previewCampaignAudience } from './audience-actions.js';
import { editorAudience } from './audience.js';
import { loadCampaignsScreen } from './campaign-actions.js';
import { bindingsFromForm, storedBindings, templateDefinition } from './template-binding.js';
import { currentTenantId, rowsOf } from './store.js';

export { whatsappNumbers } from './audience.js';

/**
 * A WhatsApp broadcast from the wizard to the wire: each step checked before
 * the next opens, then one confirmation that creates or saves the campaign and
 * takes it as far as the operator's permissions allow — freeze the audience,
 * approve, send now or at the chosen time.
 */

/** The form-key prefix of the broadcast's template variables. */
export const BROADCAST_PREFIX = 'campaignParam_';

export const BROADCAST_KEYS: readonly string[] = ['broadcastStep', 'broadcastMode', 'campaignTemplate', 'campaignWhen', 'campaignScheduleAt'];

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export function broadcastStep(state: AppState): number {
  const step = Number(state.dialogForm['broadcastStep'] ?? '0');
  return Number.isInteger(step) && step >= 0 && step <= 3 ? step : 0;
}

function editedCampaign(state: AppState): Campaign | undefined {
  const dialog = state.dialog;
  return dialog?.kind === 'campaign-edit' ? rowsOf(state.live.campaigns).find((entry) => entry.id === dialog.arg) : undefined;
}

/** The broadcast's name as typed, or as saved. */
export function broadcastName(state: AppState, campaign: Campaign | undefined): string {
  return (state.dialogForm['campaignName'] ?? campaign?.name ?? '').trim();
}

/** The template chosen, and the bindings the campaign already holds for it. */
export function broadcastTemplate(state: AppState, campaign: Campaign | undefined): { readonly template: string; readonly stored: TemplateBindings } {
  const saved = campaign?.content['template'];
  const savedTemplate = typeof saved === 'object' && saved !== null ? saved as Record<string, unknown> : {};
  const savedId = typeof savedTemplate['id'] === 'string' ? savedTemplate['id'] : '';
  const template = state.dialogForm['campaignTemplate'] ?? savedId;
  return { template, stored: template === savedId ? storedBindings(savedTemplate['parameters']) : {} };
}

/** What stops a step from being left forward, keyed by the field it belongs to. */
export function stepProblems(context: LiveContext, step: number): Readonly<Record<string, string>> {
  const { state } = context;
  const campaign = editedCampaign(state);
  if (step === 0) {
    const name = broadcastName(state, campaign);
    const { connectionId } = editorAudience(state);
    return {
      ...(name === '' ? { campaignName: t(context, 'سمِّ البث.', 'Name the broadcast.') } : {}),
      ...(connectionId === '' ? { campaignConnection: t(context, 'اختر رقم واتساب.', 'Choose a WhatsApp number.') } : {}),
    };
  }
  if (step === 1) {
    const { template: templateId, stored } = broadcastTemplate(state, campaign);
    const template = rowsOf(state.live.whatsappTemplates).find((entry) => entry.id === templateId);
    if (template === undefined) return { campaignTemplate: t(context, 'اختر قالبًا معتمدًا.', 'Choose an approved template.') };
    const definition = templateDefinition(template);
    if (!definition.sendSupported) return { campaignTemplate: t(context, 'هذا القالب لا يمكن بثه بعد. اختر غيره.', 'This template cannot be broadcast yet. Choose another.') };
    return bindingsFromForm(state.dialogForm, BROADCAST_PREFIX, definition, stored).missing.length > 0
      ? { campaignTemplate: t(context, 'حدد قيمة لكل متغير.', 'Give every variable a value.') }
      : {};
  }
  if (step === 2) {
    const problem = audienceProblem(context);
    return problem === null ? {} : { campaignAudience: problem };
  }
  return {};
}

function showProblems(context: LiveContext, step: number, problems: Readonly<Record<string, string>>): false {
  context.state.formErrors = problems;
  context.state.dialogForm = { ...context.state.dialogForm, broadcastStep: String(step) };
  context.refresh();
  return false;
}

/** Moves to a step: back freely, forward only past steps that are complete. */
export async function goToBroadcastStep(context: LiveContext, arg: string): Promise<boolean> {
  const target = Number(arg);
  if (!Number.isInteger(target) || target < 0 || target > 3) return false;
  for (let step = broadcastStep(context.state); step < target; step += 1) {
    const problems = stepProblems(context, step);
    if (Object.keys(problems).length > 0) return showProblems(context, step, problems);
  }
  context.state.formErrors = {};
  context.live.error = null;
  context.state.dialogForm = { ...context.state.dialogForm, broadcastStep: String(target) };
  context.refresh();
  // Reaching the review, the count is taken for the operator.
  if (target === 3) await previewCampaignAudience(context);
  return true;
}

/** Shows any step, to look around; Next and sending still check each one. */
export function jumpToBroadcastStep(context: LiveContext, arg: string): boolean {
  const target = Number(arg);
  if (!Number.isInteger(target) || target < 0 || target > 3) return false;
  context.state.formErrors = {};
  context.state.dialogForm = { ...context.state.dialogForm, broadcastStep: String(target) };
  context.refresh();
  return true;
}

/** Reads a number's approved templates from Meta again, then offers the new list. */
export async function syncBroadcastTemplates(context: LiveContext, connectionId: string): Promise<boolean> {
  const synced = await syncWhatsAppTemplates(context, connectionId);
  if (synced) await loadWhatsAppTemplates(context);
  return synced;
}

/** A local `datetime-local` value as an instant, when it is one in the future. */
export function scheduledInstant(value: string, now: number): string | null {
  const instant = new Date(value).getTime();
  return value === '' || Number.isNaN(instant) || instant <= now ? null : new Date(instant).toISOString();
}

/**
 * Saves the broadcast and takes it as far as it may go. `draft` only saves;
 * `now` and `schedule` also freeze the audience, approve and launch — each
 * step only when the operator holds its permission, stopping at the first
 * refusal with the campaign kept, so nothing is sent twice by a retry.
 */
export async function submitBroadcast(context: LiveContext, mode: string): Promise<boolean> {
  const { state, live } = context;
  if (mode !== 'draft' && mode !== 'now' && mode !== 'schedule') return false;
  const tenantId = currentTenantId(live);
  if (tenantId === null || live.busy === 'broadcast-submit') return false;
  for (let step = 0; step < 3; step += 1) {
    const problems = stepProblems(context, step);
    if (Object.keys(problems).length > 0) return showProblems(context, step, problems);
  }
  const scheduledFor = mode === 'schedule' ? scheduledInstant(state.dialogForm['campaignScheduleAt'] ?? '', context.now()) : null;
  if (mode === 'schedule' && scheduledFor === null) {
    return showProblems(context, 3, { campaignScheduleAt: t(context, 'اختر وقتًا قادمًا.', 'Choose a time in the future.') });
  }
  const campaign = editedCampaign(state);
  const { connectionId, filter } = editorAudience(state);
  const { template: templateId, stored } = broadcastTemplate(state, campaign);
  const template = rowsOf(live.whatsappTemplates).find((entry) => entry.id === templateId)!;
  const input = {
    name: broadcastName(state, campaign),
    objective: campaign?.objective ?? null,
    connectionId,
    content: { template: { id: templateId, parameters: bindingsFromForm(state.dialogForm, BROADCAST_PREFIX, templateDefinition(template), stored).bindings } },
    variables: {},
    // The audience step refused any audience that names no filter.
    audienceFilter: filter!,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    budgetAmountMinor: 0,
    budgetCurrency: 'USD',
  };
  live.busy = 'broadcast-submit';
  live.error = null;
  state.dialogForm = { ...state.dialogForm, broadcastMode: mode };
  context.refresh();

  const api = live.campaignsApi;
  const saved = campaign === undefined
    ? await api.create(tenantId, input, context.newKey())
    : await api.update(tenantId, campaign.id, input, campaign.version, context.newKey());
  if (!saved.ok) return stop(context, saved.error, null);
  let current = saved.data;
  const step = async (run: () => Promise<ApiResult<Campaign>>): Promise<boolean> => {
    const result = await run();
    if (!result.ok) return stop(context, result.error, current.id);
    current = result.data;
    return true;
  };
  if (mode !== 'draft') {
    if (current.state === 'draft' && !await step(() => api.validate(tenantId, current.id))) return false;
    if (hasPermission(live, 'campaign.approve') && !current.approved && !await step(() => api.approve(tenantId, current.id))) return false;
    if (hasPermission(live, 'campaign.launch') && current.approved && !await step(() => api.launch(tenantId, current.id, context.newKey(), scheduledFor))) return false;
  }
  const message = mode === 'draft' ? t(context, `حُفظت «${current.name}» كمسودة`, `“${current.name}” saved as a draft`)
    : current.execution === null ? t(context, `«${current.name}» جاهزة وبانتظار الاعتماد أو الإطلاق`, `“${current.name}” is ready and waiting for approval or launch`)
      : scheduledFor === null ? t(context, `بدأ إرسال «${current.name}»`, `“${current.name}” is sending`)
        : t(context, `جُدولت «${current.name}»`, `“${current.name}” is scheduled`);
  live.busy = null;
  live.revision += 1;
  live.selectedCampaignId = current.id;
  state.dialog = null;
  state.dialogForm = {};
  state.formErrors = {};
  pushToast(state, message);
  await loadCampaignsScreen(context);
  return true;
}

/**
 * A refused step. The campaign the earlier steps saved is kept and the wizard
 * reopens on it, so trying again edits that campaign rather than making a
 * second one.
 */
async function stop(context: LiveContext, error: ApiError, savedId: string | null): Promise<false> {
  const { state, live } = context;
  live.busy = null;
  live.revision += 1;
  if (savedId !== null) {
    state.dialog = { kind: 'campaign-edit', arg: savedId };
    live.selectedCampaignId = savedId;
    await loadCampaignsScreen(context);
  }
  live.error = error;
  context.refresh();
  return false;
}
