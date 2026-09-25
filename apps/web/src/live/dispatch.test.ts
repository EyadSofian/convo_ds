import { describe, expect, it, vi } from 'vitest';
import { createState } from '../state.js';
import { ready } from './store.js';
import type { LiveContext } from './actions.js';
import { LIVE_ACTIONS, roleNameField, splitArg, teamMemberField } from './dispatch.js';

/**
 * The naming rules the DOM and the dispatcher have to agree on.
 *
 * A form value reaches the dispatcher as `"<key>:<value>"`, so a key that
 * contains a colon stores the wrong thing under the wrong name — silently, and
 * only for the controls that happen to use one. These are the two places that
 * build such a key, and the one function that takes it apart again.
 */

describe('splitArg', () => {
  it('splits an id from its value', () => {
    expect(splitArg('m-1:supervisor')).toEqual({ id: 'm-1', value: 'supervisor' });
  });

  it('keeps everything after the first colon, because a value may contain one', () => {
    expect(splitArg('t-1:a:b')).toEqual({ id: 't-1', value: 'a:b' });
  });

  it('reads an argument with no separator as all id and no value', () => {
    // What a control rendered without a form key produces. Answering rather
    // than throwing keeps one malformed control from taking the screen down;
    // the empty value is then rejected by the parser on the server.
    expect(splitArg('t-1')).toEqual({ id: 't-1', value: '' });
    expect(splitArg('')).toEqual({ id: '', value: '' });
  });
});

describe('form keys', () => {
  it('never contain the separator the DOM uses', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    expect(teamMemberField(id)).toBe(`teamMember_${id}`);
    expect(roleNameField(id)).toBe(`roleName_${id}`);
    expect(teamMemberField(id)).not.toContain(':');
    expect(roleNameField(id)).not.toContain(':');
  });
});

/**
 * The automation entries in the dispatch table.
 *
 * These are one-line adapters between a DOM `data-act` and an action, and that
 * is exactly why they are worth a test: nothing else checks that the name the
 * screen renders is the name the table answers to, or that the argument is
 * passed through in the shape the action expects. A typo in either is a button
 * that silently does nothing.
 */
describe('the automation actions the DOM can name', () => {
  function context() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    return {
      state,
      live: state.live,
      refresh: vi.fn(),
      now: () => 1,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as LiveContext;
  }

  it('rejects a sign-in with no password field without sending credentials', async () => {
    const ctx = context();
    ctx.state.dialogForm = { signinEmail: 'agent@example.test' };
    await expect(LIVE_ACTIONS['live-signin']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.state.formErrors['signinPassword']).toBeTruthy();
  });

  it('registers the reload action, which loads rather than mutating', async () => {
    // It answers void rather than a boolean: there is nothing to confirm, and
    // with no workspace selected it declines to fetch at all.
    const handler = LIVE_ACTIONS['live-automations-reload'];
    expect(handler).toBeDefined();
    await expect(handler?.(context(), '')).resolves.toBeUndefined();
  });

  it.each([
    'live-automation-use',
    'live-automation-save',
    'live-automation-add-step',
    'live-automation-remove-step',
    'live-automation-transition',
  ])('registers %s and answers without throwing', async (name) => {
    // No workspace is selected, so every one of these declines rather than
    // acting — which is the property under test: the handler exists, runs, and
    // fails closed.
    const handler = LIVE_ACTIONS[name];
    expect(handler, `${name} is not registered`).toBeDefined();
    await expect(handler?.(context(), 'a-1:activate')).resolves.toBe(false);
  });

  it('assigns a role to nobody while no workspace is selected', async () => {
    const ctx = context();
    ctx.state.dialogForm = { assignPicked: 'm-1' };
    await expect(LIVE_ACTIONS['live-role-assign']?.(ctx, 'r-1')).resolves.toBe(false);
    expect(ctx.state.dialogForm['assignPicked']).toBe('m-1');
  });

  it('refuses to create a blank automation with no name, and does not clear the form', async () => {
    const ctx = context();
    ctx.state.dialogForm = { automationBlankName: '   ' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
    // The operator's other typing survives a refused submit.
    expect(ctx.state.dialogForm['automationBlankName']).toBe('   ');
  });

  it('clears the form once the server has committed the new automation', async () => {
    // The dialog only empties after a confirmed create, so a refusal never
    // loses what the operator typed.
    const ctx = context();
    ctx.state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
    // A successful create reloads the screen, so every read the reload makes
    // has to answer too.
    const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
    Object.defineProperty(ctx.live, 'automationsApi', {
      value: {
        create: vi.fn().mockResolvedValue({ ok: true, data: { id: 'a-1' } }),
        templates: vi.fn(() => ok([])),
        whatsappTemplates: vi.fn(() => ok([])),
        list: vi.fn(() => ok([])),
        runs: vi.fn(() => ok([])),
      },
    });
    ctx.state.dialogForm = { automationBlankName: 'Welcome flow' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(true);
    expect(ctx.state.dialogForm).toEqual({});
  });

  it('declines when the dialog has no name field at all', async () => {
    const ctx = context();
    ctx.state.dialogForm = {};
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
  });

  it('keeps the form when creation is declined by the server', async () => {
    const ctx = context();
    ctx.state.dialogForm = { automationBlankName: 'Welcome flow' };
    await expect(LIVE_ACTIONS['live-automation-create']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.state.dialogForm['automationBlankName']).toBe('Welcome flow');
  });
});

describe('automation, supervisor, label, and Inbox dispatch contracts', () => {
  function active() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
    const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'test-key', endSession: vi.fn(), switchWorkspace: vi.fn() };
    return { state, context };
  }

  function inboxReads(ctx: LiveContext) {
    Object.defineProperty(ctx.live, 'conversationsApi', { value: {
      unassigned: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      list: vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } }),
    } });
    ctx.live.labels = { status: 'ready', value: [], loadedAt: 1 };
    ctx.live.savedViews = { status: 'ready', value: [], loadedAt: 1 };
    ctx.live.people = { status: 'ready', value: [], loadedAt: 1 };
    ctx.live.teams = { status: 'ready', value: [], loadedAt: 1 };
    ctx.live.connections = { status: 'ready', value: [], loadedAt: 1 };
    ctx.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
  }

  it('normalizes automation state and sort before sending the list query', async () => {
    const { state, context } = active();
    const list = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
    Object.defineProperty(context.live, 'automationsApi', { value: { list } });
    state.dialogForm = { automationSearch: '  welcome ', automationState: 'not-a-state', automationSort: 'bad-sort' };
    await LIVE_ACTIONS['live-automation-filter']?.(context, '');
    expect(list).toHaveBeenLastCalledWith('tenant-1', { search: 'welcome', state: '', sort: 'updated_desc', limit: 25, cursor: null });
    state.dialogForm = { automationSearch: '', automationState: 'paused', automationSort: 'name_desc' };
    await LIVE_ACTIONS['live-automation-filter']?.(context, '');
    expect(list).toHaveBeenLastCalledWith('tenant-1', { search: '', state: 'paused', sort: 'name_desc', limit: 25, cursor: null });
    state.dialogForm = {};
    await LIVE_ACTIONS['live-automation-filter']?.(context, '');
    expect(list).toHaveBeenLastCalledWith('tenant-1', { search: '', state: '', sort: 'updated_desc', limit: 25, cursor: null });
  });

  it('accepts only registered analytics views and removes stale view params for campaigns', async () => {
    const { state, context } = active();
    state.route = { screen: 'analytics', conversationId: null, params: { view: 'agents', keep: 'yes' } };
    for (const view of ['overview', 'agents', 'teams', 'responses', 'resolutions', 'assignments', 'channels'] as const) {
      await expect(LIVE_ACTIONS['analytics-view']?.(context, view)).resolves.toBe(true);
      expect(state.analyticsView).toBe(view);
      expect(state.route.params).toEqual({ view, keep: 'yes' });
    }
    await expect(LIVE_ACTIONS['analytics-view']?.(context, 'campaigns')).resolves.toBe(true);
    expect(state.analyticsView).toBe('campaigns');
    expect(state.route.params).toEqual({ keep: 'yes' });
    await expect(LIVE_ACTIONS['analytics-view']?.(context, 'unknown')).resolves.toBe(false);
  });

  it('confirms draft deletion through the dispatcher and closes only on success', async () => {
    const { state, context } = active();
    const draft = { id: 'draft-1', state: 'draft', version: 1 };
    const deleteDraft = vi.fn().mockResolvedValue({ ok: true, data: { id: 'draft-1' } });
    Object.defineProperty(context.live, 'automationsApi', { value: { deleteDraft } });
    context.live.automations = { status: 'ready', value: [draft as never], loadedAt: 1 };
    state.dialog = { kind: 'confirm', arg: 'draft-1' } as never;
    expect(await LIVE_ACTIONS['live-automation-delete-confirm']?.(context, 'draft-1')).toBe(true);
    expect(deleteDraft).toHaveBeenCalledWith('tenant-1', draft);
    expect(state.dialog).toBeNull();
  });

  it('dispatches automation and paginated report continuation queries', async () => {
    const { state, context } = active();
    const list = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
    const runs = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
    Object.defineProperty(context.live, 'automationsApi', { value: { list, runs } });
    context.live.automationNextCursor = 'automation-next';
    await LIVE_ACTIONS['live-automation-load-more']?.(context, '');
    expect(list).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ cursor: 'automation-next' }));
    state.dialogForm = { automationRunsLimit: '50' };
    await LIVE_ACTIONS['live-automation-runs-filter']?.(context, '');
    expect(runs).toHaveBeenLastCalledWith('tenant-1', { limit: 50, cursor: null });
    context.live.automationRunsNextCursor = 'run-next';
    await LIVE_ACTIONS['live-automation-runs-load-more']?.(context, '');
    expect(runs).toHaveBeenLastCalledWith('tenant-1', { limit: 50, cursor: 'run-next' });
    state.dialogForm = {};
    await LIVE_ACTIONS['live-automation-runs-filter']?.(context, '');
    expect(runs).toHaveBeenLastCalledWith('tenant-1', { limit: 25, cursor: null });

    const assignmentRows = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
    Object.defineProperty(context.live, 'campaignsApi', { value: { assignmentsReport: assignmentRows } });
    context.live.operationalReport = { status: 'ready', value: {} as never, loadedAt: 1 };
    context.live.assignmentNextCursor = 'assignment-next';
    context.live.assignmentReport = { status: 'ready', value: [], loadedAt: 1 };
    await LIVE_ACTIONS['live-assignments-more']?.(context, '');
    expect(assignmentRows).toHaveBeenCalledWith('tenant-1', state.analyticsFilters, 'assignment-next', 50);
  });

  it('opens the supervisor picker and selected workload through registered handlers', async () => {
    const { context, state } = active();
    const agentId = '11111111-1111-4111-8111-111111111111';
    const supervisorAgents = vi.fn().mockResolvedValue({ ok: true, data: [{ membershipId: agentId, name: 'Agent', email: 'a@test.local', teams: [] }] });
    const supervisorList = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    const supervisorWorkload = vi.fn().mockResolvedValue({ ok: true, data: { agent: { membershipId: agentId }, current: {}, byStatus: [], byChannel: [] } });
    const unassigned = vi.fn().mockResolvedValue({ ok: true, data: [] });
    const list = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    Object.defineProperty(context.live, 'conversationsApi', { value: { supervisorAgents, supervisorList, supervisorWorkload, unassigned, list } });
    context.live.labels = { status: 'ready', value: [], loadedAt: 1 };
    context.live.savedViews = { status: 'ready', value: [], loadedAt: 1 };
    context.live.people = { status: 'ready', value: [], loadedAt: 1 };
    context.live.teams = { status: 'ready', value: [], loadedAt: 1 };
    context.live.connections = { status: 'ready', value: [], loadedAt: 1 };
    context.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
    await LIVE_ACTIONS['live-supervisor-open']?.(context, '');
    expect(supervisorAgents).toHaveBeenCalledWith('tenant-1');
    expect(state.supervisorPickerOpen).toBe(true);
    await LIVE_ACTIONS['live-supervisor-open']?.(context, '');
    expect(state.supervisorPickerOpen).toBe(false);
    await LIVE_ACTIONS['live-supervisor-open']?.(context, '');
    expect(state.supervisorPickerOpen).toBe(true);
    expect(await LIVE_ACTIONS['live-supervisor-agent']?.(context, agentId)).toBe(true);
    expect(supervisorList).toHaveBeenCalledWith('tenant-1', agentId, expect.objectContaining({ cursor: null }));
    expect(supervisorWorkload).toHaveBeenCalledWith('tenant-1', agentId);
    expect(context.live.supervisorAgentId).toBe(agentId);
    expect(await LIVE_ACTIONS['live-supervisor-open']?.(context, '')).toBe(true);
    expect(context.live.supervisorAgentId).toBeNull();
    expect(state.supervisorPickerOpen).toBe(false);
    expect(unassigned).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
  });

  it('validates and normalizes label HEX through the public create action', async () => {
    const { state, context } = active();
    const createLabel = vi.fn().mockResolvedValue({ ok: true, data: { id: 'label-1' } });
    const metadataApi = { createLabel, labels: vi.fn().mockResolvedValue({ ok: true, data: [] }), fields: vi.fn().mockResolvedValue({ ok: true, data: [] }) };
    Object.defineProperty(context.live, 'metadataApi', { value: metadataApi });
    state.dialogForm = { labelName: 'VIP', labelColor: '#abc' };
    expect(await LIVE_ACTIONS['live-workspace-label-create']?.(context, '')).toBe(false);
    expect(createLabel).not.toHaveBeenCalled();
    expect(state.formErrors['labelColor']).toBeTruthy();
    state.dialogForm = { labelName: 'VIP', labelColor: '#aa33ff' };
    expect(await LIVE_ACTIONS['live-workspace-label-create']?.(context, '')).toBe(true);
    expect(createLabel).toHaveBeenCalledWith('tenant-1', 'VIP', '#AA33FF');
  });

  it('validates the Instagram linked Page and saves it through the channel API', async () => {
    const { state, context } = active();
    const setInstagramPage = vi.fn().mockResolvedValue({ ok: true, data: { id: 'ig-1' } });
    Object.defineProperty(context.live, 'channels', { value: {
      setInstagramPage,
      connections: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      catalogue: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    } });
    state.dialogForm = { channelPage_ig1: 'not-numeric' };
    expect(await LIVE_ACTIONS['live-instagram-page']?.(context, 'ig1')).toBe(false);
    expect(setInstagramPage).not.toHaveBeenCalled();
    state.dialogForm = { channelPage_ig1: '483612954841071' };
    expect(await LIVE_ACTIONS['live-instagram-page']?.(context, 'ig1')).toBe(true);
    expect(setInstagramPage).toHaveBeenCalledWith('tenant-1', 'ig1', '483612954841071');
    expect(state.dialogForm['channelPage_ig1']).toBeUndefined();
  });

  it('requires a linked Page for Instagram and carries it only for that connection kind', async () => {
    const { state, context } = active();
    const connect = vi.fn().mockResolvedValue({ ok: true, data: { id: 'new-channel', display_name: 'Test channel' } });
    Object.defineProperty(context.live, 'channels', { value: {
      connect,
      connections: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      catalogue: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    } });
    state.dialog = { kind: 'connect-channel', arg: 'instagram' };
    state.dialogForm = { channelProviderApp: '123', channelAsset: '456', channelName: 'Test channel', channelToken: 'test-token' };
    expect(await LIVE_ACTIONS['live-connect-channel']?.(context, '')).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(state.formErrors['channelPage']).toBeTruthy();
    state.dialogForm['channelPage'] = '789';
    expect(await LIVE_ACTIONS['live-connect-channel']?.(context, '')).toBe(true);
    expect(connect).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      kind: 'instagram', settings: { facebookPageId: '789' }, providerAppId: '123',
    }), 'test-key');
    expect(state.dialogForm).toEqual({});

    state.dialog = { kind: 'connect-channel', arg: 'custom' };
    state.dialogForm = { channelAsset: 'custom-1', channelName: 'Test channel', channelToken: 'test-token' };
    expect(await LIVE_ACTIONS['live-connect-channel']?.(context, '')).toBe(true);
    expect(connect).toHaveBeenLastCalledWith('tenant-1', expect.objectContaining({
      kind: 'custom', providerAppId: null,
    }), 'test-key');
    expect(connect.mock.calls.at(-1)?.[1]).not.toHaveProperty('settings');
  });

  it('routes saved-view create, update, and retire actions to the server', async () => {
    const { state, context } = active();
    inboxReads(context);
    context.live.inboxQuery = { ...context.live.inboxQuery, filters: [{ key: 'priority', operator: 'eq', value: 'high' }] };
    const saved = { id: 'view-1', ownerMembershipId: 'owner-1', teamId: null, name: 'High', resource: 'conversations', visibility: 'private', version: 2,
      conditions: { version: 1, root: { kind: 'group', match: 'all', conditions: [{ kind: 'predicate', field: 'priority', operator: 'eq', value: 'high' }] } } };
    const savedViewsApi = {
      list: vi.fn().mockResolvedValue({ ok: true, data: [saved] }),
      create: vi.fn().mockResolvedValue({ ok: true, data: saved }),
      update: vi.fn().mockResolvedValue({ ok: true, data: saved }),
      retire: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    };
    Object.defineProperty(context.live, 'savedViewsApi', { value: savedViewsApi });
    state.dialogForm = { savedViewName: 'High', savedViewVisibility: 'private' };
    expect(await LIVE_ACTIONS['live-inbox-saved-view-create']?.(context, '')).toBe(true);
    context.live.selectedSavedViewId = 'view-1';
    context.live.savedViews = { status: 'ready', value: [saved as never], loadedAt: 1 };
    state.dialogForm = { savedViewName: 'Updated', savedViewVisibility: 'workspace' };
    expect(await LIVE_ACTIONS['live-inbox-saved-view-update']?.(context, '')).toBe(true);
    expect(savedViewsApi.update).toHaveBeenCalledWith('tenant-1', 'view-1', 2, expect.objectContaining({ visibility: 'workspace' }));
    expect(await LIVE_ACTIONS['live-inbox-saved-view-retire']?.(context, 'view-1')).toBe(true);
    expect(savedViewsApi.retire).toHaveBeenCalledWith('tenant-1', 'view-1', 2);
  });

  it('updates and retires labels through dispatcher confirmations', async () => {
    const { state, context } = active();
    const label = { id: 'label-1', name: 'VIP', color: '#123456', state: 'active', version: 3 };
    context.live.workspaceLabels = { status: 'ready', value: [label as never], loadedAt: 1 };
    const metadataApi = {
      updateLabel: vi.fn().mockResolvedValue({ ok: true, data: { ...label, name: 'Priority' } }),
      retireLabel: vi.fn().mockResolvedValue({ ok: true, data: { ...label, state: 'retired' } }),
      labels: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      fields: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    };
    Object.defineProperty(context.live, 'metadataApi', { value: metadataApi });
    state.dialog = { kind: 'edit-label', arg: 'label-1' } as never;
    state.dialogForm = { labelName: 'Priority', labelColor: '#AABBCC' };
    expect(await LIVE_ACTIONS['live-workspace-label-update']?.(context, '')).toBe(true);
    expect(metadataApi.updateLabel).toHaveBeenCalledWith('tenant-1', 'label-1', { version: 3, name: 'Priority', color: '#AABBCC' });
    expect(await LIVE_ACTIONS['live-workspace-label-retire-confirm']?.(context, 'missing')).toBe(false);
    expect(await LIVE_ACTIONS['live-workspace-label-retire-confirm']?.(context, 'label-1')).toBe(true);
    expect(metadataApi.retireLabel).toHaveBeenCalledWith('tenant-1', 'label-1', 3);
    state.dialog = { kind: 'edit-label', arg: 'missing' } as never;
    expect(await LIVE_ACTIONS['live-workspace-label-update']?.(context, '')).toBe(false);
    state.dialog = { kind: 'edit-label', arg: 'label-1' } as never;
    state.dialogForm = { labelName: 'Bad color', labelColor: 'blue' };
    expect(await LIVE_ACTIONS['live-workspace-label-update']?.(context, '')).toBe(false);
  });

  it('builds only catalogue-backed custom filters and rejects incomplete forms', async () => {
    const { state, context } = active();
    inboxReads(context);
    expect(await LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).toBe(false);
    state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-1', inboxFilterOperator: 'neq', inboxFilterValue: 'true' };
    context.live.customFields = { status: 'ready', value: [{ id: 'field-1', target: 'conversation', type: 'boolean', state: 'active' } as never], loadedAt: 1 };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'custom_field', fieldId: 'field-1', operator: 'neq', value: true });

    state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'missing', inboxFilterOperator: 'eq', inboxFilterValue: 'x' };
    expect(await LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).toBe(false);
    state.dialogForm = { inboxFilterKey: 'status', inboxFilterOperator: 'eq', inboxFilterValue: '' };
    expect(await LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).toBe(false);
    state.dialogForm = { inboxFilterKey: 'status', inboxFilterOperator: 'invalid', inboxFilterValue: 'open' };
    expect(await LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).toBe(false);

    state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-1', inboxFilterOperator: 'neq', inboxFilterValue: 'false' };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'custom_field', fieldId: 'field-1', operator: 'neq', value: false });

    context.live.customFields = { status: 'ready', value: [{ id: 'field-text', target: 'conversation', type: 'text', state: 'active' } as never], loadedAt: 1 };
    state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-text', inboxFilterOperator: 'neq', inboxFilterValue: 'hello' };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'custom_field', fieldId: 'field-text', operator: 'eq', value: 'hello' });
    state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: 'field-text', inboxFilterOperator: 'is_set', inboxFilterValue: '' };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'custom_field', fieldId: 'field-text', operator: 'is_set' });

    state.dialogForm = { inboxFilterKey: 'label_id', inboxFilterOperator: 'in', inboxFilterValue: 'label-a, label-b' };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'label_id', operator: 'in', value: ['label-a', 'label-b'] });
    state.dialogForm = { inboxFilterKey: 'unread', inboxFilterOperator: 'eq', inboxFilterValue: 'unknown' };
    expect(await LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).toBe(false);

    for (const type of ['number', 'date', 'single_select', 'unknown'] as const) {
      const id = `field-${type}`;
      context.live.customFields = { status: 'ready', value: [{ id, target: 'conversation', type, state: 'active' } as never], loadedAt: 1 };
      state.dialogForm = { inboxFilterKey: 'custom_field', inboxFilterFieldId: id, inboxFilterOperator: 'is_set', inboxFilterValue: '' };
      await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
      expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'custom_field', fieldId: id, operator: 'is_set' });
    }
    state.dialogForm = { inboxFilterKey: 'waiting_since', inboxFilterOperator: 'is_set', inboxFilterValue: '' };
    await expect(LIVE_ACTIONS['live-inbox-filter-apply']?.(context, '')).resolves.toBeUndefined();
    expect(context.live.inboxQuery.filters.at(-1)).toEqual({ key: 'waiting_since', operator: 'is_set' });
  });

  it('fails closed for unavailable saved-view apply and malformed inline label create', async () => {
    const { state, context } = active();
    expect(await LIVE_ACTIONS['live-inbox-saved-view-apply']?.(context, 'view-1')).toBe(false);
    expect(await LIVE_ACTIONS['live-inline-label-create']?.(context, 'other|entity-1')).toBe(false);
    expect(await LIVE_ACTIONS['live-inline-label-create']?.(context, 'contact')).toBe(false);
    state.dialogForm = { labelColor: 'red', labelName: 'VIP' };
    expect(await LIVE_ACTIONS['live-inline-label-create']?.(context, 'conversation|conversation-1')).toBe(false);
    expect(state.formErrors['labelColor']).toContain('HEX');
  });

  it('creates and assigns an inline conversation label only after a valid color and server success', async () => {
    const { state, context } = active();
    state.live.openConversation = { status: 'ready', loadedAt: 1, value: { id: 'conversation-1', version: 4 } as never };
    state.dialog = { kind: 'create-label', arg: 'conversation-1' } as never;
    state.dialogForm = { labelName: 'VIP', labelColor: '#aabbcc' };
    const metadataApi = {
      createLabel: vi.fn().mockResolvedValue({ ok: true, data: { id: 'label-1' } }),
      conversation: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      labels: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      fields: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    };
    const read = vi.fn().mockResolvedValue({ ok: true, data: { id: 'conversation-1', version: 5 } });
    Object.defineProperty(context.live, 'metadataApi', { value: metadataApi });
    Object.defineProperty(context.live, 'conversationsApi', { value: { read } });
    expect(await LIVE_ACTIONS['live-inline-label-create']?.(context, 'conversation|conversation-1')).toBe(true);
    expect(metadataApi.createLabel).toHaveBeenCalledWith('tenant-1', 'VIP', '#AABBCC');
    expect(metadataApi.conversation).toHaveBeenCalledWith('tenant-1', 'conversation-1', { version: 4, addLabels: ['label-1'], removeLabels: [] });
    expect(state.dialog).toBeNull();
    expect(state.dialogForm).toEqual({});
  });

  it('keeps supervisor report navigation tied to the selected membership and exits the lens', async () => {
    const { state, context } = active();
    state.live.supervisorAgents = { status: 'ready', value: [{ membershipId: 'agent-1' } as never], loadedAt: 1 };
    expect(await LIVE_ACTIONS['live-supervisor-open-report']?.(context, 'unknown')).toBe(false);
    state.live.teams = { status: 'ready', value: [], loadedAt: 1 };
    state.live.connections = { status: 'ready', value: [], loadedAt: 1 };
    state.live.workspaceLabels = { status: 'ready', value: [], loadedAt: 1 };
    state.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
    const operationsReport = vi.fn().mockResolvedValue({ ok: true, data: { agents: [] } });
    Object.defineProperty(context.live, 'campaignsApi', { value: { operationsReport } });
    expect(await LIVE_ACTIONS['live-supervisor-open-report']?.(context, 'agent-1')).toBe(true);
    expect(state.route.params).toEqual({ view: 'operations', agent: 'agent-1' });
    expect(operationsReport).toHaveBeenCalledWith('tenant-1', state.analyticsFilters);

    inboxReads(context);
    state.live.supervisorAgentId = 'agent-1';
    state.live.supervisorWorkload = { status: 'ready', value: {} as never, loadedAt: 1 };
    state.route = { screen: 'inbox', conversationId: null, params: { lang: 'en', agent: 'agent-1' } };
    await expect(LIVE_ACTIONS['live-supervisor-exit']?.(context, '')).resolves.toBe(true);
    expect(state.live.supervisorAgentId).toBeNull();
    expect(state.live.supervisorWorkload).toEqual({ status: 'idle' });
    expect(state.route.params).toEqual({ lang: 'en' });
  });

  it('toggles visible label names, removes and clears filters, and validates sort options', async () => {
    const { state, context } = active();
    inboxReads(context);
    state.dialogForm = { inboxFilterValue: 'label-a' };
    await LIVE_ACTIONS['live-inbox-filter-value-toggle']?.(context, 'label-b');
    expect(state.dialogForm['inboxFilterValue']).toBe('label-a,label-b');
    await LIVE_ACTIONS['live-inbox-filter-value-toggle']?.(context, 'label-a');
    expect(state.dialogForm['inboxFilterValue']).toBe('label-b');

    context.live.inboxQuery = { ...context.live.inboxQuery, filters: [
      { key: 'status', operator: 'eq', value: 'open' }, { key: 'priority', operator: 'eq', value: 'high' },
    ] };
    context.live.selectedSavedViewId = 'saved-1';
    expect(await LIVE_ACTIONS['live-inbox-filter-remove']?.(context, 'nonsense')).toBe(false);
    await LIVE_ACTIONS['live-inbox-filter-remove']?.(context, '0');
    expect(context.live.inboxQuery.filters).toEqual([{ key: 'priority', operator: 'eq', value: 'high' }]);
    expect(context.live.selectedSavedViewId).toBeNull();
    expect(await LIVE_ACTIONS['live-inbox-sort']?.(context, 'unknown')).toBe(false);
    await LIVE_ACTIONS['live-inbox-sort']?.(context, 'created_desc');
    expect(context.live.inboxQuery.sort).toBe('created_desc');
    await LIVE_ACTIONS['live-inbox-filter-clear']?.(context, '');
    expect(context.live.inboxQuery.filters).toEqual([]);
  });

  it('starts label-filter selection from an empty form value', async () => {
    const { state, context } = active();
    state.dialogForm = {};
    await LIVE_ACTIONS['live-inbox-filter-value-toggle']?.(context, 'label-a');
    expect(state.dialogForm['inboxFilterValue']).toBe('label-a');
  });

  it('debounces Inbox search and avoids reloading an unchanged query', async () => {
    const { state, context } = active();
    inboxReads(context);
    vi.useFakeTimers();
    try {
      await LIVE_ACTIONS['live-inbox-search']?.(context, '  customer  ');
      expect(context.live.inboxSearchDraft).toBe('  customer  ');
      await LIVE_ACTIONS['live-inbox-search']?.(context, 'customer');
      await vi.advanceTimersByTimeAsync(250);
      expect(context.live.inboxQuery.search).toBe('customer');
      await LIVE_ACTIONS['live-inbox-search']?.(context, 'customer');
      await vi.advanceTimersByTimeAsync(250);
      expect(context.live.inboxQuery.search).toBe('customer');
      await LIVE_ACTIONS['live-inbox-search']?.(context, '');
      await vi.advanceTimersByTimeAsync(250);
      expect(context.live.inboxQuery.search).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(state.inboxQueue).toBe('mine');
  });
});

describe('WhatsApp template dispatch table', () => {
  it('connects every rendered picker action and rejects invalid selections', async () => {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
    const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => 1, newKey: () => 'test-key', endSession: vi.fn(), switchWorkspace: vi.fn() };
    state.live.openConversationId = 'conversation-1';
    state.live.openConversation = ready({ id: 'conversation-1', connectionId: 'connection-1', channel: 'whatsapp' } as never, 1);
    const template = {
      id: 'template-1', providerTemplateId: 'provider-1', name: 'welcome', language: 'en', category: 'utility', status: 'approved',
      components: [], parameters: [], sendSupported: true, unsupportedReason: null, lastSyncedAt: new Date().toISOString(),
    };
    const whatsappTemplates = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { items: [template], nextCursor: '50' } })
      .mockResolvedValue({ ok: true, data: { items: [template], nextCursor: null } });
    Object.assign(context.live, {
      conversationsApi: {
        whatsappTemplates,
        replyTemplate: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        timeline: vi.fn().mockResolvedValue({ ok: true, data: { messages: [], nextCursor: null } }),
      },
      channels: { syncWhatsAppTemplates: vi.fn().mockResolvedValue({ ok: true, data: {} }) },
    });
    expect(await LIVE_ACTIONS['live-whatsapp-template-open']?.(context, '')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-select']?.(context, 'missing')).toBe(false);
    expect(await LIVE_ACTIONS['live-whatsapp-template-select']?.(context, 'template-1')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-search']?.(context, '')).toBe(true);
    context.live.conversationTemplateCursor = '50';
    expect(await LIVE_ACTIONS['live-whatsapp-template-more']?.(context, '')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-refresh']?.(context, '')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-select']?.(context, 'template-1')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-send']?.(context, '')).toBe(true);
    expect(await LIVE_ACTIONS['live-whatsapp-template-select']?.(context, 'template-1')).toBe(false);
  });
});

describe('public credential actions', () => {
  function context() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.route = { screen: 'reset-password', conversationId: null, params: { token: 't'.repeat(43) } };
    const refresh = vi.fn();
    return {
      state,
      live: state.live,
      refresh,
      now: () => 1,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as LiveContext;
  }

  it('validates and submits an enumeration-safe recovery request', async () => {
    const ctx = context();
    const requestRecovery = vi.fn().mockResolvedValue({ ok: true, data: { status: 'accepted', message: 'ok' } });
    Object.defineProperty(ctx.live, 'api', { value: { requestRecovery } });
    ctx.state.dialogForm = { recoveryEmail: 'bad' };
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(requestRecovery).not.toHaveBeenCalled();
    ctx.state.dialogForm = { recoveryEmail: 'person@example.test' };
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(true);
    expect(requestRecovery).toHaveBeenCalledWith('person@example.test');
    expect(ctx.state.authFlowComplete).toBe('recovery-request');
    requestRecovery.mockResolvedValueOnce({ ok: false, error: { code: 'down', message: 'down', requestId: null, status: 503, details: [] } });
    ctx.live.busy = null;
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.live.error?.code).toBe('down');
    ctx.live.busy = 'something';
    await expect(LIVE_ACTIONS['live-request-recovery']?.(ctx, '')).resolves.toBe(false);
  });

  it('keeps typed recovery credentials on validation errors and clears them after a server attempt', async () => {
    const ctx = context();
    const completeRecovery = vi.fn().mockResolvedValue({ ok: false, error: { code: 'expired', message: 'expired', requestId: null, status: 400, details: [] } });
    Object.defineProperty(ctx.live, 'api', { value: { completeRecovery } });
    ctx.state.route = { ...ctx.state.route, params: {} };
    ctx.state.dialogForm = {};
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    ctx.state.dialogForm = { authPassword: 'short', authPasswordConfirm: 'different' };
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(completeRecovery).not.toHaveBeenCalled();
    ctx.state.dialogForm = { authPassword: 'long enough password', authPasswordConfirm: 'long enough password' };
    await expect(LIVE_ACTIONS['live-complete-recovery']?.(ctx, '')).resolves.toBe(false);
    expect(completeRecovery).toHaveBeenCalledWith('', 'long enough password');
    expect(ctx.state.dialogForm).toEqual({});
    expect(ctx.live.error?.code).toBe('expired');
  });

  it('accepts an invitation and fences duplicate submissions', async () => {
    const ctx = context();
    ctx.state.route = { screen: 'accept-invitation', conversationId: null, params: { token: 'i'.repeat(43) } };
    const acceptInvitation = vi.fn().mockResolvedValue({ ok: true, data: { tenant_id: 't', membership_id: 'm' } });
    Object.defineProperty(ctx.live, 'api', { value: { acceptInvitation } });
    ctx.state.dialogForm = { authPassword: 'long enough password', authPasswordConfirm: 'long enough password' };
    await expect(LIVE_ACTIONS['live-accept-invitation']?.(ctx, '')).resolves.toBe(true);
    expect(ctx.state.authFlowComplete).toBe('invitation');
    ctx.live.busy = 'already-busy';
    await expect(LIVE_ACTIONS['live-accept-invitation']?.(ctx, '')).resolves.toBe(false);
  });
});

describe('authenticated password change dispatch', () => {
  function context() {
    const state = createState(new Date('2026-09-17T00:00:00Z'));
    state.lang = 'en';
    state.dialog = { kind: 'change-password', arg: '' };
    state.live.session = {
      status: 'signed_in',
      email: 'owner@example.test',
      memberships: [],
      tenantId: 't',
    };
    return {
      state,
      live: state.live,
      refresh: vi.fn(),
      now: () => 1,
      newKey: () => 'k',
      endSession: vi.fn(),
      switchWorkspace: vi.fn(),
    } as unknown as LiveContext;
  }

  it('validates locally, preserves significant whitespace, and completes the real action', async () => {
    const ctx = context();
    const changePassword = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'current_password_invalid', message: 'wrong', requestId: null, status: 400, details: [] },
      })
      .mockResolvedValue({ ok: true, data: undefined });
    const sessions = vi.fn().mockResolvedValue({ ok: true, data: [] });
    Object.defineProperty(ctx.live, 'api', { value: { changePassword, sessions } });

    ctx.state.dialogForm = {};
    await expect(LIVE_ACTIONS['live-change-password']?.(ctx, '')).resolves.toBe(false);
    expect(changePassword).not.toHaveBeenCalled();

    ctx.state.dialogForm = {
      currentPassword: 'same password value',
      newPassword: 'same password value',
      confirmPassword: 'same password value',
    };
    await expect(LIVE_ACTIONS['live-change-password']?.(ctx, '')).resolves.toBe(false);
    expect(changePassword).not.toHaveBeenCalled();

    ctx.state.dialogForm = {
      currentPassword: 'current password value',
      newPassword: 'new password value',
      confirmPassword: 'different password value',
    };
    await expect(LIVE_ACTIONS['live-change-password']?.(ctx, '')).resolves.toBe(false);
    expect(changePassword).not.toHaveBeenCalled();

    ctx.state.dialogForm = {
      currentPassword: ' current password ',
      newPassword: ' new password value ',
      confirmPassword: ' new password value ',
    };
    await expect(LIVE_ACTIONS['live-change-password']?.(ctx, '')).resolves.toBe(false);
    expect(ctx.live.error?.code).toBe('current_password_invalid');
    expect(ctx.state.dialogForm).toEqual({
      newPassword: ' new password value ',
      confirmPassword: ' new password value ',
    });

    ctx.state.dialogForm = {
      currentPassword: ' current password ',
      newPassword: ' new password value ',
      confirmPassword: ' new password value ',
    };
    await expect(LIVE_ACTIONS['live-change-password']?.(ctx, '')).resolves.toBe(true);
    expect(changePassword).toHaveBeenLastCalledWith(
      ' current password ',
      ' new password value ',
      ' new password value ',
    );
    expect(sessions).toHaveBeenCalledOnce();
    expect(ctx.state.dialog).toBeNull();
  });
});
