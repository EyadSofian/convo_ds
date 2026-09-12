import type { ApiClient, ApiResult } from './client.js';

export type FieldTarget = 'contact' | 'conversation';
export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'single_select' | 'multi_select';

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

  labels(tenantId: string): Promise<ApiResult<readonly Label[]>> {
    return this.client.get<readonly Label[]>(`/tenants/${tenantId}/labels`);
  }

  fields(tenantId: string): Promise<ApiResult<readonly CustomField[]>> {
    return this.client.get<readonly CustomField[]>(`/tenants/${tenantId}/custom-fields`);
  }

  createLabel(tenantId: string, name: string, color: string): Promise<ApiResult<Label>> {
    return this.client.post<Label>(`/tenants/${tenantId}/labels`, { body: { name, color } });
  }

  createField(
    tenantId: string,
    input: { readonly target: FieldTarget; readonly key: string; readonly name: string; readonly type: FieldType; readonly options: readonly string[] },
  ): Promise<ApiResult<CustomField>> {
    return this.client.post<CustomField>(`/tenants/${tenantId}/custom-fields`, { body: input });
  }

  conversation(tenantId: string, id: string, input: MetadataMutation): Promise<ApiResult<MetadataResult>> {
    return this.client.patch<MetadataResult>(`/tenants/${tenantId}/conversations/${id}/metadata`, { body: input });
  }

  contact(tenantId: string, id: string, input: MetadataMutation): Promise<ApiResult<MetadataResult>> {
    return this.client.patch<MetadataResult>(`/tenants/${tenantId}/contacts/${id}/metadata`, { body: input });
  }
}
