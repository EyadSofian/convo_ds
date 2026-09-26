import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import type { AudienceSource } from './audience.js';
import type { AudienceFilter } from '../api/campaigns.js';
import { AUDIENCE_SOURCES, audienceGap, conditionsFromFilter, editorAudience, previewKey, sourceOf } from './audience.js';
import { loadContactsScreen } from './contact-actions.js';
import { loadMetadataCatalog } from './metadata-catalog.js';
import { forTenant, fromResult, LOADING, rowsOf } from './store.js';

/**
 * The campaign editor's audience, against the real API: the catalogues the
 * sources pick from, a count before anything is frozen, and saving the
 * current choice as a reusable audience.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/** Reads the saved audiences once; later reads come from a save. */
export async function loadAudiences(context: LiveContext): Promise<void> {
  if (context.live.audiences.status !== 'idle') return;
  return forTenant(context, undefined, async (tenantId) => {
    context.live.audiences = LOADING;
    context.refresh();
    context.live.audiences = fromResult(await context.live.savedViewsApi.audiences(tenantId), context.now());
    context.refresh();
  });
}

/**
 * Everything the editor may offer, fetched when it is first needed: labels for
 * both label sources, the saved audiences, and the directory for hand-picking.
 */
export async function loadAudienceSources(context: LiveContext, source: AudienceSource): Promise<void> {
  const work: Promise<void>[] = [loadAudiences(context)];
  if (context.live.labels.status === 'idle') work.push(loadMetadataCatalog(context));
  if (source === 'picked' && context.live.contacts.status === 'idle') work.push(loadContactsScreen(context));
  await Promise.all(work);
}

/**
 * Opens the campaign editor — a new draft with an empty argument, or the draft
 * with that id — and fetches what its audience block lists, so the label chips
 * and saved audiences are there when the operator reaches them.
 */
export async function openCampaignEditor(context: LiveContext, arg: string): Promise<boolean> {
  const campaign = rowsOf(context.live.campaigns).find((entry) => entry.id === arg);
  context.state.dialog = arg === '' ? { kind: 'campaign', arg: '' } : { kind: 'campaign-edit', arg };
  context.state.openMenu = null;
  context.state.dialogForm = {};
  context.state.formErrors = {};
  context.live.error = null;
  context.live.audiencePreview = null;
  context.refresh();
  // The message step picks from the approved templates, and a variable can
  // read a contact field; both are fetched with the audience's catalogues.
  const work: Promise<void>[] = [loadAudienceSources(context, sourceOf((campaign?.audience_filter ?? {}) as AudienceFilter))];
  if (context.live.whatsappTemplates.status !== 'ready') work.push(loadWhatsAppTemplates(context));
  await Promise.all(work);
  return true;
}

/** Opens a saved audience on its own, to build and save one for later. */
export async function openAudienceDialog(context: LiveContext): Promise<boolean> {
  context.state.dialog = { kind: 'audience-new', arg: '' };
  context.state.dialogForm = { campaignAudienceSource: 'labels' };
  context.state.formErrors = {};
  context.live.error = null;
  context.live.audiencePreview = null;
  context.refresh();
  await loadAudienceSources(context, 'labels');
  return true;
}

/** Shows one bucket of the campaign list, or the saved audiences. */
export async function showCampaignView(context: LiveContext, arg: string): Promise<boolean> {
  const view = (['all', 'drafts', 'scheduled', 'sending', 'completed', 'audiences'] as const).find((entry) => entry === arg);
  if (view === undefined) return false;
  context.live.campaignView = view;
  context.refresh();
  if (view === 'audiences') await loadAudienceSources(context, 'labels');
  return true;
}

/** Retires a saved audience; broadcasts already frozen keep who they had. */
export async function retireAudience(context: LiveContext, id: string): Promise<boolean> {
  const audience = rowsOf(context.live.audiences).find((entry) => entry.id === id);
  if (audience === undefined) return false;
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = `audience-retire:${id}`;
    context.refresh();
    const result = await context.live.savedViewsApi.retireAudience(tenantId, id, audience.version);
    context.live.busy = null;
    if (!result.ok) {
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    context.live.audiences = { status: 'ready', value: rowsOf(context.live.audiences).filter((entry) => entry.id !== id), loadedAt: context.now() };
    pushToast(context.state, t(context, `أُزيل الجمهور «${audience.name}».`, `Audience “${audience.name}” removed.`));
    context.refresh();
    return true;
  });
}

/** The approved WhatsApp templates the broadcast wizard and automations pick from. */
export async function loadWhatsAppTemplates(context: LiveContext): Promise<void> {
  return forTenant(context, undefined, async (tenantId) => {
    context.live.whatsappTemplates = LOADING;
    context.refresh();
    context.live.whatsappTemplates = fromResult(await context.live.automationsApi.whatsappTemplates(tenantId), context.now());
    context.refresh();
  });
}

/** Switches where the audience comes from, and fetches what that source lists. */
export async function chooseAudienceSource(context: LiveContext, arg: string): Promise<boolean> {
  const source = AUDIENCE_SOURCES.find((entry) => entry === arg);
  if (source === undefined) return false;
  context.state.dialogForm = { ...context.state.dialogForm, campaignAudienceSource: source };
  context.state.formErrors = {};
  context.refresh();
  await loadAudienceSources(context, source);
  return true;
}

/** Tells the operator what is still missing, on the audience field. */
export function audienceProblem(context: LiveContext): string | null {
  const { draft, filter } = editorAudience(context.state);
  const gap = audienceGap(draft, filter);
  if (gap === null) return null;
  const messages: Readonly<Record<typeof gap, readonly [string, string]>> = {
    labels: ['اختر تصنيفًا واحدًا على الأقل.', 'Choose at least one label.'],
    conversations: ['اختر تصنيف محادثة واحدًا على الأقل.', 'Choose at least one conversation label.'],
    picked: ['اختر جهة اتصال واحدة على الأقل.', 'Pick at least one contact.'],
    saved: ['اختر جمهورًا محفوظًا صالحًا للحملات.', 'Choose a saved audience a campaign can use.'],
  };
  const [ar, en] = messages[gap];
  return t(context, ar, en);
}

/** Counts the audience on screen without freezing it. */
export async function previewCampaignAudience(context: LiveContext): Promise<boolean> {
  const problem = audienceProblem(context);
  const { filter, connectionId } = editorAudience(context.state);
  if (problem !== null || filter === null || connectionId === '') {
    context.state.formErrors = { campaignAudience: problem ?? t(context, 'اختر قناة أولًا.', 'Choose a channel first.') };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    const key = previewKey(connectionId, filter);
    context.state.formErrors = {};
    context.live.audiencePreview = { key, result: LOADING };
    context.refresh();
    const result = await context.live.campaignsApi.previewAudience(tenantId, connectionId, filter);
    context.live.audiencePreview = { key, result: fromResult(result, context.now()) };
    context.refresh();
    return result.ok;
  });
}

/**
 * Saves the audience on screen for reuse, then selects it, so the draft now
 * reads "this saved audience" rather than an anonymous copy of it.
 */
export async function saveCampaignAudience(context: LiveContext): Promise<boolean> {
  const name = (context.state.dialogForm['campaignAudienceName'] ?? '').trim();
  const { filter } = editorAudience(context.state);
  const conditions = filter === null ? null : conditionsFromFilter(filter);
  if (name === '' || conditions === null || audienceProblem(context) !== null) {
    context.state.formErrors = {
      campaignAudienceName: name === ''
        ? t(context, 'سمِّ الجمهور قبل حفظه.', 'Name the audience before saving it.')
        : t(context, 'ضيّق الجمهور أولًا؛ «كل من على القناة» لا يحتاج حفظًا.', 'Narrow the audience first; “everyone on the channel” needs no saving.'),
    };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    context.live.busy = 'audience-save';
    context.refresh();
    const result = await context.live.savedViewsApi.createAudience(tenantId, { name, description: null, conditions });
    context.live.busy = null;
    if (!result.ok) {
      context.state.formErrors = { campaignAudienceName: result.error.message };
      context.refresh();
      return false;
    }
    context.live.audiences = { status: 'ready', value: [...(context.live.audiences.status === 'ready' ? context.live.audiences.value : []), result.data], loadedAt: context.now() };
    if (context.state.dialog?.kind === 'audience-new') {
      // Made on its own, the audience is done once it is saved.
      context.state.dialog = null;
      context.state.dialogForm = {};
    } else {
      context.state.dialogForm = { ...context.state.dialogForm, campaignAudienceSource: 'saved', campaignSavedAudience: result.data.id, campaignAudienceName: '' };
    }
    pushToast(context.state, t(context, `حُفظ الجمهور «${name}».`, `Audience “${name}” saved.`));
    context.refresh();
    return true;
  });
}
