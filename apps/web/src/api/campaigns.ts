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

export interface CreateCampaignInput {
  readonly name: string;
  readonly objective: string | null;
  readonly connectionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly audienceFilter: Readonly<Record<string, unknown>>;
  readonly timezone: string;
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
  clone(tenantId: string, id: string, name: string, key: string): Promise<ApiResult<Campaign>> {
    return this.client.post(`/tenants/${tenantId}/campaigns/${id}/clone`, { body: { name }, idempotencyKey: key });
  }
  recipients(tenantId: string, id: string): Promise<ApiResult<readonly CampaignRecipient[]>> {
    return this.client.get(`/tenants/${tenantId}/campaigns/${id}/recipients`);
  }
}

export function disconnectedCampaignsApi(): CampaignsApi {
  return new CampaignsApi(new ApiClient({
    baseUrl: API_BASE_URL,
    fetch: () => Promise.reject(new Error('No HTTP transport is configured.')),
    readCsrfToken: () => null,
  }));
}
