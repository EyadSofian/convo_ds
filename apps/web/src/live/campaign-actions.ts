import type { ApiResult } from '../api/client.js';
import type { Campaign, CampaignTestSend, CreateCampaignInput } from '../api/campaigns.js';
import type { ChannelTestRecipient } from '../api/channels.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { currentTenantId, failed, fromResult, LOADING, refetching } from './store.js';

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

export async function loadCampaignsScreen(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  context.live.campaigns = refetching(context.live, context.live.campaigns);
  context.live.connections = refetching(context.live, context.live.connections);
  context.live.testRecipients = refetching(context.live, context.live.testRecipients);
  context.refresh();
  const [campaigns, connections] = await Promise.all([
    context.live.campaignsApi.list(tenantId),
    context.live.channels.connections(tenantId),
  ]);
  const now = context.now();
  context.live.campaigns = fromResult(campaigns, now);
  context.live.connections = fromResult(connections, now);
  if (!connections.ok) {
    context.live.testRecipients = { status: 'error', error: connections.error };
  } else {
    const results = await Promise.all(connections.data.map((connection) => context.live.channels.testRecipients(tenantId, connection.id)));
    const refusal = results.find((result) => !result.ok);
    context.live.testRecipients = refusal !== undefined && !refusal.ok
      ? { status: 'error', error: refusal.error }
      : { status: 'ready', value: (results as readonly { readonly ok: true; readonly data: readonly ChannelTestRecipient[] }[])
        .flatMap((result) => result.data), loadedAt: now };
  }
  context.refresh();
}

/**
 * Reads the report for the scope chosen on screen.
 *
 * The campaigns offered in the campaign filter are remembered from the last
 * report that was not already narrowed to one campaign, so choosing a campaign
 * does not shrink the list of campaigns that could have been chosen.
 */
export async function loadCampaignReport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  const generation = beginAnalyticsRequest(context);
  const filters = context.state.analyticsFilters;
  context.live.campaignReport = refetching(context.live, context.live.campaignReport);
  context.refresh();
  const result = await context.live.campaignsApi.report(tenantId, filters);
  if (context.live.analyticsRequestGeneration !== generation) return;
  context.live.campaignReport = fromResult(result, context.now());
  if (result.ok && (filters.campaignId === '' || context.live.reportCampaigns.length === 0)) {
    context.live.reportCampaigns = result.data.campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name }));
  }
  context.refresh();
}

/** Reads the operational report from its own server projection. */
export async function loadOperationalReport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  const generation = beginAnalyticsRequest(context);
  context.live.operationalReport = refetching(context.live, context.live.operationalReport);
  const optionsLoads: Promise<void>[] = [];
  if (context.live.teams.status === 'idle') {
    context.live.teams = LOADING;
    optionsLoads.push(context.live.api.teams(tenantId).then((result) => { context.live.teams = fromResult(result, context.now()); }));
  }
  if (context.live.connections.status === 'idle') {
    context.live.connections = LOADING;
    optionsLoads.push(context.live.channels.connections(tenantId).then((result) => { context.live.connections = fromResult(result, context.now()); }));
  }
  if (context.live.workspaceLabels.status === 'idle') {
    context.live.workspaceLabels = LOADING;
    optionsLoads.push(context.live.metadataApi.labels(tenantId, true).then((result) => { context.live.workspaceLabels = fromResult(result, context.now()); }));
  }
  if (context.live.campaigns.status === 'idle') {
    context.live.campaigns = LOADING;
    optionsLoads.push(context.live.campaignsApi.list(tenantId).then((result) => { context.live.campaigns = fromResult(result, context.now()); }));
  }
  context.refresh();
  const [result] = await Promise.all([
    context.live.campaignsApi.operationsReport(tenantId, context.state.analyticsFilters),
    ...optionsLoads,
  ]);
  if (context.live.analyticsRequestGeneration !== generation) return;
  context.live.operationalReport = fromResult(result, context.now());
  if (result.ok && context.state.analyticsFilters.agentId === '') {
    context.live.operationalAgentOptions = { tenantId, agents: result.data.agents };
  }
  context.refresh();
}

export async function loadAssignmentReport(context: LiveContext, append = false): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  const invocation = ++context.live.assignmentRequestGeneration;
  // The existing scoped report response supplies the picker directory and
  // filter catalogues; the assignment rows themselves always come from their
  // own bounded, keyset-paginated endpoint.
  if (context.live.operationalReport.status !== 'ready') await loadOperationalReport(context);
  if (context.live.assignmentRequestGeneration !== invocation) return;
  const generation = beginAnalyticsRequest(context);
  const cursor = append ? context.live.assignmentNextCursor : null;
  if (append && cursor === null) return;
  context.live.assignmentLoadingMore = append;
  if (!append) {
    context.live.assignmentReport = refetching(context.live, context.live.assignmentReport);
    context.live.assignmentNextCursor = null;
  }
  context.refresh();
  const result = await context.live.campaignsApi.assignmentsReport(tenantId, context.state.analyticsFilters, cursor, 50);
  if (context.live.analyticsRequestGeneration !== generation || context.live.assignmentRequestGeneration !== invocation) return;
  context.live.assignmentLoadingMore = false;
  if (!result.ok) {
    context.live.assignmentReport = failed(result.error);
    context.live.assignmentNextCursor = null;
  } else {
    const previous = append && context.live.assignmentReport.status === 'ready' ? context.live.assignmentReport.value : [];
    context.live.assignmentReport = { status: 'ready', value: [...previous, ...result.data.data], loadedAt: context.now() };
    context.live.assignmentNextCursor = result.data.nextCursor;
  }
  context.refresh();
}

export async function loadResponseReport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  if (context.live.operationalReport.status !== 'ready') await loadOperationalReport(context);
  const generation = beginAnalyticsRequest(context);
  context.live.responseReport = refetching(context.live, context.live.responseReport);
  context.refresh();
  const result = await context.live.campaignsApi.responseReport(tenantId, context.state.analyticsFilters);
  if (context.live.analyticsRequestGeneration !== generation) return;
  context.live.responseReport = fromResult(result, context.now());
  context.refresh();
}

export async function loadResolutionReport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  if (context.live.operationalReport.status !== 'ready') await loadOperationalReport(context);
  const generation = beginAnalyticsRequest(context);
  context.live.resolutionReport = refetching(context.live, context.live.resolutionReport);
  context.refresh();
  const result = await context.live.campaignsApi.resolutionReport(tenantId, context.state.analyticsFilters);
  if (context.live.analyticsRequestGeneration !== generation) return;
  context.live.resolutionReport = fromResult(result, context.now());
  context.refresh();
}

export async function loadTeamReport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  if (context.live.operationalReport.status !== 'ready') await loadOperationalReport(context);
  const generation = beginAnalyticsRequest(context);
  context.live.teamReport = refetching(context.live, context.live.teamReport);
  context.refresh();
  const result = await context.live.campaignsApi.teamReport(tenantId, context.state.analyticsFilters);
  if (context.live.analyticsRequestGeneration !== generation) return;
  context.live.teamReport = fromResult(result, context.now());
  context.refresh();
}

export function loadAnalyticsReport(context: LiveContext): Promise<void> {
  if (context.state.analyticsView === 'overview' || context.state.analyticsView === 'agents' || context.state.analyticsView === 'channels') return loadOperationalReport(context);
  if (context.state.analyticsView === 'responses') return loadResponseReport(context);
  if (context.state.analyticsView === 'resolutions') return loadResolutionReport(context);
  if (context.state.analyticsView === 'teams') return loadTeamReport(context);
  if (context.state.analyticsView === 'assignments') return loadAssignmentReport(context);
  return loadCampaignReport(context);
}

function beginAnalyticsRequest(context: LiveContext): number {
  const generation = context.live.analyticsRequestGeneration + 1;
  context.live.analyticsRequestGeneration = generation;
  return generation;
}

export async function createCampaignReportExport(context: LiveContext): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return false;
  context.live.busy = 'campaign-report-export';
  context.live.error = null;
  context.refresh();
  // The export endpoint scopes by campaign only; the screen says so beside the button.
  const campaignId = context.state.analyticsFilters.campaignId;
  const result = await context.live.campaignsApi.createReportExport(tenantId, campaignId === '' ? null : campaignId, context.newKey());
  context.live.busy = null;
  context.live.revision += 1;
  if (!result.ok) {
    context.live.error = result.error;
    context.live.campaignReportExport = failed(result.error);
    context.refresh();
    return false;
  }
  context.live.campaignReportExport = { status: 'ready', value: result.data, loadedAt: context.now() };
  pushToast(context.state, t(context, 'بدأ تجهيز ملف CSV', 'CSV export queued'));
  context.refresh();
  return true;
}

export async function refreshCampaignReportExport(context: LiveContext): Promise<void> {
  const tenantId = currentTenantId(context.live);
  const current = context.live.campaignReportExport;
  if (tenantId === null || current.status !== 'ready') return;
  const result = await context.live.campaignsApi.reportExport(tenantId, current.value.id);
  context.live.campaignReportExport = fromResult(result, context.now());
  context.refresh();
}

export function createCampaign(context: LiveContext, input: CreateCampaignInput): Promise<boolean> {
  return mutate(context, 'campaign-create',
    (tenantId) => context.live.campaignsApi.create(tenantId, input, context.newKey()),
    (campaign) => t(context, `أُنشئت مسودة «${campaign.name}»`, `Draft “${campaign.name}” created`));
}

export function updateCampaign(context: LiveContext, id: string, input: CreateCampaignInput, expectedVersion: number): Promise<boolean> {
  return mutate(context, `campaign-update:${id}`,
    (tenantId) => context.live.campaignsApi.update(tenantId, id, input, expectedVersion, context.newKey()),
    (campaign) => t(context, `حُفظت المراجعة ${String(campaign.revision)}`, `Revision ${String(campaign.revision)} saved`));
}

export function validateCampaign(context: LiveContext, id: string): Promise<boolean> {
  return mutate(context, `campaign-validate:${id}`,
    (tenantId) => context.live.campaignsApi.validate(tenantId, id),
    (campaign) => t(context, `ثُبّت جمهور من ${String(campaign.audience?.eligible ?? 0)} مستلم`,
      `Audience frozen with ${String(campaign.audience?.eligible ?? 0)} eligible recipients`));
}

export function approveCampaign(context: LiveContext, id: string): Promise<boolean> {
  return mutate(context, `campaign-approve:${id}`,
    (tenantId) => context.live.campaignsApi.approve(tenantId, id),
    () => t(context, 'اعتُمدت هذه النسخة', 'This revision was approved'));
}

export function launchCampaign(context: LiveContext, id: string, scheduledFor: string | null = null): Promise<boolean> {
  return mutate(context, `campaign-launch:${id}`,
    (tenantId) => context.live.campaignsApi.launch(tenantId, id, context.newKey(), scheduledFor),
    () => scheduledFor === null
      ? t(context, 'بدأ تنفيذ الحملة', 'Campaign execution started')
      : t(context, 'جُدولت الحملة', 'Campaign scheduled'));
}

export function controlCampaign(context: LiveContext, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
  return mutate(context, `campaign-${action}:${id}`,
    (tenantId) => context.live.campaignsApi.control(tenantId, id, action),
    () => action === 'pause' ? t(context, 'توقفت الإرسالات الجديدة', 'New dispatches paused')
      : action === 'resume' ? t(context, 'استؤنفت الحملة', 'Campaign resumed')
        : t(context, 'أُلغيت الأعمال التي لم تُرسل', 'Undispatched work cancelled'));
}

export async function retryCampaignFailures(context: LiveContext, id: string): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return false;
  context.live.busy = `campaign-retry:${id}`;
  context.live.error = null;
  context.refresh();
  const result = await context.live.campaignsApi.retryFailures(tenantId, id, context.newKey());
  context.live.busy = null;
  context.live.revision += 1;
  if (!result.ok) {
    context.live.error = result.error;
    context.refresh();
    return false;
  }
  pushToast(context.state, t(context,
    `أُعيدت جدولة ${String(result.data.recipient_count)} رسالة فاشلة فقط`,
    `${String(result.data.recipient_count)} failed message(s) queued for retry`));
  await loadCampaignsScreen(context);
  return true;
}

export function cloneCampaign(context: LiveContext, id: string, sourceName: string): Promise<boolean> {
  const name = t(context, `نسخة من ${sourceName}`, `${sourceName} — copy`).slice(0, 160).trim();
  return mutate(context, `campaign-clone:${id}`,
    (tenantId) => context.live.campaignsApi.clone(tenantId, id, name, context.newKey()),
    (campaign) => t(context, `أُنشئت مسودة «${campaign.name}»`, `Draft “${campaign.name}” created`));
}

export async function testSendCampaign(
  context: LiveContext,
  campaignId: string,
  testRecipientId: string,
  expectedVersion: number,
): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return false;
  context.live.busy = `campaign-test-send:${campaignId}`;
  context.live.error = null;
  context.refresh();
  const result: ApiResult<CampaignTestSend> = await context.live.campaignsApi.testSend(
    tenantId, campaignId, testRecipientId, expectedVersion, context.newKey(),
  );
  context.live.busy = null;
  context.live.revision += 1;
  if (!result.ok) {
    context.live.error = result.error;
    context.refresh();
    return false;
  }
  pushToast(context.state, t(context, `أُضيف اختبار «${result.data.recipient_label}» إلى طابور الإرسال`,
    `Test to “${result.data.recipient_label}” queued`));
  context.refresh();
  return true;
}

export async function loadCampaignRecipients(context: LiveContext, id: string): Promise<void> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return;
  context.live.selectedCampaignId = id;
  context.live.campaignRecipients = LOADING;
  context.refresh();
  const result = await context.live.campaignsApi.recipients(tenantId, id);
  context.live.campaignRecipients = fromResult(result, context.now());
  context.refresh();
}

async function mutate(
  context: LiveContext,
  busy: string,
  run: (tenantId: string) => Promise<ApiResult<Campaign>>,
  message: (campaign: Campaign) => string,
): Promise<boolean> {
  const tenantId = currentTenantId(context.live);
  if (tenantId === null) return false;
  context.live.busy = busy;
  context.live.error = null;
  context.refresh();
  const result = await run(tenantId);
  context.live.busy = null;
  context.live.revision += 1;
  if (!result.ok) {
    context.live.error = result.error;
    context.live.campaigns = failed(result.error);
    context.refresh();
    return false;
  }
  pushToast(context.state, message(result.data));
  await loadCampaignsScreen(context);
  return true;
}
