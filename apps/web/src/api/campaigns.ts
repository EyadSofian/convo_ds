import { API_BASE_URL, ApiClient, type ApiResult } from './client.js';

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

export interface CampaignReport {
  readonly generated_at: string;
  readonly fresh_through: string;
  readonly timezone: 'UTC';
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
  readonly campaigns: readonly { readonly id: string; readonly name: string; readonly state: string; readonly denominator: number; readonly accepted: number; readonly delivered: number; readonly read: number; readonly failed: number; readonly outcome_unknown: number; readonly fresh_through: string }[];
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

export interface CreateCampaignInput {
  readonly name: string;
  readonly objective: string | null;
  readonly connectionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audienceFilter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
  readonly expiresAt?: string | null;
  readonly budgetAmountMinor: number;
  readonly budgetCurrency: string;
}

export class CampaignsApi {
  constructor(private readonly client: ApiClient) {}
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
  launch(tenantId: string, id: string, key: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/launch`, { body: { mode: 'now' }, idempotencyKey: key });
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
  report(tenantId: string): Promise<ApiResult<CampaignReport>> {
    return this.client.get(`/tenants/${tenantId}/reports/campaigns`);
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

export function disconnectedCampaignsApi(): CampaignsApi {
  return new CampaignsApi(new ApiClient({
    baseUrl: API_BASE_URL,
    fetch: () => Promise.reject(new Error('No HTTP transport is configured.')),
    readCsrfToken: () => null,
  }));
}
