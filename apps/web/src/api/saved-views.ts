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

  retire(tenantId: string, id: string, version: number): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/saved-views/${id}`, { body: { version } });
  }
}
