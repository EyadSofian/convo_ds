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
  await loadAudienceSources(context, sourceOf((campaign?.audience_filter ?? {}) as AudienceFilter));
  return true;
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
    context.state.dialogForm = { ...context.state.dialogForm, campaignAudienceSource: 'saved', campaignSavedAudience: result.data.id, campaignAudienceName: '' };
    pushToast(context.state, t(context, `حُفظ الجمهور «${name}».`, `Audience “${name}” saved.`));
    context.refresh();
    return true;
  });
}
