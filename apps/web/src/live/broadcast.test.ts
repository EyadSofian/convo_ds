/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import type { WhatsAppTemplate } from '../api/automations.js';
import type { AudiencePreview, Campaign, CampaignsApi } from '../api/campaigns.js';
import type { ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import { broadcastStep, broadcastTemplate, goToBroadcastStep, scheduledInstant, stepProblems, submitBroadcast } from './broadcast.js';
import { LIVE_ACTIONS } from './dispatch.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const LABEL = '11111111-1111-4111-8111-111111111111';
const ERROR: ApiError = { code: 'channel_not_ready', message: 'Channel not ready', requestId: 'req-1', status: 409, details: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(): ApiResult<T> => ({ ok: false, error: ERROR });
const PREVIEW: AudiencePreview = { total: 2, eligible: 2, excluded: 0, reasons: { suppressed: 0, no_consent: 0, identity_inactive: 0 }, sample: [] };

const TEMPLATE: WhatsAppTemplate = {
  id: 'wa-1', connectionId: 'cn-1', providerTemplateId: 'p-1', templateName: 'class_open', language: 'en', category: 'MARKETING', status: 'approved',
  components: [{ type: 'BODY', text: 'Hi {{1}}, class on {{2}}' }], variables: [], lastSyncedAt: NOW.toISOString(),
};

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c-1', name: 'Sunday reminder', objective: null, connection_id: 'cn-1', state: 'draft', version: 1, revision_id: 'r', revision: 1,
    revision_hash: 'h', content: {}, variables: {}, audience_filter: {}, timezone: 'UTC', expires_at: null, budget_amount_minor: '0',
    budget_currency: 'USD', approved: false, audience: null, execution: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides,
  };
}

function setup(permissions: readonly string[] = ['campaign.draft', 'campaign.approve', 'campaign.launch'], lang: 'ar' | 'en' = 'en') {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = {
    status: 'signed_in', email: 'a@b.c', tenantId: 'tenant-1',
    memberships: [{ id: 'm', tenant: { id: 'tenant-1', name: 'School', slug: 'school' }, role: { id: 'r', key: 'x', name: 'X' }, permissions }],
  };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'cn-1', kind: 'whatsapp', status: 'healthy', display_name: 'WA', disconnected_at: null }] as never };
  state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [TEMPLATE] };
  state.live.audiences = { status: 'ready', loadedAt: 1, value: [] };
  state.dialog = { kind: 'campaign', arg: '' };
  const drafted = campaign();
  const ready = campaign({ state: 'ready', audience: { total: 2, eligible: 2, excluded: 0 } });
  const approved = campaign({ state: 'ready', approved: true });
  const running = campaign({ state: 'running', approved: true, execution: { id: 'e', state: 'running', scheduled_for: null } });
  const api = {
    create: vi.fn().mockResolvedValue(ok(drafted)),
    update: vi.fn().mockResolvedValue(ok(drafted)),
    validate: vi.fn().mockResolvedValue(ok(ready)),
    approve: vi.fn().mockResolvedValue(ok(approved)),
    launch: vi.fn().mockResolvedValue(ok(running)),
    list: vi.fn().mockResolvedValue(ok([running])),
    previewAudience: vi.fn().mockResolvedValue(ok(PREVIEW)),
  };
  const channels = { connections: vi.fn().mockResolvedValue(ok([])), testRecipients: vi.fn().mockResolvedValue(ok([])) } as unknown as ChannelsApi;
  Object.defineProperty(state.live, 'campaignsApi', { value: api as unknown as CampaignsApi });
  Object.defineProperty(state.live, 'channels', { value: channels });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => NOW.getTime(), newKey: () => 'key-1', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, api };
}

function complete(state: ReturnType<typeof setup>['state'], extra: Record<string, string> = {}): void {
  state.dialogForm = { campaignName: ' Sunday reminder ', campaignTemplate: 'wa-1', campaignParam_body_2_value: 'Sunday', campaignAudienceSource: 'labels', campaignLabelIds: LABEL, ...extra };
}

describe('moving between steps', () => {
  it('reads the step it is on, and refuses a step that does not exist', async () => {
    const { state, context } = setup();
    expect(broadcastStep(state)).toBe(0);
    state.dialogForm = { broadcastStep: 'x' };
    expect(broadcastStep(state)).toBe(0);
    expect(await goToBroadcastStep(context, '7')).toBe(false);
    expect(await goToBroadcastStep(context, 'x')).toBe(false);
  });

  it('checks each step before the next opens, and stops on the first one missing something', async () => {
    const { state, context } = setup();
    state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
    expect(await LIVE_ACTIONS['live-broadcast-step']?.(context, '2')).toBe(false);
    expect(state.formErrors).toEqual({ campaignName: 'Name the broadcast.', campaignConnection: 'Choose a WhatsApp number.' });
    expect(broadcastStep(state)).toBe(0);
    const { state: next, context: nextContext } = setup();
    next.dialogForm = { campaignName: 'A' };
    expect(await goToBroadcastStep(nextContext, '2')).toBe(false);
    expect(next.formErrors).toEqual({ campaignTemplate: 'Choose an approved template.' });
    expect(broadcastStep(next)).toBe(1);
    next.dialogForm = { ...next.dialogForm, campaignTemplate: 'wa-1' };
    expect(await goToBroadcastStep(nextContext, '2')).toBe(false);
    expect(next.formErrors).toEqual({ campaignTemplate: 'Give every variable a value.' });
    next.dialogForm = { ...next.dialogForm, campaignParam_body_2_value: 'Sunday', campaignAudienceSource: 'labels' };
    expect(await goToBroadcastStep(nextContext, '3')).toBe(false);
    expect(next.formErrors).toEqual({ campaignAudience: 'Choose at least one label.' });
    expect(broadcastStep(next)).toBe(2);
    // Back is always open.
    expect(await goToBroadcastStep(nextContext, '0')).toBe(true);
    expect(broadcastStep(next)).toBe(0);
  });

  it('refuses a template that cannot be broadcast, and counts the audience on reaching the review', async () => {
    const { state, context, api } = setup(undefined, 'ar');
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [{ ...TEMPLATE, components: [{ type: 'HEADER', format: 'IMAGE' }] }] };
    state.dialogForm = { campaignName: 'A', campaignTemplate: 'wa-1' };
    expect(stepProblems(context, 1)).toEqual({ campaignTemplate: 'هذا القالب لا يمكن بثه بعد. اختر غيره.' });
    expect(stepProblems(context, 3)).toEqual({});
    state.live.whatsappTemplates = { status: 'ready', loadedAt: 1, value: [TEMPLATE] };
    complete(state);
    expect(await goToBroadcastStep(context, '3')).toBe(true);
    expect(broadcastStep(state)).toBe(3);
    expect(api.previewAudience).toHaveBeenCalledWith('tenant-1', 'cn-1', { labelIds: [LABEL] });
  });

  it('reads the saved template and its bindings only for the template it saved', () => {
    const { state } = setup();
    const saved = campaign({ content: { template: { id: 'wa-1', parameters: { 'body:1': { source: 'phone' } } } } });
    expect(broadcastTemplate(state, saved)).toEqual({ template: 'wa-1', stored: { 'body:1': { source: 'phone' } } });
    state.dialogForm = { campaignTemplate: 'wa-2' };
    expect(broadcastTemplate(state, saved)).toEqual({ template: 'wa-2', stored: {} });
    expect(broadcastTemplate(state, campaign({ content: { template: 'legacy' } }))).toEqual({ template: 'wa-2', stored: {} });
    state.dialogForm = {};
    expect(broadcastTemplate(state, campaign({ content: { template: { name: 'old' } } }))).toEqual({ template: '', stored: {} });
    expect(broadcastTemplate(state, undefined)).toEqual({ template: '', stored: {} });
  });
});

describe('sending', () => {
  it('reads a future local time as an instant', () => {
    expect(scheduledInstant('', NOW.getTime())).toBeNull();
    expect(scheduledInstant('nope', NOW.getTime())).toBeNull();
    expect(scheduledInstant('2026-09-26T08:00:00.000Z', NOW.getTime())).toBeNull();
    expect(scheduledInstant('2026-09-27T17:00:00.000Z', NOW.getTime())).toBe('2026-09-27T17:00:00.000Z');
  });

  it('creates, freezes, approves and sends now in one confirmation', async () => {
    const { state, context, api } = setup();
    complete(state);
    expect(await LIVE_ACTIONS['live-broadcast-submit']?.(context, 'now')).toBe(true);
    expect(api.create).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Sunday reminder', connectionId: 'cn-1', audienceFilter: { labelIds: [LABEL] }, variables: {},
      content: { template: { id: 'wa-1', parameters: { 'body:1': { source: 'display_name' }, 'body:2': { source: 'static', value: 'Sunday' } } } },
    }), 'key-1');
    expect(api.validate).toHaveBeenCalledWith('tenant-1', 'c-1');
    expect(api.approve).toHaveBeenCalledWith('tenant-1', 'c-1');
    expect(api.launch).toHaveBeenCalledWith('tenant-1', 'c-1', 'key-1', null);
    expect(state.dialog).toBeNull();
    expect(state.dialogForm).toEqual({});
    expect(state.live.selectedCampaignId).toBe('c-1');
    expect(state.toasts.at(-1)?.text).toBe('“Sunday reminder” is sending');
  });

  it('schedules for the chosen time, refusing one in the past', async () => {
    const { state, context, api } = setup();
    complete(state);
    expect(await submitBroadcast(context, 'schedule')).toBe(false);
    complete(state, { campaignScheduleAt: '2026-09-25T17:00' });
    expect(await submitBroadcast(context, 'schedule')).toBe(false);
    expect(state.formErrors).toEqual({ campaignScheduleAt: 'Choose a time in the future.' });
    expect(broadcastStep(state)).toBe(3);
    expect(api.create).not.toHaveBeenCalled();
    api.launch.mockResolvedValueOnce(ok(campaign({ state: 'scheduled', approved: true, execution: { id: 'e', state: 'scheduled', scheduled_for: '2026-09-27T17:00:00.000Z' } })));
    complete(state, { campaignScheduleAt: '2026-09-27T17:00:00.000Z' });
    expect(await submitBroadcast(context, 'schedule')).toBe(true);
    expect(api.launch).toHaveBeenCalledWith('tenant-1', 'c-1', 'key-1', '2026-09-27T17:00:00.000Z');
    expect(state.toasts.at(-1)?.text).toBe('“Sunday reminder” is scheduled');
  });

  it('saves a draft without sending anything, and refuses an unknown mode or a second press', async () => {
    const { state, context, api } = setup(undefined, 'ar');
    complete(state);
    expect(await submitBroadcast(context, 'sideways')).toBe(false);
    state.live.busy = 'broadcast-submit';
    expect(await submitBroadcast(context, 'draft')).toBe(false);
    state.live.busy = null;
    expect(await submitBroadcast(context, 'draft')).toBe(true);
    expect(api.validate).not.toHaveBeenCalled();
    expect(state.toasts.at(-1)?.text).toBe('حُفظت «Sunday reminder» كمسودة');
  });

  it('checks every step first, and needs a workspace', async () => {
    const { state, context, api } = setup();
    state.dialogForm = { campaignName: 'A' };
    expect(await submitBroadcast(context, 'now')).toBe(false);
    expect(broadcastStep(state)).toBe(1);
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    expect(await submitBroadcast(context, 'now')).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('goes only as far as the operator’s permissions', async () => {
    const drafter = setup(['campaign.draft']);
    complete(drafter.state);
    expect(await submitBroadcast(drafter.context, 'now')).toBe(true);
    expect(drafter.api.validate).toHaveBeenCalled();
    expect(drafter.api.approve).not.toHaveBeenCalled();
    expect(drafter.api.launch).not.toHaveBeenCalled();
    expect(drafter.state.toasts.at(-1)?.text).toBe('“Sunday reminder” is ready and waiting for approval or launch');
    // An approver without the launch key approves and stops.
    const approver = setup(['campaign.draft', 'campaign.approve']);
    complete(approver.state);
    await submitBroadcast(approver.context, 'now');
    expect(approver.api.approve).toHaveBeenCalled();
    expect(approver.api.launch).not.toHaveBeenCalled();
  });

  it('saves an edited broadcast, skipping steps it has already passed', async () => {
    const { state, context, api } = setup();
    const saved = campaign({ id: 'c-9', state: 'ready', approved: true, version: 4, objective: 'Keep', content: { template: { id: 'wa-1', parameters: { 'body:1': { source: 'phone' }, 'body:2': { source: 'static', value: 'Mon' } } } } });
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [saved] };
    state.dialog = { kind: 'campaign-edit', arg: 'c-9' };
    state.dialogForm = { campaignAudienceSource: 'all' };
    api.update.mockResolvedValueOnce(ok({ ...saved, version: 5 }));
    expect(await submitBroadcast(context, 'now')).toBe(true);
    expect(api.update).toHaveBeenCalledWith('tenant-1', 'c-9', expect.objectContaining({
      name: 'Sunday reminder', objective: 'Keep', content: { template: { id: 'wa-1', parameters: { 'body:1': { source: 'phone' }, 'body:2': { source: 'static', value: 'Mon' } } } },
    }), 4, 'key-1');
    expect(api.validate).not.toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.launch).toHaveBeenCalled();
  });

  it('keeps what was saved when a later step is refused, so trying again edits it', async () => {
    const { state, context, api } = setup();
    complete(state);
    api.validate.mockResolvedValueOnce(fail());
    expect(await submitBroadcast(context, 'now')).toBe(false);
    expect(state.live.error).toEqual(ERROR);
    expect(state.dialog).toEqual({ kind: 'campaign-edit', arg: 'c-1' });
    expect(state.live.selectedCampaignId).toBe('c-1');
    expect(state.live.busy).toBeNull();
    expect(api.list).toHaveBeenCalled();
    // A refused save keeps the wizard as it was.
    const refused = setup();
    complete(refused.state);
    refused.api.create.mockResolvedValueOnce(fail());
    expect(await submitBroadcast(refused.context, 'draft')).toBe(false);
    expect(refused.state.dialog).toEqual({ kind: 'campaign', arg: '' });
    expect(refused.state.live.error).toEqual(ERROR);
    // Refusals at approval and launch stop there too.
    for (const step of ['approve', 'launch'] as const) {
      const late = setup();
      complete(late.state);
      late.api[step].mockResolvedValueOnce(fail());
      expect(await submitBroadcast(late.context, 'now')).toBe(false);
      expect(late.state.dialog).toEqual({ kind: 'campaign-edit', arg: 'c-1' });
    }
  });
});
