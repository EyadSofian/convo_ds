import { adaptSavedViewToInboxFilters, inboxFiltersToSavedViewDocument } from '@convo/domain';
import type { SavedViewVisibility } from '../api/saved-views.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { currentTenantId, fromResult, LOADING } from './store.js';
import { loadInboxScreen } from './inbox-actions.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function loadSavedViews(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  context.live.savedViews = LOADING;
  context.refresh();
  const result = await context.live.savedViewsApi.list(tenantId);
  context.live.savedViews = fromResult(result, context.now());
  context.refresh();
}

export async function applySavedView(context: LiveContext, id: string): Promise<boolean> {
  const views = context.live.savedViews;
  const view = views.status === 'ready' ? views.value.find((candidate) => candidate.id === id) : undefined;
  if (view === undefined) return false;
  const adapted = adaptSavedViewToInboxFilters(view.conditions);
  if (adapted.status !== 'supported') {
    const message = adapted.code === 'campaign_name_deprecated'
      ? t(context, 'فلتر الحملة لم يعد مدعومًا. أعد تهيئته باستخدام حملة محددة.', 'Campaign filter no longer supported. Reconfigure it with a specific campaign.')
      : t(context, 'لا يمكن تطبيق هذا العرض المحفوظ بأمان.', 'This saved view cannot be applied safely.');
    pushToast(context.state, message, 'warning');
    context.refresh();
    return false;
  }
  context.live.selectedSavedViewId = id;
  context.live.inboxQuery = { ...context.live.inboxQuery, filters: adapted.filters, cursor: null };
  context.state.inboxQueue = 'mine';
  await loadInboxScreen(context);
  return true;
}

export async function saveCurrentInboxView(context: LiveContext, mode: 'create' | 'update'): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return false;
  const name = (context.state.dialogForm['savedViewName'] ?? '').trim();
  const visibility = context.state.dialogForm['savedViewVisibility'] ?? 'private';
  const teamId = context.state.dialogForm['savedViewTeamId'] ?? '';
  if (name === '' || !isVisibility(visibility) || (visibility === 'team' && teamId === '')) return false;
  const converted = inboxFiltersToSavedViewDocument(context.live.inboxQuery.filters);
  if (converted.status !== 'supported') {
    pushToast(context.state, t(context, 'أضف فلترًا مدعومًا واحدًا على الأقل قبل حفظ العرض.', 'Add at least one supported filter before saving this view.'), 'warning');
    context.refresh();
    return false;
  }
  const input = {
    name,
    resource: 'conversations' as const,
    visibility,
    teamId: visibility === 'team' ? teamId : null,
    conditions: converted.document,
  };
  const selected = context.live.selectedSavedViewId;
  const current = context.live.savedViews.status === 'ready'
    ? context.live.savedViews.value.find((view) => view.id === selected)
    : undefined;
  if (mode === 'update' && current === undefined) return false;

  context.live.busy = mode === 'create' ? 'saved-view-create' : `saved-view-update:${current!.id}`;
  context.live.error = null;
  context.refresh();
  const result = mode === 'create'
    ? await context.live.savedViewsApi.create(tenantId, input)
    : await context.live.savedViewsApi.update(tenantId, current!.id, current!.version, input);
  context.live.busy = null;
  if (!result.ok) {
    context.live.error = result.error;
    context.refresh();
    return false;
  }
  context.live.selectedSavedViewId = result.data.id;
  context.state.dialog = null;
  context.state.dialogForm = {};
  pushToast(context.state, mode === 'create'
    ? t(context, 'حُفظ العرض.', 'View saved.')
    : t(context, 'حُدّث العرض.', 'View updated.'));
  await loadSavedViews(context);
  return true;
}

export async function retireSavedView(context: LiveContext, id: string): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  const view = context.live.savedViews.status === 'ready'
    ? context.live.savedViews.value.find((candidate) => candidate.id === id)
    : undefined;
  if (tenantId === null || view === undefined) return false;
  context.live.busy = `saved-view-retire:${id}`;
  context.live.error = null;
  context.refresh();
  const result = await context.live.savedViewsApi.retire(tenantId, id, view.version);
  context.live.busy = null;
  if (!result.ok) {
    context.live.error = result.error;
    context.refresh();
    return false;
  }
  if (context.live.selectedSavedViewId === id) context.live.selectedSavedViewId = null;
  pushToast(context.state, t(context, 'حُذف العرض المحفوظ.', 'Saved view deleted.'));
  await loadSavedViews(context);
  return true;
}

function isVisibility(value: string): value is SavedViewVisibility {
  return value === 'private' || value === 'team' || value === 'workspace';
}
