import { API_BASE_URL, ApiClient, type ApiResult, type PagedData } from './client.js';

export type AutomationState = 'draft' | 'active' | 'paused' | 'archived';
export type AutomationSort = 'updated_desc' | 'name_asc' | 'name_desc';

export interface AutomationListQuery {
  readonly search: string;
  readonly state: AutomationState | '';
  readonly sort: AutomationSort;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AutomationRunsQuery {
  readonly cursor: string | null;
  readonly limit: number;
}

export const DEFAULT_AUTOMATION_LIST_QUERY: Omit<AutomationListQuery, 'cursor'> = {
  search: '', state: '', sort: 'updated_desc', limit: 25,
};

export const DEFAULT_AUTOMATION_RUNS_QUERY: Omit<AutomationRunsQuery, 'cursor'> = { limit: 25 };

export interface AutomationTrigger {
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface AutomationStep {
  readonly id: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly conditions?: readonly unknown[];
}

export interface AutomationWorkflow {
  readonly version: number;
  readonly trigger: AutomationTrigger;
  readonly target: { readonly type: string; readonly config: Readonly<Record<string, unknown>> };
  readonly steps: readonly AutomationStep[];
  readonly schedule?: Readonly<Record<string, unknown>>;
  readonly safety: Readonly<Record<string, unknown>>;
}

export interface AutomationTemplate {
  readonly key: string;
  readonly category: 'academic' | 'sales' | 'marketing' | 'operations' | 'custom';
  readonly name: string;
  readonly description: string;
  readonly preset: AutomationWorkflow;
}
export interface WhatsAppTemplate {readonly id:string;readonly connectionId:string;readonly providerTemplateId:string;readonly templateName:string;readonly language:string;readonly category:string;readonly status:'approved';readonly components:readonly unknown[];readonly variables:readonly string[];readonly lastSyncedAt:string}

export interface Automation {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly templateKey: string | null;
  readonly state: AutomationState;
  readonly workflow: AutomationWorkflow;
  readonly timezone: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly version: number;
}

export interface AutomationRun {
  readonly id: string;
  readonly automation_id: string;
  readonly status: string;
  readonly mode: 'production' | 'test';
  readonly scheduled_for: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly trigger_type: string;
  readonly audience_count: number;
  readonly queued_count: number;
  readonly sent_count: number;
  readonly delivered_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
  readonly error: unknown;
}

export interface AutomationInput {
  readonly name: string;
  readonly description: string | null;
  readonly timezone: string;
  readonly workflow: AutomationWorkflow;
}

export class AutomationsApi {
  constructor(private readonly client: ApiClient) {}
  templates(tenantId: string): Promise<ApiResult<readonly AutomationTemplate[]>> {
    return this.client.get(`/tenants/${tenantId}/automation-templates`);
  }
  whatsappTemplates(tenantId:string):Promise<ApiResult<readonly WhatsAppTemplate[]>>{return this.client.get(`/tenants/${tenantId}/whatsapp-templates`);}
  list(tenantId: string, query: AutomationListQuery = { ...DEFAULT_AUTOMATION_LIST_QUERY, cursor: null }): Promise<ApiResult<PagedData<Automation>>> {
    return this.client.page(`/tenants/${tenantId}/automations${queryString(query)}`);
  }
  runs(tenantId: string, query: AutomationRunsQuery = { ...DEFAULT_AUTOMATION_RUNS_QUERY, cursor: null }): Promise<ApiResult<PagedData<AutomationRun>>> {
    return this.client.page(`/tenants/${tenantId}/automation-runs${queryString(query)}`);
  }
  useTemplate(tenantId: string, key: string, name: string): Promise<ApiResult<Automation>> {
    return this.client.post(`/tenants/${tenantId}/automation-templates/${encodeURIComponent(key)}/use`, { body: { name } });
  }
  create(tenantId: string, input: AutomationInput): Promise<ApiResult<Automation>> {
    return this.client.post(`/tenants/${tenantId}/automations`, { body: input });
  }
  update(tenantId: string, id: string, version: number, input: AutomationInput): Promise<ApiResult<Automation>> {
    return this.client.patch(`/tenants/${tenantId}/automations/${id}`, { body: { ...input, version } });
  }
  transition(tenantId: string, automation: Automation, action: 'activate' | 'pause' | 'resume' | 'archive'): Promise<ApiResult<Automation>> {
    return this.client.post(`/tenants/${tenantId}/automations/${automation.id}/${action}`, { body: { version: automation.version } });
  }
  deleteDraft(tenantId: string, automation: Automation): Promise<ApiResult<{ readonly id: string }>> {
    return this.client.delete(`/tenants/${tenantId}/automations/${automation.id}`, { body: { version: automation.version } });
  }
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, string | number | null>)) {
    if (value !== null && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function disconnectedAutomationsApi(): AutomationsApi {
  return new AutomationsApi(new ApiClient({
    baseUrl: API_BASE_URL,
    fetch: () => Promise.reject(new Error('No HTTP transport is configured.')),
    readCsrfToken: () => null,
  }));
}
