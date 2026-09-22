import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ApiResult } from '../api/client.js';
import type { SavedView, SavedViewsApi } from '../api/saved-views.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { applySavedView, loadSavedViews, retireSavedView, saveCurrentInboxView } from './saved-view-actions.js';

const ERROR: ApiError = { code: 'refused', message: 'No', requestId: 'r', status: 409, details: [] };
const CONDITIONS = { version: 1 as const, root: { kind: 'group' as const, match: 'all' as const, conditions: [{ kind: 'predicate' as const, field: 'priority', operator: 'eq' as const, value: 'high' }] } };
const VIEW: SavedView = { id: 'view-1', ownerMembershipId: 'member-1', teamId: null, name: 'High priority', resource: 'conversations', visibility: 'private', conditions: CONDITIONS, version: 2 };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T = never>(): ApiResult<T> => ({ ok: false, error: ERROR });

function setup(tenantId: string | null = 'tenant-1') {
  const state = createState(new Date('2026-09-17T00:00:00Z'));
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId };
  state.live.savedViews = { status: 'ready', value: [VIEW], loadedAt: 1 };
  const api = {
    list: vi.fn().mockResolvedValue(ok([VIEW])),
    create: vi.fn().mockResolvedValue(ok(VIEW)),
    update: vi.fn().mockResolvedValue(ok(VIEW)),
    retire: vi.fn().mockResolvedValue(ok(undefined)),
  } as unknown as SavedViewsApi;
  Object.defineProperty(state.live, 'savedViewsApi', { value: api });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'key', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, api };
}

describe('saved view actions', () => {
  it('loads only for an active tenant and preserves refusal', async () => {
    const absent = setup(null);
    await loadSavedViews(absent.context);
    expect(absent.api.list).not.toHaveBeenCalled();
    const refused = setup();
    vi.mocked(refused.api.list).mockResolvedValueOnce(fail());
    await loadSavedViews(refused.context);
    expect(refused.state.live.savedViews).toEqual({ status: 'error', error: ERROR });
    const loaded = setup();
    await loadSavedViews(loaded.context);
    expect(loaded.api.list).toHaveBeenCalledWith('tenant-1');
    expect(loaded.state.live.savedViews).toMatchObject({ status: 'ready', value: [VIEW] });
    vi.mocked(loaded.api.list).mockResolvedValueOnce(ok([]));
    await loadSavedViews(loaded.context);
    expect(loaded.state.live.savedViews).toMatchObject({ status: 'ready', value: [] });
  });

  it('refuses missing or unsafe views and applies supported filters', async () => {
    const missing = setup(null);
    expect(await applySavedView(missing.context, 'missing')).toBe(false);
    const legacy = setup();
    legacy.state.live.savedViews = { status: 'ready', value: [{ ...VIEW, conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'campaign_name', operator: 'eq', value: 'legacy' }] } } }], loadedAt: 1 };
    expect(await applySavedView(legacy.context, VIEW.id)).toBe(false);
    expect(legacy.state.toasts.at(-1)?.text).toContain('Campaign filter');
    legacy.state.live.savedViews = { status: 'ready', value: [{ ...VIEW, conditions: { version: 1, root: { kind: 'group', match: 'any', conditions: [{ kind: 'predicate', field: 'priority', operator: 'eq', value: 'high' }] } } as SavedView['conditions'] }], loadedAt: 1 };
    expect(await applySavedView(legacy.context, VIEW.id)).toBe(false);
    expect(legacy.state.toasts.at(-1)?.text).toContain('cannot be applied safely');
    const supported = setup(null);
    expect(await applySavedView(supported.context, VIEW.id)).toBe(true);
    expect(supported.state.live.selectedSavedViewId).toBe(VIEW.id);
    expect(supported.state.live.inboxQuery.filters).toEqual([{ key: 'priority', operator: 'eq', value: 'high' }]);
    expect(supported.state.inboxQueue).toBe('mine');
  });

  it('creates and updates server-backed views with validation and refusal handling', async () => {
    const noTenant = setup(null);
    noTenant.state.dialogForm = { savedViewName: 'Private', savedViewVisibility: 'private' };
    noTenant.state.live.inboxQuery = { ...noTenant.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(noTenant.context, 'create')).toBe(false);
    expect(noTenant.api.create).not.toHaveBeenCalled();

    const unsupported = setup();
    unsupported.state.lang = 'ar';
    unsupported.state.dialogForm = { savedViewName: 'Legacy', savedViewVisibility: 'private' };
    unsupported.state.live.inboxQuery = { ...unsupported.state.live.inboxQuery, filters: [{ key: 'unsupported', operator: 'eq', value: 'x' } as never] };
    expect(await saveCurrentInboxView(unsupported.context, 'create')).toBe(false);
    expect(unsupported.state.toasts.at(-1)?.text).toContain('أضف فلترًا مدعومًا');

    const invalid = setup();
    expect(await saveCurrentInboxView(invalid.context, 'create')).toBe(false);
    invalid.state.dialogForm = { savedViewName: 'High', savedViewVisibility: 'team', savedViewTeamId: 'team-1' };
    invalid.state.live.inboxQuery = { ...invalid.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(invalid.context, 'create')).toBe(true);
    expect(invalid.api.create).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ name: 'High', visibility: 'team', teamId: 'team-1' }));
    const update = setup();
    update.state.live.selectedSavedViewId = VIEW.id;
    update.state.dialogForm = { savedViewName: 'Renamed', savedViewVisibility: 'private' };
    update.state.live.inboxQuery = { ...update.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(update.context, 'update')).toBe(true);
    expect(update.api.update).toHaveBeenCalledWith('tenant-1', VIEW.id, VIEW.version, expect.objectContaining({ name: 'Renamed', teamId: null }));
    const refused = setup();
    refused.state.dialogForm = { savedViewName: 'High', savedViewVisibility: 'private' };
    refused.state.live.inboxQuery = { ...refused.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    vi.mocked(refused.api.create).mockResolvedValueOnce(fail());
    expect(await saveCurrentInboxView(refused.context, 'create')).toBe(false);
    expect(refused.state.live.error).toEqual(ERROR);
    const invalidVisibility = setup();
    invalidVisibility.state.dialogForm = { savedViewName: 'Bad visibility', savedViewVisibility: 'organization' };
    invalidVisibility.state.live.inboxQuery = { ...invalidVisibility.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(invalidVisibility.context, 'create')).toBe(false);
    expect(invalidVisibility.api.create).not.toHaveBeenCalled();
    const missingUpdate = setup();
    missingUpdate.state.dialogForm = { savedViewName: 'Missing', savedViewVisibility: 'private' };
    missingUpdate.state.live.inboxQuery = { ...missingUpdate.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(missingUpdate.context, 'update')).toBe(false);
    const loadingUpdate = setup();
    loadingUpdate.state.live.savedViews = { status: 'loading' };
    loadingUpdate.state.dialogForm = { savedViewName: 'High', savedViewVisibility: 'private' };
    loadingUpdate.state.live.inboxQuery = { ...loadingUpdate.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(loadingUpdate.context, 'update')).toBe(false);
    const workspace = setup();
    workspace.state.dialogForm = { savedViewName: 'Workspace', savedViewVisibility: 'workspace' };
    workspace.state.live.inboxQuery = { ...workspace.state.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    expect(await saveCurrentInboxView(workspace.context, 'create')).toBe(true);
    expect(workspace.api.create).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ visibility: 'workspace', teamId: null }));
  });

  it('retires a view and clears the selected id only after success', async () => {
    const app = setup();
    app.state.live.selectedSavedViewId = VIEW.id;
    expect(await retireSavedView(app.context, VIEW.id)).toBe(true);
    expect(app.api.retire).toHaveBeenCalledWith('tenant-1', VIEW.id, VIEW.version);
    expect(app.state.live.selectedSavedViewId).toBeNull();
    const refused = setup();
    vi.mocked(refused.api.retire).mockResolvedValueOnce(fail());
    expect(await retireSavedView(refused.context, VIEW.id)).toBe(false);
    expect(refused.state.live.error).toEqual(ERROR);
    expect(await retireSavedView(refused.context, 'missing')).toBe(false);
    const noTenant = setup(null);
    expect(await retireSavedView(noTenant.context, VIEW.id)).toBe(false);
    noTenant.state.live.savedViews = { status: 'loading' };
    expect(await applySavedView(noTenant.context, VIEW.id)).toBe(false);
    expect(await retireSavedView(noTenant.context, VIEW.id)).toBe(false);
  });
});
