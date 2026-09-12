import { describe, expect, it, vi } from 'vitest';
import type { Campaign, CampaignReport, CampaignRetry, CampaignsApi, CampaignTestSend, CreateCampaignInput } from '../api/campaigns.js';
import type { ChannelConnection, ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import { createState } from '../state.js';
import type { LiveContext } from './actions.js';
import {
  approveCampaign,
  cloneCampaign,
  controlCampaign,
  createCampaign,
  launchCampaign,
  loadCampaignRecipients,
  loadCampaignReport,
  loadCampaignsScreen,
  retryCampaignFailures,
  testSendCampaign,
  updateCampaign,
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
  content: INPUT.content, variables: INPUT.variables, audience_filter: INPUT.audienceFilter,
  timezone: INPUT.timezone, expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};
const ERROR: ApiError = { code: 'refused', message: 'Server refused', requestId: 'req-1', status: 409, details: [] };
const TEST_SEND: CampaignTestSend = {
  id: 'test-send-1', campaign_id: 'campaign-1', revision_id: 'revision-1', test_recipient_id: 'recipient-1',
  recipient_label: 'Owner phone', peer_identity: '201000000000', message_id: 'message-1',
  state: 'queued', state_reason: null, created_at: NOW.toISOString(),
};
const REPORT = { generated_at: NOW.toISOString(), fresh_through: NOW.toISOString() } as CampaignReport;
const RETRY: CampaignRetry = {
  id: 'retry-1', campaign_id: 'campaign-1', execution_id: 'execution-1', recipient_count: 2,
  state: 'running', requested_at: NOW.toISOString(),
};
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
    update: vi.fn().mockResolvedValue(mutation),
    validate: vi.fn().mockResolvedValue(mutation),
    approve: vi.fn().mockResolvedValue(mutation),
    launch: vi.fn().mockResolvedValue(mutation),
    control: vi.fn().mockResolvedValue(mutation),
    retryFailures: vi.fn().mockResolvedValue(ok(RETRY)),
    clone: vi.fn().mockResolvedValue(mutation),
    testSend: vi.fn().mockResolvedValue(ok(TEST_SEND)),
    recipients: vi.fn().mockResolvedValue(ok([])),
    report: vi.fn().mockResolvedValue(ok(REPORT)),
  } as unknown as CampaignsApi;
  const channels = {
    connections: vi.fn().mockResolvedValue(ok([])),
    testRecipients: vi.fn().mockResolvedValue(ok([])),
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
    await loadCampaignReport(context);
    expect(await createCampaign(context, INPUT)).toBe(false);
    expect(await testSendCampaign(context, 'campaign-1', 'recipient-1', 1)).toBe(false);
    expect(await retryCampaignFailures(context, 'campaign-1')).toBe(false);
    expect(campaigns.list).not.toHaveBeenCalled();
    expect(campaigns.recipients).not.toHaveBeenCalled();
    expect(campaigns.report).not.toHaveBeenCalled();
  });

  it('loads the campaign report and preserves a server refusal', async () => {
    const ready = setup();
    await loadCampaignReport(ready.context);
    expect(ready.state.live.campaignReport).toMatchObject({ status: 'ready', value: REPORT });
    expect(ready.campaigns.report).toHaveBeenCalledWith('tenant-1');

    vi.mocked(ready.campaigns.report).mockResolvedValueOnce(fail());
    await LIVE_ACTIONS['live-report-reload']?.(ready.context, '');
    expect(ready.state.live.campaignReport).toEqual({ status: 'error', error: ERROR });
  });

  it('queues a test only after the server commits and keeps a refusal in the dialog', async () => {
    const ready = setup();
    expect(await testSendCampaign(ready.context, 'campaign-1', 'recipient-1', 1)).toBe(true);
    expect(ready.campaigns.testSend).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'recipient-1', 1, 'key-1');
    expect(ready.state.toasts.at(-1)?.text).toContain('Owner phone');

    vi.mocked(ready.campaigns.testSend).mockResolvedValueOnce(fail());
    const toastCount = ready.state.toasts.length;
    expect(await testSendCampaign(ready.context, 'campaign-1', 'recipient-1', 1)).toBe(false);
    expect(ready.state.toasts).toHaveLength(toastCount);
    expect(ready.state.live.error).toEqual(ERROR);
  });

  it('reports the exact failed-only retry count after the server commits', async () => {
    const ready = setup();
    expect(await retryCampaignFailures(ready.context, 'campaign-1')).toBe(true);
    expect(ready.campaigns.retryFailures).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'key-1');
    expect(ready.state.toasts.at(-1)?.text).toContain('2 failed');

    vi.mocked(ready.campaigns.retryFailures).mockResolvedValueOnce(fail());
    const count = ready.state.toasts.length;
    expect(await LIVE_ACTIONS['live-campaign-retry']?.(ready.context, 'campaign-1')).toBe(false);
    expect(ready.state.toasts).toHaveLength(count);
    expect(ready.state.live.error).toEqual(ERROR);
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

    const connectionRefused = setup();
    vi.mocked(connectionRefused.channels.connections).mockResolvedValueOnce(fail());
    await loadCampaignsScreen(connectionRefused.context);
    expect(connectionRefused.state.live.testRecipients).toEqual({ status: 'error', error: ERROR });

    const recipientRefused = setup();
    vi.mocked(recipientRefused.channels.connections).mockResolvedValueOnce(ok([{ id: 'channel-1' }] as ChannelConnection[]));
    vi.mocked(recipientRefused.channels.testRecipients).mockResolvedValueOnce(fail());
    await loadCampaignsScreen(recipientRefused.context);
    expect(recipientRefused.state.live.testRecipients).toEqual({ status: 'error', error: ERROR });

    const recipientReady = setup();
    vi.mocked(recipientReady.channels.connections).mockResolvedValueOnce(ok([{ id: 'channel-1' }] as ChannelConnection[]));
    vi.mocked(recipientReady.channels.testRecipients).mockResolvedValueOnce(ok([{
      id: 'recipient-1', connection_id: 'channel-1', identity_id: 'identity-1', peer_identity: '201000000000',
      display_name: 'Owner', label: 'Owner phone', authorized_at: NOW.toISOString(),
    }]));
    await loadCampaignsScreen(recipientReady.context);
    expect(recipientReady.state.live.testRecipients).toMatchObject({ status: 'ready', value: [{ id: 'recipient-1' }] });
  });

  it('records success only after the mutation and then reloads server state', async () => {
    const { context, state, campaigns } = setup();
    expect(await createCampaign(context, INPUT)).toBe(true);
    expect(campaigns.create).toHaveBeenCalledWith('tenant-1', INPUT, 'key-1');
    expect(state.toasts.at(-1)?.text).toContain('Draft');
    expect(state.live.busy).toBeNull();
    expect(state.live.revision).toBe(1);
    expect(campaigns.list).toHaveBeenCalledOnce();

    expect(await updateCampaign(context, 'campaign-1', INPUT, 1)).toBe(true);
    expect(campaigns.update).toHaveBeenCalledWith('tenant-1', 'campaign-1', INPUT, 1, 'key-1');
    expect(state.toasts.at(-1)?.text).toBe('Revision 1 saved');
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

    await cloneCampaign(english.context, 'campaign-1', 'September intake');
    expect(english.campaigns.clone).toHaveBeenCalledWith(
      'tenant-1', 'campaign-1', 'September intake — copy', 'key-1',
    );

    await cloneCampaign(arabic.context, 'campaign-1', 'ح'.repeat(160));
    expect(arabic.campaigns.clone).toHaveBeenLastCalledWith(
      'tenant-1', 'campaign-1', `نسخة من ${'ح'.repeat(152)}`, 'key-1',
    );
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
    expect(await LIVE_ACTIONS['live-campaign-clone']?.(empty.context, ':')).toBe(false);
    expect(await LIVE_ACTIONS['live-campaign-update']?.(empty.context, 'missing')).toBe(false);
    expect(await LIVE_ACTIONS['live-campaign-test-send']?.(empty.context, 'missing')).toBe(false);

    const readyCase = setup();
    readyCase.state.dialog = { kind: 'campaign', arg: '' };
    readyCase.state.dialogForm = {
      campaignName: 'Autumn intake', campaignConnection: 'channel-1',
      campaignMessage: 'Welcome', campaignObjective: '', campaignSearch: 'Mona',
    };
    expect(await LIVE_ACTIONS['live-campaign-create']?.(readyCase.context, '')).toBe(true);
    expect(readyCase.state.dialog).toBeNull();

    readyCase.state.dialog = { kind: 'campaign-test-send', arg: 'campaign-1' };
    expect(await LIVE_ACTIONS['live-campaign-test-send']?.(readyCase.context, 'campaign-1')).toBe(false);
    readyCase.state.live.testRecipients = { status: 'ready', loadedAt: 1, value: [{
      id: 'recipient-1', connection_id: 'channel-1', identity_id: 'identity-1', peer_identity: '201000000000',
      display_name: 'Owner', label: 'Owner phone', authorized_at: NOW.toISOString(),
    }] };
    expect(await LIVE_ACTIONS['live-campaign-test-send']?.(readyCase.context, 'campaign-1')).toBe(true);
    expect(readyCase.campaigns.testSend).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'recipient-1', 1, 'key-1');
    expect(readyCase.state.dialog).toBeNull();
    expect(readyCase.state.dialogForm).toEqual({});
    expect(vi.mocked(readyCase.campaigns.create).mock.calls[0]?.[1]).toMatchObject({
      name: 'Autumn intake', objective: null, audienceFilter: { search: 'Mona' },
    });

    readyCase.state.dialog = { kind: 'campaign-edit', arg: 'campaign-1' };
    readyCase.state.dialogForm = {
      campaignName: 'Edited intake', campaignConnection: 'channel-1', campaignMessage: 'Edited welcome',
      campaignObjective: 'Retention', campaignSearch: 'Student',
    };
    expect(await LIVE_ACTIONS['live-campaign-update']?.(readyCase.context, 'campaign-1')).toBe(true);
    expect(readyCase.campaigns.update).toHaveBeenCalledWith('tenant-1', 'campaign-1', expect.objectContaining({
      name: 'Edited intake', content: { text: 'Edited welcome' }, audienceFilter: { search: 'Student' },
    }), 1, 'key-1');
    expect(readyCase.state.dialog).toBeNull();

    readyCase.state.dialog = { kind: 'campaign-edit', arg: 'campaign-1' };
    readyCase.state.dialogForm = {
      campaignName: 'No objective', campaignConnection: 'channel-1', campaignMessage: 'Welcome',
      campaignObjective: '', campaignSearch: '',
    };
    expect(await LIVE_ACTIONS['live-campaign-update']?.(readyCase.context, 'campaign-1')).toBe(true);
    expect(vi.mocked(readyCase.campaigns.update).mock.calls.at(-1)?.[2]).toMatchObject({ objective: null });

    await LIVE_ACTIONS['live-campaign-validate']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-approve']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-launch']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-control']?.(readyCase.context, 'campaign-1:pause');
    await LIVE_ACTIONS['live-campaign-retry']?.(readyCase.context, 'campaign-1');
    await LIVE_ACTIONS['live-campaign-clone']?.(readyCase.context, 'campaign-1:September intake');
    await LIVE_ACTIONS['live-campaign-ledger']?.(readyCase.context, 'campaign-1');
    expect(readyCase.campaigns.validate).toHaveBeenCalled();
    expect(readyCase.campaigns.approve).toHaveBeenCalled();
    expect(readyCase.campaigns.launch).toHaveBeenCalled();
    expect(readyCase.campaigns.control).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'pause');
    expect(readyCase.campaigns.retryFailures).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'key-1');
    expect(readyCase.campaigns.clone).toHaveBeenCalled();
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
