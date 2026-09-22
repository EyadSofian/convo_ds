import { describe, expect, it, vi } from 'vitest';
import type { AssignmentReportRow, Campaign, CampaignReport, CampaignReportExport, CampaignRetry, CampaignsApi, CampaignTestSend, CreateCampaignInput, OperationalReport } from '../api/campaigns.js';
import type { ChannelConnection, ChannelsApi } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import type { MetadataApi } from '../api/metadata.js';
import { createState, NO_ANALYTICS_FILTERS } from '../state.js';
import type { LiveContext } from './actions.js';
import {
  approveCampaign,
  cloneCampaign,
  controlCampaign,
  createCampaign,
  createCampaignReportExport,
  launchCampaign,
  loadCampaignRecipients,
  loadAssignmentReport,
  loadCampaignReport,
  loadOperationalReport,
  loadResponseReport,
  loadResolutionReport,
  loadTeamReport,
  loadCampaignsScreen,
  refreshCampaignReportExport,
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
const REPORT = {
  generated_at: NOW.toISOString(), fresh_through: NOW.toISOString(),
  campaigns: [{ id: 'campaign-1', name: 'September intake' }, { id: 'campaign-2', name: 'Reminder' }],
} as unknown as CampaignReport;
const RETRY: CampaignRetry = {
  id: 'retry-1', campaign_id: 'campaign-1', execution_id: 'execution-1', recipient_count: 2,
  state: 'running', requested_at: NOW.toISOString(),
};
const EXPORT: CampaignReportExport = {
  id: 'export-1', campaign_id: null, format: 'csv', state: 'queued', row_count: null,
  error_code: null, requested_at: NOW.toISOString(), completed_at: null, expires_at: null,
  download_url: null,
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
    operationsReport: vi.fn().mockResolvedValue(ok({ agents: [], agentOptions: [] })),
    assignmentsReport: vi.fn().mockResolvedValue(ok({ data: [], nextCursor: null, hasMore: false })),
    responseReport: vi.fn().mockResolvedValue(ok({ measured: 0, averageSeconds: null, medianSeconds: null, buckets: [], byAgent: [], byChannel: [] })),
    resolutionReport: vi.fn().mockResolvedValue(ok({ resolvedEpisodes: 0, averageSeconds: null, medianSeconds: null, reopenedEpisodes: 0, byAgent: [], byChannel: [] })),
    teamReport: vi.fn().mockResolvedValue(ok([])),
    createReportExport: vi.fn().mockResolvedValue(ok(EXPORT)),
    reportExport: vi.fn().mockResolvedValue(ok({ ...EXPORT, state: 'completed' })),
  } as unknown as CampaignsApi;
  const channels = {
    connections: vi.fn().mockResolvedValue(ok([])),
    testRecipients: vi.fn().mockResolvedValue(ok([])),
  } as unknown as ChannelsApi;
  const api = { teams: vi.fn().mockResolvedValue(ok([])) };
  const metadata = { labels: vi.fn().mockResolvedValue(ok([])) } as unknown as MetadataApi;
  Object.defineProperty(state.live, 'campaignsApi', { value: campaigns });
  Object.defineProperty(state.live, 'channels', { value: channels });
  Object.defineProperty(state.live, 'api', { value: api });
  Object.defineProperty(state.live, 'metadataApi', { value: metadata });
  const context: LiveContext = {
    state,
    live: state.live,
    refresh: vi.fn(),
    now: () => NOW.getTime(),
    newKey: () => 'key-1',
    endSession: vi.fn(),
    switchWorkspace: vi.fn(),
  };
  return { state, context, campaigns, channels, api, metadata };
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
    expect(await createCampaignReportExport(context)).toBe(false);
    await refreshCampaignReportExport(context);
    expect(campaigns.list).not.toHaveBeenCalled();
    expect(campaigns.recipients).not.toHaveBeenCalled();
    expect(campaigns.report).not.toHaveBeenCalled();
  });

  it('shows export progress only after the server commits and refreshes the same owned job', async () => {
    const ready = setup();
    expect(await createCampaignReportExport(ready.context)).toBe(true);
    expect(ready.campaigns.createReportExport).toHaveBeenCalledWith('tenant-1', null, 'key-1');
    // The file follows the campaign filter, the one scope the export takes.
    ready.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, campaignId: 'campaign-1' };
    await createCampaignReportExport(ready.context);
    expect(ready.campaigns.createReportExport).toHaveBeenLastCalledWith('tenant-1', 'campaign-1', 'key-1');
    expect(ready.state.live.campaignReportExport).toMatchObject({ status: 'ready', value: { id: 'export-1', state: 'queued' } });
    expect(ready.state.toasts.at(-1)?.text).toContain('CSV export queued');
    await LIVE_ACTIONS['live-report-export-refresh']?.(ready.context, '');
    expect(ready.campaigns.reportExport).toHaveBeenCalledWith('tenant-1', 'export-1');
    expect(ready.state.live.campaignReportExport).toMatchObject({ status: 'ready', value: { state: 'completed' } });

    const refused = setup();
    vi.mocked(refused.campaigns.createReportExport).mockResolvedValueOnce(fail());
    expect(await LIVE_ACTIONS['live-report-export']?.(refused.context, '')).toBe(false);
    expect(refused.state.live.campaignReportExport).toEqual({ status: 'error', error: ERROR });
    refused.state.live.campaignReportExport = { status: 'loading' };
    await refreshCampaignReportExport(refused.context);
    expect(refused.campaigns.reportExport).not.toHaveBeenCalled();
  });

  it('loads the campaign report and preserves a server refusal', async () => {
    const ready = setup();
    await loadCampaignReport(ready.context);
    expect(ready.state.live.campaignReport).toMatchObject({ status: 'ready', value: REPORT });
    expect(ready.campaigns.report).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS);
    expect(ready.state.live.reportCampaigns).toEqual([{ id: 'campaign-1', name: 'September intake' }, { id: 'campaign-2', name: 'Reminder' }]);

    // Narrowed to one campaign, the list of campaigns that could be chosen stays.
    vi.mocked(ready.campaigns.report).mockResolvedValueOnce(ok({ ...REPORT, campaigns: [{ id: 'campaign-2', name: 'Reminder' }] } as unknown as CampaignReport));
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'campaignId:campaign-2')).toBe(true);
    expect(ready.state.analyticsFilters.campaignId).toBe('campaign-2');
    expect(ready.state.live.reportCampaigns).toHaveLength(2);
    // Choosing what is already chosen, or a filter that does not exist, does nothing.
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'campaignId:campaign-2')).toBe(false);
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'region:emea')).toBe(false);
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'from:2026-09-01')).toBe(true);
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'to:2026-09-09')).toBe(true);
    expect(await LIVE_ACTIONS['live-report-filter']?.(ready.context, 'channel:whatsapp')).toBe(true);
    expect(vi.mocked(ready.campaigns.report).mock.calls.at(-1)?.[1]).toEqual({ ...NO_ANALYTICS_FILTERS, from: '2026-09-01', to: '2026-09-09', channel: 'whatsapp', campaignId: 'campaign-2' });
    await LIVE_ACTIONS['live-report-filter-clear']?.(ready.context, '');
    expect(ready.state.analyticsFilters).toEqual(NO_ANALYTICS_FILTERS);

    // A deep link straight to one campaign still offers that campaign.
    const linked = setup();
    linked.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, campaignId: 'campaign-2' };
    vi.mocked(linked.campaigns.report).mockResolvedValueOnce(ok({ ...REPORT, campaigns: [{ id: 'campaign-2', name: 'Reminder' }] } as unknown as CampaignReport));
    await loadCampaignReport(linked.context);
    expect(linked.state.live.reportCampaigns).toEqual([{ id: 'campaign-2', name: 'Reminder' }]);

    vi.mocked(ready.campaigns.report).mockResolvedValueOnce(fail());
    await LIVE_ACTIONS['live-report-reload']?.(ready.context, '');
    expect(ready.state.live.campaignReport).toEqual({ status: 'error', error: ERROR });
  });

  it('loads operational report filters lazily, preserves scoped options, and discards stale responses', async () => {
    const app = setup();
    await loadOperationalReport(app.context);
    expect(app.api.teams).toHaveBeenCalledWith('tenant-1');
    expect(app.channels.connections).toHaveBeenCalledWith('tenant-1');
    expect(app.metadata.labels).toHaveBeenCalledWith('tenant-1', true);
    expect(app.campaigns.list).toHaveBeenCalledWith('tenant-1');
    expect(app.state.live.operationalReport).toMatchObject({ status: 'ready' });
    expect(app.state.live.operationalAgentOptions).toEqual({ tenantId: 'tenant-1', agents: [] });

    app.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, agentId: 'agent-1' };
    app.state.live.teams = { status: 'ready', value: [], loadedAt: NOW.getTime() };
    app.state.live.connections = { status: 'ready', value: [], loadedAt: NOW.getTime() };
    app.state.live.workspaceLabels = { status: 'ready', value: [], loadedAt: NOW.getTime() };
    app.state.live.campaigns = { status: 'ready', value: [], loadedAt: NOW.getTime() };
    app.state.live.operationalAgentOptions = { tenantId: 'original', agents: [] };
    await loadOperationalReport(app.context);
    expect(app.api.teams).toHaveBeenCalledTimes(1);
    expect(app.state.live.operationalAgentOptions).toEqual({ tenantId: 'original', agents: [] });

    const stale = setup();
    let resolveOld: ((result: ApiResult<OperationalReport>) => void) | undefined;
    vi.mocked(stale.campaigns.operationsReport).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = loadOperationalReport(stale.context);
    vi.mocked(stale.campaigns.operationsReport).mockResolvedValueOnce(ok({ agents: [], agentOptions: [] } as never));
    await loadOperationalReport(stale.context);
    resolveOld?.(ok({ agents: [], agentOptions: [] } as never));
    await oldRequest;
    expect(stale.state.live.operationalReport).toMatchObject({ status: 'ready' });

    const absent = setup({ tenant: null });
    await loadOperationalReport(absent.context);
    expect(absent.campaigns.operationsReport).not.toHaveBeenCalled();
  });

  it('fails closed for report reads without a tenant and loads the assignment directory on demand', async () => {
    const absent = setup({ tenant: null });
    await loadAssignmentReport(absent.context);
    await loadResponseReport(absent.context);
    await loadResolutionReport(absent.context);
    await loadTeamReport(absent.context);
    expect(absent.campaigns.operationsReport).not.toHaveBeenCalled();
    expect(absent.campaigns.assignmentsReport).not.toHaveBeenCalled();
    expect(absent.campaigns.responseReport).not.toHaveBeenCalled();
    expect(absent.campaigns.resolutionReport).not.toHaveBeenCalled();
    expect(absent.campaigns.teamReport).not.toHaveBeenCalled();

    const app = setup();
    await loadAssignmentReport(app.context);
    expect(app.campaigns.operationsReport).toHaveBeenCalledOnce();
    expect(app.campaigns.assignmentsReport).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS, null, 50);
    expect(app.state.live.assignmentReport).toMatchObject({ status: 'ready', value: [] });
  });

  it('discards stale assignment, resolution, and team report responses', async () => {
    const assignment = setup();
    let finishOperational: ((result: ApiResult<OperationalReport>) => void) | undefined;
    vi.mocked(assignment.campaigns.operationsReport).mockReturnValueOnce(new Promise((resolve) => { finishOperational = resolve; }));
    const pendingAssignment = loadAssignmentReport(assignment.context);
    assignment.state.live.assignmentRequestGeneration += 1;
    finishOperational?.(ok({ agents: [], agentOptions: [] } as unknown as OperationalReport));
    await pendingAssignment;
    expect(assignment.campaigns.assignmentsReport).not.toHaveBeenCalled();

    const resolution = setup();
    resolution.state.live.operationalReport = { status: 'ready', value: {} as never, loadedAt: 1 };
    let finishResolution: ((result: ApiResult<never>) => void) | undefined;
    vi.mocked(resolution.campaigns.resolutionReport).mockReturnValueOnce(new Promise((resolve) => { finishResolution = resolve; }));
    const pendingResolution = loadResolutionReport(resolution.context);
    resolution.state.live.analyticsRequestGeneration += 1;
    finishResolution?.(ok({} as never));
    await pendingResolution;
    expect(resolution.state.live.resolutionReport).toMatchObject({ status: 'loading' });

    const team = setup();
    team.state.live.operationalReport = { status: 'ready', value: {} as never, loadedAt: 1 };
    let finishTeam: ((result: ApiResult<never>) => void) | undefined;
    vi.mocked(team.campaigns.teamReport).mockReturnValueOnce(new Promise((resolve) => { finishTeam = resolve; }));
    const pendingTeam = loadTeamReport(team.context);
    team.state.live.analyticsRequestGeneration += 1;
    finishTeam?.(ok([] as never));
    await pendingTeam;
    expect(team.state.live.teamReport).toMatchObject({ status: 'loading' });
  });

  it('loads assignment pages independently and appends only the requested cursor page', async () => {
    const ready = setup();
    ready.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    vi.mocked(ready.campaigns.assignmentsReport).mockResolvedValueOnce(ok({ data: [{
      id: 'assignment-1', timestamp: NOW.toISOString(), conversationId: 'conversation-1', customer: 'Mona', action: 'claim',
      previousAssignee: null, assignedTo: { membershipId: 'member-1', displayName: 'Ahmed' }, actor: null,
    }], nextCursor: 'cursor-2', hasMore: true }));
    await loadAssignmentReport(ready.context);
    expect(ready.campaigns.assignmentsReport).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS, null, 50);
    expect(ready.state.live.assignmentReport).toMatchObject({ status: 'ready', value: [{ id: 'assignment-1' }] });
    expect(ready.state.live.assignmentNextCursor).toBe('cursor-2');

    vi.mocked(ready.campaigns.assignmentsReport).mockResolvedValueOnce(ok({ data: [{
      id: 'assignment-2', timestamp: NOW.toISOString(), conversationId: 'conversation-2', customer: null, action: 'assign',
      previousAssignee: null, assignedTo: { membershipId: 'member-2', displayName: 'Sara' }, actor: null,
    }], nextCursor: null, hasMore: false }));
    await loadAssignmentReport(ready.context, true);
    expect(ready.campaigns.assignmentsReport).toHaveBeenLastCalledWith('tenant-1', NO_ANALYTICS_FILTERS, 'cursor-2', 50);
    expect(ready.state.live.assignmentReport).toMatchObject({ status: 'ready', value: [{ id: 'assignment-1' }, { id: 'assignment-2' }] });
    expect(ready.state.live.assignmentNextCursor).toBeNull();
  });

  it('preserves assignment report refusals and skips append without a cursor', async () => {
    const app = setup();
    app.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    vi.mocked(app.campaigns.assignmentsReport).mockResolvedValueOnce(fail());
    await loadAssignmentReport(app.context);
    expect(app.state.live.assignmentReport).toEqual({ status: 'error', error: ERROR });
    await loadAssignmentReport(app.context, true);
    expect(app.campaigns.assignmentsReport).toHaveBeenCalledTimes(1);
  });

  it('loads the selected assignment tab and preserves its report URL state', async () => {
    const ready = setup();
    ready.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    ready.state.route = { ...ready.state.route, params: { lang: 'en', agent: 'membership-1' } };
    await expect(LIVE_ACTIONS['analytics-view']?.(ready.context, 'assignments')).resolves.toBe(true);
    expect(ready.state.analyticsView).toBe('assignments');
    expect(ready.state.route.params).toEqual({ lang: 'en', agent: 'membership-1', view: 'assignments' });
    expect(ready.campaigns.assignmentsReport).toHaveBeenCalledOnce();
  });

  it('loads response and resolution reports through distinct endpoints and retains the selected view', async () => {
    const ready = setup();
    ready.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    await LIVE_ACTIONS['analytics-view']?.(ready.context, 'responses');
    expect(ready.campaigns.responseReport).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS);
    expect(ready.state.live.responseReport).toMatchObject({ status: 'ready', value: { measured: 0 } });
    await LIVE_ACTIONS['analytics-view']?.(ready.context, 'resolutions');
    expect(ready.campaigns.resolutionReport).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS);
    expect(ready.state.live.resolutionReport).toMatchObject({ status: 'ready', value: { resolvedEpisodes: 0 } });
  });

  it('loads a dedicated team report after making the shared report filter catalogue available', async () => {
    const ready = setup();
    await LIVE_ACTIONS['analytics-view']?.(ready.context, 'teams');
    expect(ready.campaigns.operationsReport).toHaveBeenCalledOnce();
    expect(ready.campaigns.teamReport).toHaveBeenCalledWith('tenant-1', NO_ANALYTICS_FILTERS);
    expect(ready.state.live.teamReport).toMatchObject({ status: 'ready', value: [] });
  });

  it('ignores an older response-report result after switching to a newer report', async () => {
    const ready = setup();
    ready.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    let resolveOld: ((result: ApiResult<{ measured: number; averageSeconds: number | null; medianSeconds: number | null; buckets: readonly []; byAgent: readonly []; byChannel: readonly [] }>) => void) | undefined;
    vi.mocked(ready.campaigns.responseReport).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = loadResponseReport(ready.context);
    vi.mocked(ready.campaigns.resolutionReport).mockResolvedValueOnce(ok({ resolvedEpisodes: 3, averageSeconds: 15, medianSeconds: 12, reopenedEpisodes: 1, byAgent: [], byChannel: [] }));
    await loadResolutionReport(ready.context);
    resolveOld?.(ok({ measured: 1, averageSeconds: 99, medianSeconds: 99, buckets: [], byAgent: [], byChannel: [] }));
    await oldRequest;
    expect(ready.state.live.responseReport).toMatchObject({ status: 'loading' });
    expect(ready.state.live.resolutionReport).toMatchObject({ status: 'ready', value: { resolvedEpisodes: 3 } });
  });

  it('does not let an older assignments response overwrite the current filter request', async () => {
    const ready = setup();
    ready.state.live.operationalReport = { status: 'ready', value: { agents: [], agentOptions: [] } as never, loadedAt: NOW.getTime() };
    let resolveFirst: ((result: ApiResult<{ data: readonly AssignmentReportRow[]; nextCursor: string | null; hasMore: boolean }>) => void) | undefined;
    const staleRow: AssignmentReportRow = { id: 'stale', timestamp: NOW.toISOString(), conversationId: 'c-stale', customer: null, action: 'claim', previousAssignee: null, assignedTo: { membershipId: 'member', displayName: 'Ahmed' }, actor: null };
    const latestRow: AssignmentReportRow = { ...staleRow, id: 'latest', conversationId: 'c-latest' };
    vi.mocked(ready.campaigns.assignmentsReport)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(ok({ data: [latestRow], nextCursor: null, hasMore: false }));
    const first = loadAssignmentReport(ready.context);
    ready.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, from: '2026-09-01' };
    await loadAssignmentReport(ready.context);
    resolveFirst?.(ok({ data: [staleRow], nextCursor: null, hasMore: false }));
    await first;
    expect(ready.state.live.assignmentReport).toMatchObject({ status: 'ready', value: [latestRow] });
  });

  it('prevents an older report filter response replacing the latest selected filters', async () => {
    const ready = setup();
    let resolveFirst: ((result: ApiResult<CampaignReport>) => void) | undefined;
    let resolveSecond: ((result: ApiResult<CampaignReport>) => void) | undefined;
    vi.mocked(ready.campaigns.report)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const first = loadCampaignReport(ready.context);
    ready.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, from: '2026-09-01' };
    const second = loadCampaignReport(ready.context);
    resolveSecond?.(ok({ ...REPORT, generated_at: 'newer' } as CampaignReport));
    await second;
    resolveFirst?.(ok({ ...REPORT, generated_at: 'older' } as CampaignReport));
    await first;
    expect(ready.state.live.campaignReport).toMatchObject({ status: 'ready', value: { generated_at: 'newer' } });
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
    await launchCampaign(english.context, 'campaign-1', '2026-09-13T09:00:00.000Z');
    expect(english.campaigns.launch).toHaveBeenLastCalledWith('tenant-1', 'campaign-1', 'key-1', '2026-09-13T09:00:00.000Z');
    expect(english.state.toasts.at(-1)?.text).toBe('Campaign scheduled');
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
    expect(empty.state.formErrors).toEqual({ campaignName: 'Enter a campaign name.', campaignMessage: 'Write the message.' });
    // Named and written, but with no healthy channel to send it on, nothing is sent.
    empty.state.dialogForm = { campaignName: 'A', campaignMessage: 'B' };
    expect(await LIVE_ACTIONS['live-campaign-create']?.(empty.context, '')).toBe(false);
    expect(empty.campaigns.create).not.toHaveBeenCalled();
    // The select shows the first healthy channel until it is changed, and that is what is sent.
    empty.state.live.connections = { status: 'ready', loadedAt: 1, value: [{ id: 'sick', status: 'degraded' }, { id: 'well', status: 'healthy' }] as ChannelConnection[] };
    expect(await LIVE_ACTIONS['live-campaign-create']?.(empty.context, '')).toBe(true);
    expect(vi.mocked(empty.campaigns.create).mock.calls[0]?.[1]).toMatchObject({ connectionId: 'well' });
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

    // Fields the operator never touched keep what the server holds: a rename
    // must not clear the audience search or the objective, or refuse because the
    // message was not retyped.
    readyCase.state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{ ...CAMPAIGN, objective: 'Keep', audience_filter: { search: 'Mona' } }] };
    readyCase.state.dialog = { kind: 'campaign-edit', arg: 'campaign-1' };
    readyCase.state.dialogForm = { campaignName: 'Renamed only' };
    expect(await LIVE_ACTIONS['live-campaign-update']?.(readyCase.context, 'campaign-1')).toBe(true);
    expect(vi.mocked(readyCase.campaigns.update).mock.calls.at(-1)?.[2]).toMatchObject({
      name: 'Renamed only', objective: 'Keep', connectionId: 'channel-1', content: { text: 'Hello' }, audienceFilter: { search: 'Mona' },
    });
    // A saved campaign whose content has no text, edited without a message, is refused before sending.
    readyCase.state.live.campaigns = { status: 'ready', loadedAt: 1, value: [{ ...CAMPAIGN, content: { template: 'welcome' } }] };
    readyCase.state.dialogForm = { campaignName: '' };
    const calls = vi.mocked(readyCase.campaigns.update).mock.calls.length;
    expect(await LIVE_ACTIONS['live-campaign-update']?.(readyCase.context, 'campaign-1')).toBe(false);
    expect(readyCase.state.formErrors).toEqual({ campaignName: 'Enter a campaign name.', campaignMessage: 'Write the message.' });
    expect(vi.mocked(readyCase.campaigns.update).mock.calls).toHaveLength(calls);

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

  it('reloads the campaign screen, and not the session, from the global action table', async () => {
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
    // The workspace is already open; a 401 on the way closes it through the client.
    expect(peopleApi.session).not.toHaveBeenCalled();
    expect(readyCase.campaigns.list).toHaveBeenCalledWith('tenant-1');
  });
});

describe('opening and scheduling a campaign', () => {
  it('opens a campaign, asking for recipients only when it has an execution', async () => {
    const { context, state, campaigns } = setup();
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [CAMPAIGN, { ...CAMPAIGN, id: 'launched', execution: { id: 'e', state: 'running', scheduled_for: null } }] };
    expect(await LIVE_ACTIONS['live-campaign-open']?.(context, 'missing')).toBe(false);
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [] };
    expect(await LIVE_ACTIONS['live-campaign-open']?.(context, 'campaign-1')).toBe(true);
    expect(state.live.selectedCampaignId).toBe('campaign-1');
    expect(state.live.campaignRecipients).toEqual({ status: 'idle' });
    expect(campaigns.recipients).not.toHaveBeenCalled();
    expect(await LIVE_ACTIONS['live-campaign-open']?.(context, 'launched')).toBe(true);
    expect(campaigns.recipients).toHaveBeenCalledWith('tenant-1', 'launched');
  });

  it('schedules only a time in the future, read in the operator’s own zone', async () => {
    const { context, state, campaigns } = setup();
    state.dialog = { kind: 'campaign-schedule', arg: 'campaign-1' };
    expect(await LIVE_ACTIONS['live-campaign-schedule']?.(context, 'campaign-1')).toBe(false);
    expect(state.formErrors['campaignScheduleAt']).toBe('Choose a time in the future.');
    state.dialogForm = { campaignScheduleAt: 'not a time' };
    expect(await LIVE_ACTIONS['live-campaign-schedule']?.(context, 'campaign-1')).toBe(false);
    state.dialogForm = { campaignScheduleAt: '2020-01-01T09:00' };
    expect(await LIVE_ACTIONS['live-campaign-schedule']?.(context, 'campaign-1')).toBe(false);
    expect(campaigns.launch).not.toHaveBeenCalled();

    const later = new Date(NOW.getTime() + 86_400_000);
    const local = `${String(later.getFullYear())}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}T09:00`;
    state.dialogForm = { campaignScheduleAt: local };
    expect(await LIVE_ACTIONS['live-campaign-schedule']?.(context, 'campaign-1')).toBe(true);
    expect(campaigns.launch).toHaveBeenCalledWith('tenant-1', 'campaign-1', 'key-1', new Date(local).toISOString());
    expect(state.dialog).toBeNull();
    expect(state.formErrors).toEqual({});

    vi.mocked(campaigns.launch).mockResolvedValueOnce(fail());
    state.dialog = { kind: 'campaign-schedule', arg: 'campaign-1' };
    state.dialogForm = { campaignScheduleAt: local };
    expect(await LIVE_ACTIONS['live-campaign-schedule']?.(context, 'campaign-1')).toBe(false);
    expect(state.dialog).not.toBeNull();
  });
});
