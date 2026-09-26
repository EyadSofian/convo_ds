import { API_BASE_URL, ApiClient, type ApiResult, type PagedData } from './client.js';

export type CampaignState = 'draft' | 'validating' | 'ready' | 'scheduled' | 'running' |
  'pausing' | 'paused' | 'dispatch_completed' | 'cancelling' | 'cancelled' | 'failed';

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly objective: string | null;
  readonly connection_id: string;
  readonly state: CampaignState;
  readonly version: number;
  readonly revision_id: string;
  readonly revision: number;
  readonly revision_hash: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audience_filter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expires_at: string | null;
  readonly budget_amount_minor: string;
  readonly budget_currency: string;
  readonly approved: boolean;
  readonly audience: { readonly total: number; readonly eligible: number; readonly excluded: number } | null;
  readonly execution: { readonly id: string; readonly state: string; readonly scheduled_for: string | null } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CampaignRecipient {
  readonly id: string;
  readonly contact_id: string;
  readonly display_name: string;
  readonly external_id: string;
  readonly state: string;
  readonly last_error: unknown;
  readonly estimated_amount_minor: string | null;
  readonly currency: string | null;
}

export interface CampaignTestSend {
  readonly id: string;
  readonly campaign_id: string;
  readonly revision_id: string;
  readonly test_recipient_id: string;
  readonly recipient_label: string;
  readonly peer_identity: string;
  readonly message_id: string;
  readonly state: string;
  readonly state_reason: string | null;
  readonly created_at: string;
}

export interface CampaignRetry {
  readonly id: string;
  readonly campaign_id: string;
  readonly execution_id: string;
  readonly recipient_count: number;
  readonly state: 'running';
  readonly requested_at: string;
}

export interface CampaignReportFilterInput {
  readonly from: string;
  readonly to: string;
  readonly channel: string;
  readonly campaignId: string;
}

export interface CampaignReportTrendDay {
  readonly day: string;
  readonly recipients: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
}

export interface CampaignReportCampaign {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly denominator: number;
  readonly pending: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
  readonly outcome_unknown: number;
  readonly included: number | null;
  readonly excluded: number | null;
  readonly fresh_through: string;
}

export interface CampaignReport {
  readonly generated_at: string;
  readonly fresh_through: string;
  readonly timezone: 'UTC';
  readonly filters: {
    readonly from: string | null;
    readonly to: string | null;
    readonly channel: string | null;
    readonly campaign_id: string | null;
  };
  readonly definitions: { readonly campaigns: number; readonly executions: number };
  readonly audience: { readonly denominator: number; readonly eligible: number; readonly excluded: number };
  readonly current: {
    readonly denominator: number; readonly planned: number; readonly queued: number; readonly in_flight: number;
    readonly accepted: number; readonly delivered: number; readonly read: number; readonly failed: number;
    readonly skipped: number; readonly cancelled: number; readonly outcome_unknown: number;
  };
  readonly milestones: { readonly denominator: number; readonly accepted: number; readonly delivered: number; readonly read: number };
  readonly costs: readonly { readonly currency: string; readonly estimated_amount_minor: string; readonly committed_amount_minor: string; readonly reconciled_amount_minor: string }[];
  readonly channels: readonly { readonly kind: string; readonly denominator: number; readonly accepted: number; readonly delivered: number; readonly read: number; readonly delivery_receipts: boolean; readonly read_receipts: boolean }[];
  readonly errors: readonly { readonly code: string; readonly count: number }[];
  readonly trend: readonly CampaignReportTrendDay[];
  readonly campaigns: readonly CampaignReportCampaign[];
}

export interface CampaignReportExport {
  readonly id: string;
  readonly campaign_id: string | null;
  readonly format: 'csv';
  readonly state: 'queued' | 'running' | 'completed' | 'failed';
  readonly row_count: number | null;
  readonly error_code: string | null;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly expires_at: string | null;
  readonly download_url: string | null;
}

/** Current operational workload and durable episode timings, calculated by the API. */
export interface OperationalReport {
  readonly generatedAt: string;
  readonly filters: { readonly from: string | null; readonly to: string | null; readonly agentId: string | null; readonly teamId: string | null; readonly channel: string | null; readonly connectionId: string | null; readonly labelId: string | null; readonly campaignId: string | null; readonly priority: string | null; readonly status: string | null };
  readonly agentOptions: readonly { readonly membershipId: string; readonly name: string; readonly teams: readonly string[] }[];
  readonly conversations: {
    readonly open: number;
    readonly unassigned: number;
    readonly new: number;
    readonly resolved: number;
    readonly assignedInPeriod: number;
    readonly humanMessages: number;
    readonly internalNotes: number;
    readonly reassignments: number;
    readonly backlogByStatus: readonly { readonly status: string; readonly count: number }[];
    readonly backlogByChannel: readonly { readonly channel: string; readonly count: number }[];
    readonly backlogByTeam: readonly { readonly team: string; readonly count: number }[];
    readonly assignmentWorkload: readonly { readonly name: string; readonly count: number }[];
  };
  readonly timing: {
    readonly firstResponseMeasured: number;
    readonly firstResponseAverageSeconds: number | null;
    readonly firstResponseMedianSeconds: number | null;
    readonly resolutionMeasured: number;
    readonly resolutionAverageSeconds: number | null;
    readonly resolutionMedianSeconds: number | null;
  };
  readonly responseBuckets: readonly { readonly bucket: string; readonly count: number }[];
  readonly channels: readonly {
    readonly channel: string; readonly currentActive: number; readonly newConversations: number;
    readonly handledConversations: number; readonly humanMessages: number;
    readonly firstResponses: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null;
    readonly resolutions: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null;
  }[];
  readonly agents: readonly {
    readonly membershipId: string; readonly name: string; readonly email: string; readonly teams: readonly string[];
    readonly currentAssigned: number; readonly currentOpen: number; readonly currentPending: number; readonly currentSnoozed: number;
    readonly currentUnreplied: number; readonly currentUrgent: number; readonly currentHigh: number;
    readonly currentByStatus: readonly { readonly status: string; readonly count: number }[];
    readonly currentByChannel: readonly { readonly channel: string; readonly count: number }[];
    readonly assignedInPeriod: number; readonly handledConversations: number; readonly humanMessages: number; readonly internalNotes: number;
    readonly firstResponses: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null;
    readonly resolutions: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null;
    readonly reassignments: number;
  }[];
}

export interface OperationalReportFilterInput {
  readonly from: string;
  readonly to: string;
  readonly agentId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly connectionId: string;
  readonly labelId: string;
  readonly campaignId: string;
  readonly priority: string;
  readonly status: string;
}

export interface AssignmentReportRow {
  readonly id: string;
  readonly timestamp: string;
  readonly conversationId: string;
  readonly customer: string | null;
  readonly action: 'claim' | 'assign' | 'handoff';
  readonly previousAssignee: { readonly membershipId: string; readonly displayName: string } | null;
  readonly assignedTo: { readonly membershipId: string; readonly displayName: string };
  readonly actor: { readonly membershipId: string; readonly displayName: string } | null;
}

export interface TimingReportRow {
  readonly membershipId: string | null;
  readonly name: string;
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
}
export interface TimingChannelReportRow {
  readonly channel: string;
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
}
export interface ResponseReport {
  readonly measured: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
  readonly buckets: readonly { readonly bucket: string; readonly count: number }[];
  readonly byAgent: readonly TimingReportRow[];
  readonly byChannel: readonly TimingChannelReportRow[];
}
export interface ResolutionReport {
  readonly resolvedEpisodes: number;
  readonly averageSeconds: number | null;
  readonly medianSeconds: number | null;
  readonly reopenedEpisodes: number;
  readonly byAgent: readonly TimingReportRow[];
  readonly byChannel: readonly TimingChannelReportRow[];
}

export interface TeamReportRow {
  readonly teamId: string; readonly name: string; readonly activeAgentCount: number;
  readonly currentActive: number; readonly currentOpen: number; readonly currentPending: number; readonly currentSnoozed: number;
  readonly handledConversations: number; readonly humanMessages: number;
  readonly firstResponses: number; readonly firstResponseAverageSeconds: number | null; readonly firstResponseMedianSeconds: number | null;
  readonly resolutions: number; readonly resolutionAverageSeconds: number | null; readonly resolutionMedianSeconds: number | null;
}

export interface CreateCampaignInput {
  readonly name: string;
  readonly objective: string | null;
  readonly connectionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audienceFilter: AudienceFilter;
  readonly timezone: string;
  readonly expiresAt?: string | null;
  readonly budgetAmountMinor: number;
  readonly budgetCurrency: string;
}

/**
 * Who a campaign is addressed to, within the contacts on its channel. Every
 * list narrows; an absent list does not. `labelIds` requires every contact
 * label; `conversationLabelIds` matches any conversation carrying any of them.
 */
export interface AudienceFilter {
  readonly search?: string;
  readonly labelIds?: readonly string[];
  readonly conversationLabelIds?: readonly string[];
  readonly contactIds?: readonly string[];
}

/** The server's count of a filter, before anything is frozen. */
export interface AudiencePreview {
  readonly total: number;
  readonly eligible: number;
  readonly excluded: number;
  readonly reasons: { readonly suppressed: number; readonly no_consent: number; readonly identity_inactive: number };
  readonly sample: readonly string[];
}

export class CampaignsApi {
  constructor(private readonly client: ApiClient) {}
  previewAudience(tenantId: string, connectionId: string, audienceFilter: AudienceFilter): Promise<ApiResult<AudiencePreview>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/audience-preview`, { body: { connectionId, audienceFilter } });
  }
  list(tenantId: string): Promise<ApiResult<readonly Campaign[]>> {
    return this.client.get(`/tenants/${tenantId}/campaigns`);
  }
  create(tenantId: string, input: CreateCampaignInput, key: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns`, { body: input, idempotencyKey: key });
  }
  update(tenantId: string, id: string, input: CreateCampaignInput, expectedVersion: number, key: string): Promise<ApiResult<Campaign>> {
    return this.client.patch(`/tenants/${tenantId}/campaigns/${id}`, {
      body: { ...input, expectedVersion }, idempotencyKey: key,
    });
  }
  validate(tenantId: string, id: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/validate`);
  }
  approve(tenantId: string, id: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/approve`);
  }
  /** Now when `scheduledFor` is null; otherwise a future instant the server re-checks. */
  launch(tenantId: string, id: string, key: string, scheduledFor: string | null = null): Promise<ApiResult<Campaign>> {
    const body = scheduledFor === null ? { mode: 'now' } : { mode: 'scheduled', scheduledFor };
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/launch`, { body, idempotencyKey: key });
  }
  control(tenantId: string, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/control`, { body: { action } });
  }
  retryFailures(tenantId: string, id: string, key: string): Promise<ApiResult<CampaignRetry>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/retry`, { body: {}, idempotencyKey: key });
  }
  clone(tenantId: string, id: string, name: string, key: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/clone`, { body: { name }, idempotencyKey: key });
  }
  testSend(tenantId: string, id: string, testRecipientId: string, expectedVersion: number, key: string): Promise<ApiResult<CampaignTestSend>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/test-send`, {
      body: { testRecipientId, expectedVersion }, idempotencyKey: key,
    });
  }
  recipients(tenantId: string, id: string): Promise<ApiResult<readonly CampaignRecipient[]>> {
    return this.client.get(`/tenants/${tenantId}/campaigns/${id}/recipients`);
  }
  report(tenantId: string, filters: CampaignReportFilterInput | null = null): Promise<ApiResult<CampaignReport>> {
    const query = new URLSearchParams();
    if (filters !== null) {
      if (filters.from !== '') query.set('from', filters.from);
      if (filters.to !== '') query.set('to', filters.to);
      if (filters.channel !== '') query.set('channel', filters.channel);
      if (filters.campaignId !== '') query.set('campaignId', filters.campaignId);
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get(`/tenants/${tenantId}/reports/campaigns${suffix}`);
  }
  operationsReport(tenantId: string, filters: OperationalReportFilterInput): Promise<ApiResult<OperationalReport>> {
    const query = reportFilterQuery(filters);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get(`/tenants/${tenantId}/reports/operations${suffix}`);
  }
  assignmentsReport(tenantId: string, filters: OperationalReportFilterInput, cursor: string | null = null, limit = 50): Promise<ApiResult<PagedData<AssignmentReportRow>>> {
    const query = reportFilterQuery(filters);
    if (cursor !== null) query.set('cursor', cursor);
    query.set('limit', String(limit));
    return this.client.page(`/tenants/${tenantId}/reports/assignments?${query.toString()}`);
  }
  responseReport(tenantId: string, filters: OperationalReportFilterInput): Promise<ApiResult<ResponseReport>> {
    const query = reportFilterQuery(filters);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get(`/tenants/${tenantId}/reports/responses${suffix}`);
  }
  resolutionReport(tenantId: string, filters: OperationalReportFilterInput): Promise<ApiResult<ResolutionReport>> {
    const query = reportFilterQuery(filters);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get(`/tenants/${tenantId}/reports/resolutions${suffix}`);
  }
  teamReport(tenantId: string, filters: OperationalReportFilterInput): Promise<ApiResult<readonly TeamReportRow[]>> {
    const query = reportFilterQuery(filters);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get(`/tenants/${tenantId}/reports/teams${suffix}`);
  }
  createReportExport(tenantId: string, campaignId: string | null, key: string): Promise<ApiResult<CampaignReportExport>> {
    return this.client.post(`/tenants/${tenantId}/reports/campaigns/exports`, {
      body: { format: 'csv', campaignId }, idempotencyKey: key,
    });
  }
  reportExport(tenantId: string, exportId: string): Promise<ApiResult<CampaignReportExport>> {
    return this.client.get(`/tenants/${tenantId}/reports/campaigns/exports/${exportId}`);
  }
}

function reportFilterQuery(filters: OperationalReportFilterInput): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of ['from','to','agentId','teamId','channel','connectionId','labelId','campaignId','priority','status'] as const) {
    const value = filters[key];
    if (value !== '') query.set(key, value);
  }
  return query;
}

export function disconnectedCampaignsApi(): CampaignsApi {
  return new CampaignsApi(new ApiClient({
    baseUrl: API_BASE_URL,
    fetch: () => Promise.reject(new Error('No HTTP transport is configured.')),
    readCsrfToken: () => null,
  }));
}
