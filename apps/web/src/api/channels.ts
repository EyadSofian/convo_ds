import type { ApiClient, ApiResult } from './client.js';

/**
 * The channel operations, typed against the pinned OpenAPI.
 *
 * The browser calls CONVO, never a provider. There is no Meta host, no Graph
 * version and no access token anywhere in this file — a token goes out once, in
 * the body of a connect or a rotation, and never comes back.
 */

export type ChannelKind = 'whatsapp' | 'messenger' | 'instagram' | 'web_chat' | 'custom';

export type ChannelReadiness =
  | 'not_configured'
  | 'authorization_needed'
  | 'webhook_pending'
  | 'healthy'
  | 'degraded'
  | 'disconnected';

export interface TextLimit {
  readonly characters: number;
  readonly bytes: number;
}

export interface CapabilityMatrix {
  readonly kind: ChannelKind;
  readonly version: string;
  readonly host: string;
  readonly inboundEvents: readonly string[];
  readonly outboundTypes: readonly string[];
  readonly attachmentTypes: readonly string[];
  readonly textLimit: TextLimit;
  readonly windowHours: number | null;
  readonly businessInitiated: boolean;
  readonly templates: boolean;
  readonly deliveryReceipts: boolean;
  readonly readReceipts: boolean;
}

export interface ChannelEvidence {
  readonly kind: string;
  readonly satisfied: boolean;
  readonly observed_at: string | null;
}

export interface ChannelConnection {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly provider: string;
  readonly display_name: string;
  readonly external_asset_id: string;
  readonly provider_app_id: string | null;
  readonly status: ChannelReadiness;
  readonly capabilities: CapabilityMatrix;
  readonly evidence: readonly ChannelEvidence[];
  readonly missing_evidence: readonly string[];
  readonly last_error_code: string | null;
  readonly last_error_at: string | null;
  readonly created_at: string;
  readonly disconnected_at: string | null;
  readonly credential_held: boolean;
  readonly credential_fingerprint: string | null;
}

export interface ChannelCatalogueEntry {
  readonly kind: ChannelKind;
  readonly provider: string;
  readonly implemented: boolean;
  readonly capabilities: CapabilityMatrix;
}

export interface ConnectChannelInput {
  readonly kind: ChannelKind;
  readonly externalAssetId: string;
  readonly displayName: string;
  readonly accessToken: string;
  readonly providerAppId: string | null;
}

export class ChannelsApi {
  constructor(private readonly client: ApiClient) {}

  connections(tenantId: string): Promise<ApiResult<readonly ChannelConnection[]>> {
    return this.client.get<readonly ChannelConnection[]>(`/tenants/${tenantId}/channels`);
  }

  catalogue(tenantId: string): Promise<ApiResult<readonly ChannelCatalogueEntry[]>> {
    return this.client.get<readonly ChannelCatalogueEntry[]>(
      `/tenants/${tenantId}/channels/catalogue`,
    );
  }

  /**
   * Connects an asset.
   *
   * Carries an idempotency key because a retried connect that minted a second
   * connection would leave two rows racing for the same inbound messages.
   */
  connect(
    tenantId: string,
    input: ConnectChannelInput,
    idempotencyKey: string,
  ): Promise<ApiResult<ChannelConnection>> {
    return this.client.post<ChannelConnection>(`/tenants/${tenantId}/channels`, {
      body: input,
      idempotencyKey,
    });
  }

  test(tenantId: string, connectionId: string): Promise<ApiResult<ChannelConnection>> {
    return this.client.post<ChannelConnection>(
      `/tenants/${tenantId}/channels/${connectionId}/test`,
    );
  }

  rotate(
    tenantId: string,
    connectionId: string,
    accessToken: string,
  ): Promise<ApiResult<ChannelConnection>> {
    return this.client.post<ChannelConnection>(
      `/tenants/${tenantId}/channels/${connectionId}/credential`,
      { body: { accessToken } },
    );
  }

  disconnect(tenantId: string, connectionId: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/channels/${connectionId}`);
  }
}
