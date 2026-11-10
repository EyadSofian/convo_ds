import type { ApiClient, ApiResult } from './client.js';

export type FieldTarget = 'contact' | 'conversation';
export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'single_select' | 'multi_select';

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly state: 'active' | 'retired';
  readonly version: number;
}

export interface CustomField {
  readonly id: string;
  readonly target: FieldTarget;
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  readonly options: readonly string[];
  readonly state: 'active' | 'retired';
  readonly version: number;
}

export interface FieldEntry {
  readonly fieldId: string;
  readonly value: string | number | boolean | readonly string[];
}

export interface EntityMetadata {
  readonly labels: readonly Label[];
  readonly customFields: readonly FieldEntry[];
}

/** A place a location quick reply points the customer to. */
export interface QuickReplyLocation {
  readonly name: string;
  readonly address: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

/** A saved reply an agent drops into the composer with a button or "/shortcut". */
export interface QuickReply {
  readonly id: string;
  readonly shortcut: string;
  readonly title: string;
  readonly kind: 'text' | 'location';
  readonly body: string;
  readonly location: QuickReplyLocation | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface QuickReplyInput {
  readonly shortcut: string;
  readonly title: string;
  readonly kind: 'text' | 'location';
  readonly body: string;
  readonly location: QuickReplyLocation | null;
}

export interface MetadataMutation {
  readonly version: number;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  readonly fields?: readonly { readonly fieldId: string; readonly value: unknown | null }[];
}

export interface MetadataResult {
  readonly version: number;
  readonly metadata: EntityMetadata;
}

export class MetadataApi {
  constructor(private readonly client: ApiClient) {}

  labels(tenantId: string, includeRetired = false): Promise<ApiResult<readonly Label[]>> {
    return this.client.get<readonly Label[]>(`/tenants/${tenantId}/labels${includeRetired ? '?includeRetired=true' : ''}`);
  }

  fields(tenantId: string): Promise<ApiResult<readonly CustomField[]>> {
    return this.client.get<readonly CustomField[]>(`/tenants/${tenantId}/custom-fields`);
  }

  createLabel(tenantId: string, name: string, color: string): Promise<ApiResult<Label>> {
    return this.client.post<Label>(`/tenants/${tenantId}/labels`, { body: { name, color } });
  }

  updateLabel(tenantId: string, id: string, input: { readonly version: number; readonly name: string; readonly color: string }): Promise<ApiResult<Label>> {
    return this.client.patch<Label>(`/tenants/${tenantId}/labels/${id}`, { body: input });
  }

  retireLabel(tenantId: string, id: string, version: number): Promise<ApiResult<Label>> {
    return this.client.delete<Label>(`/tenants/${tenantId}/labels/${id}`, { body: { version } });
  }

  createField(
    tenantId: string,
    input: { readonly target: FieldTarget; readonly key: string; readonly name: string; readonly type: FieldType; readonly options: readonly string[] },
  ): Promise<ApiResult<CustomField>> {
    return this.client.post<CustomField>(`/tenants/${tenantId}/custom-fields`, { body: input });
  }

  quickReplies(tenantId: string): Promise<ApiResult<readonly QuickReply[]>> {
    return this.client.get<readonly QuickReply[]>(`/tenants/${tenantId}/quick-replies`);
  }

  createQuickReply(tenantId: string, input: QuickReplyInput): Promise<ApiResult<QuickReply>> {
    return this.client.post<QuickReply>(`/tenants/${tenantId}/quick-replies`, { body: input });
  }

  updateQuickReply(tenantId: string, id: string, version: number, input: QuickReplyInput): Promise<ApiResult<QuickReply>> {
    return this.client.patch<QuickReply>(`/tenants/${tenantId}/quick-replies/${id}`, { body: { ...input, version } });
  }

  deleteQuickReply(tenantId: string, id: string, version: number): Promise<ApiResult<{ readonly deleted: boolean }>> {
    return this.client.delete<{ readonly deleted: boolean }>(`/tenants/${tenantId}/quick-replies/${id}`, { body: { version } });
  }

  conversation(tenantId: string, id: string, input: MetadataMutation): Promise<ApiResult<MetadataResult>> {
    return this.client.patch<MetadataResult>(`/tenants/${tenantId}/conversations/${id}/metadata`, { body: input });
  }

  contact(tenantId: string, id: string, input: MetadataMutation): Promise<ApiResult<MetadataResult>> {
    return this.client.patch<MetadataResult>(`/tenants/${tenantId}/contacts/${id}/metadata`, { body: input });
  }
}
