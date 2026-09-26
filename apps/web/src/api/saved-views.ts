import type { ConditionDocument } from '@convo/domain';
import type { ApiClient, ApiResult } from './client.js';

export type SavedViewVisibility = 'private' | 'team' | 'workspace';

/** Server-backed definition. The browser never presents a local-only view. */
export interface SavedView {
  readonly id: string;
  readonly ownerMembershipId: string;
  readonly teamId: string | null;
  readonly name: string;
  readonly resource: 'conversations' | 'contacts';
  readonly visibility: SavedViewVisibility;
  readonly conditions: ConditionDocument;
  readonly version: number;
}

export interface SavedViewInput {
  readonly name: string;
  readonly resource: 'conversations';
  readonly visibility: SavedViewVisibility;
  readonly teamId: string | null;
  readonly conditions: ConditionDocument;
}

/** A reusable campaign audience, stored as a condition document. */
export interface SavedAudience {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly conditions: ConditionDocument;
  readonly state: 'active' | 'retired';
  readonly version: number;
}

export class SavedViewsApi {
  constructor(private readonly client: ApiClient) {}

  list(tenantId: string): Promise<ApiResult<readonly SavedView[]>> {
    return this.client.get<readonly SavedView[]>(`/tenants/${tenantId}/saved-views?resource=conversations`);
  }

  create(tenantId: string, input: SavedViewInput): Promise<ApiResult<SavedView>> {
    return this.client.post<SavedView>(`/tenants/${tenantId}/saved-views`, { body: input });
  }

  update(tenantId: string, id: string, version: number, input: SavedViewInput): Promise<ApiResult<SavedView>> {
    return this.client.patch<SavedView>(`/tenants/${tenantId}/saved-views/${id}`, { body: { ...input, version } });
  }

  audiences(tenantId: string): Promise<ApiResult<readonly SavedAudience[]>> {
    return this.client.get<readonly SavedAudience[]>(`/tenants/${tenantId}/audiences`);
  }

  createAudience(tenantId: string, input: { readonly name: string; readonly description: string | null; readonly conditions: ConditionDocument }): Promise<ApiResult<SavedAudience>> {
    return this.client.post<SavedAudience>(`/tenants/${tenantId}/audiences`, { body: input });
  }

  retire(tenantId: string, id: string, version: number): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/saved-views/${id}`, { body: { version } });
  }
}
