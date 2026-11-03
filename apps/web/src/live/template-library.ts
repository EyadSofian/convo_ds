import { filterLibrary } from '../ui/template-library.js';
import type { LiveContext } from './actions.js';
import { forTenant, LOADING, ready, failed } from './store.js';
import { pushToast } from '../state.js';

export async function openTemplateLibrary(context: LiveContext, reload = false): Promise<boolean> {
  if (context.live.busy !== null) return false;
  if (!reload) {
    context.state.dialog = { kind: 'template-library', arg: '' };
    context.state.dialogForm = {};
    context.state.formErrors = {};
  }
  return forTenant(context, false, async (tenantId) => {
    context.live.templateLibrary = LOADING;
    context.live.error = null;
    context.refresh();
    const result = await context.live.channels.templateLibrary(tenantId);
    context.live.templateLibrary = result.ok ? ready(result.data, context.now()) : failed(result.error);
    context.refresh();
    return result.ok;
  });
}

export async function saveTemplateAccess(context: LiveContext): Promise<boolean> {
  const { state, live } = context;
  if (state.dialog?.kind !== 'template-library' || live.busy !== null || live.templateLibrary.status !== 'ready') return false;
  const templates = live.templateLibrary.value.templates.filter((row) => state.dialogForm[`libraryPick_${row.id}`] === 'true').map((row) => ({ id: row.id, version: row.version }));
  const visibility = state.dialogForm['libraryVisibility'] === 'teams' ? 'teams' : 'all';
  const teamIds = visibility === 'all' ? [] : live.templateLibrary.value.teams.filter((row) => state.dialogForm[`libraryTeam_${row.id}`] === 'true').map((row) => row.id);
  if (templates.length === 0 || templates.length > 200 || (visibility === 'teams' && teamIds.length === 0)) {
    state.formErrors = { templateLibrary: state.lang === 'ar' ? 'اختر من ١ إلى ٢٠٠ قالب وتيمًا واحدًا على الأقل، أو اختر الجميع.' : 'Select 1–200 templates and at least one team, or choose everyone.' };
    context.refresh();
    return false;
  }
  return forTenant(context, false, async (tenantId) => {
    live.busy = 'template-access-save';
    live.error = null;
    state.formErrors = {};
    context.refresh();
    const result = await live.channels.updateTemplateAccess(tenantId, { templates, visibility, teamIds });
    live.busy = null;
    if (!result.ok) { live.error = result.error; context.refresh(); return false; }
    pushToast(state, state.lang === 'ar' ? `تم تحديث إتاحة ${result.data.updated} قالب.` : `Updated access for ${result.data.updated} templates.`);
    for (const row of templates) delete state.dialogForm[`libraryPick_${row.id}`];
    await openTemplateLibrary(context, true);
    return true;
  });
}

export function pickLibraryResults(context: LiveContext, clear = false): boolean {
  if (context.state.dialog?.kind !== 'template-library' || context.live.busy !== null || context.live.templateLibrary.status !== 'ready') return false;
  const rows = clear ? context.live.templateLibrary.value.templates : filterLibrary(context.state, context.live.templateLibrary.value.templates);
  for (const row of rows) context.state.dialogForm[`libraryPick_${row.id}`] = String(!clear);
  context.refresh();
  return true;
}

export function editTemplateAccess(context: LiveContext, id: string): boolean {
  if (context.live.busy !== null || context.live.templateLibrary.status !== 'ready') return false;
  const library = context.live.templateLibrary.value;
  const row = library.templates.find((entry) => entry.id === id);
  if (row === undefined) return false;
  for (const item of library.templates) delete context.state.dialogForm[`libraryPick_${item.id}`];
  for (const team of library.teams) delete context.state.dialogForm[`libraryTeam_${team.id}`];
  context.state.dialogForm[`libraryPick_${row.id}`] = 'true';
  context.state.dialogForm['libraryVisibility'] = row.visibility;
  context.state.dialogForm['libraryPreview'] = row.id;
  for (const teamId of row.teamIds) context.state.dialogForm[`libraryTeam_${teamId}`] = 'true';
  context.refresh();
  return true;
}
