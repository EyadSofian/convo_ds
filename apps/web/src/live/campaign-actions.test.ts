import { describe, expect, it, vi } from 'vitest';
import type { Campaign, CampaignsApi, CreateCampaignInput } from '../api/campaigns.js';
import type { ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import {
  approveCampaign,
  controlCampaign,
  createCampaign,
  launchCampaign,
  loadCampaignRecipients,
  loadCampaignsScreen,
  validateCampaign,
} from './campaign-actions.js';
import { LIVE_ACTIONS } from './dispatch.js';

const NOW = new Date('2026-09-12T09:00:00.000Z');
const INPUT: CreateCampaignInput = {
  name: 'September intake', objective: null, connectionId: 'channel-1',
  content: { text: 'Hello' }, variables: {}, audienceFilter: {}, timezone: 'Africa/Cairo',
  budgetAmountMinor: 0, budgetCurrency: 'USD',
};
const CAMPAIGN: Campaign = {
  id: 'campaign-1', name: INPUT.name, objective: null, connection_id: INPUT.connectionId,
  state: 'draft', version: 1, revision_id: 'revision-1', revision: 1,
  revision_hash: 'a'.repeat(64), approved: false, audience: null, execution: null,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};
const ERROR: ApiError = { code: 'refused', message: 'Server refused', requestId: 'req-1', status: 409, details: [] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = <T>(): ApiResult<T> => ({ ok: false, error: ERROR });

function setup(options: { tenant?: string | null; mutation?: ApiResult<Campaign>; lang?: 'ar' | 'en' } = {}) {
  const state = createState(NOW);
  state.lang = options.lang ?? 'en';
  state.live.session = options.tenant === null
    ? { status: 'signed_in', email: 'owner@example.com', memberships: [], tenantId: null }
    : { status: 'signed_in', email: 'owner@example.com', memberships: [], tenantId: options.tenant ?? 'tenant-1' };
  const mutation = options.mutation ?? ok(CAMPAIGN);
  const campaigns = {
    list: vi.fn().mockResolvedValue(ok([CAMPAIGN])),
    create: vi.fn().mockResolvedValue(mutation),
    validate: vi.fn().mockResolvedValue(mutation),
    approve: vi.fn().mockResolvedValue(mutation),
    launch: vi.fn().mockResolvedValue(mutation),
    control: vi.fn().mockResolvedValue(mutation),
    recipients: vi.fn().mockResolvedValue(ok([])),
  } as unknown as CampaignsApi;
  const channels = {
    connections: vi.fn().mockResolvedValue(ok([])),
  } as unknown as ChannelsApi;
  Object.defineProperty(state.live, 'campaignsApi', { value: campaigns });
  Object.defineProperty(state.live, 'channels', { value: channels });
  const context: LiveContext = {
    state,
    live: state.live,
    refresh: vi.fn(),
    now: () => NOW.getTime(),
    newKey: () => 'key-1',
  };
  return { state, context, campaigns, channels };
}

describe('campaign actions', () => {
  it('does not request a tenant when there is no active membership', async () => {
    const { context, campaigns } = setup({ tenant: null });
    await loadCampaignsScreen(context);
    await loadCampaignRecipients(context, 'campaign-1');
    expect(await createCampaign(context, INPUT)).toBe(false);
    expect(campaigns.list).not.toHaveBeenCalled();
    expect(campaigns.recipients).not.toHaveBeenCalled();
  });

  it('loads campaigns and channel choices together, including a refused read', async () => {
    const readyCase = setup();
    await loadCampaignsScreen(readyCase.context);
    expect(readyCase.state.live.campaigns).toMatchObject({ status: 'ready', value: [CAMPAIGN] });
    expect(readyCase.state.live.connections).toMatchObject({ status: 'ready', value: [] });

    const refused = setup();
    vi.mocked(refused.campaigns.list).mockResolvedValueOnce(fail());
    await loadCampaignsScreen(refused.context);
    expect(refused.state.live.campaigns).toEqual({ status: 'error', error: ERROR });
  });

  it('records success only after the mutation and then reloads server state', async () => {
    const { context, state, campaigns } = setup();
    expect(await createCampaign(context, INPUT)).toBe(true);
    expect(campaigns.create).toHaveBeenCalledWith('tenant-1', INPUT, 'key-1');
    expect(state.toasts.at(-1)?.text).toContain('Draft');
    expect(state.live.busy).toBeNull();
    expect(state.live.revision).toBe(1);
    expect(campaigns.list).toHaveBeenCalledOnce();
  });

  it('keeps a refusal beside the campaign form and produces no success toast', async () => {
    const { context, state } = setup({ mutation: fail() });
    expect(await approveCampaign(context, 'campaign-1')).toBe(false);
    expect(state.live.error).toEqual(ERROR);
    expect(state.live.campaigns).toEqual({ status: 'error', error: ERROR });
    expect(state.toasts).toEqual([]);
  });

  it('describes every successful workflow action in both languages', async () => {
    const english = setup();
    await validateCampaign(english.context, 'campaign-1');
    expect(english.state.toasts.at(-1)?.text).toBe('Audience frozen with 0 eligible recipients');
    await launchCampaign(english.context, 'campaign-1');
    expect(english.state.toasts.at(-1)?.text).toBe('Campaign execution started');
    await controlCampaign(english.context, 'campaign-1', 'pause');
    await controlCampaign(english.context, 'campaign-1', 'resume');
    await controlCampaign(english.context, 'campaign-1', 'cancel');
    expect(english.state.toasts.map((entry) => entry.text)).toEqual([
      'New dispatches paused',
      'Campaign resumed',
      'Undispatched work cancelled',
    ]);

    const arabic = setup({ lang: 'ar', mutation: ok({ ...CAMPAIGN, audience: { total: 2, eligible: 1, excluded: 1 } }) });
    await validateCampaign(arabic.context, 'campaign-1');
    expect(arabic.state.toasts.at(-1)?.text).toContain('1');
  });

  it('loads the selected campaign ledger and preserves a read failure', async () => {
    const readyCase = setup();
    await loadCampaignRecipients(readyCase.context, 'campaign-1');
    expect(readyCase.state.live.selectedCampaignId).toBe('campaign-1');
    expect(readyCase.state.live.campaignRecipients).toMatchObject({ status: 'ready', value: [] });

    const refused = setup();
    vi.mocked(refused.campaigns.recipients).mockResolvedValueOnce(fail());
    await loadCampaignRecipients(refused.context, 'campaign-1');
    expect(refused.state.live.campaignRecipients).toEqual({ status: 'error', error: ERROR });
  });

  it('dispatches every campaign control and clears a completed create form', async () => {
    const empty = setup();
    expect(await LIVE_ACTIONS['live-campaign-create']?.(empty.context, '')).toBe(false);
    expect(await LIVE_ACTIONS['live-campaign-control']?.(empty.context, 'campaign-1:wrong')).toBe(false);

    const readyCase = setup();
    readyCase.state.dialog = { kind: 'campaign', arg: '' };
    readyCase.state.dialogForm = {
      campaignName: 'Autumn intake', campaignConnection: 'channel-1',
      campaignMessage: 'Welcome', campaignObjective: '', campaignSearch: 'Mona',
    };
    expect(await LIVE_ACTIONS['live-campaign-create']?.(readyCase.context, '')).toBe(true);
    expect(readyCase.state.dialog).toBeNull();
    expect(readyCase.state.dialogForm).toEqual({});
    expect(vi.mocked(readyCase.campaigns.create).mock.calls[0]?.[1]).toMatchObject({
      name: 'Autumn intake', objective: null, audienceFilter: { search: 'Mona' },
    });

    await LIVE_ACTIONS['live-campaign-validate']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-approve']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-launch']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-control']?.(readyCase.context, 'campaign-1:pause');
    await LIVE_ACTIONS['live-campaign-ledger']?.(readyCase.context, 'campaign-1');
    expect(readyCase.campaigns.validate).toHaveBeenCalled();
    expect(readyCase.campaigns.approve).toHaveBeenCalled();
    expect(readyCase.campaigns.launch).toHaveBeenCalled();
    expect(readyCase.campaigns.control).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'pause');
    expect(readyCase.campaigns.recipients).toHaveBeenCalled();
  });

  it('reloads the session before the campaign screen from the global action table', async () => {
    const readyCase = setup();
    const peopleApi = {
      session: vi.fn().mockResolvedValue(ok({ user: { id: 'user-1', email: 'owner@example.com' } })),
      memberships: vi.fn().mockResolvedValue(ok([{
        id: 'membership-1', tenant: { id: 'tenant-1', name: 'Digital School', slug: 'digital-school' },
        role: { id: 'role-1', key: 'owner', name: 'Owner' }, permissions: [],
      }])),
    };
    Object.defineProperty(readyCase.state.live, 'api', { value: peopleApi });
    await LIVE_ACTIONS['live-campaigns-reload']?.(readyCase.context, '');
    expect(peopleApi.session).toHaveBeenCalledOnce();
    expect(readyCase.campaigns.list).toHaveBeenCalledWith('tenant-1');
  });
});
