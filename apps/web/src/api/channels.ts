import type { ApiClient, ApiResult } from './client.js';
import type { WhatsAppTemplate } from './automations.js';

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
  readonly facebook_page_id: string | null;
  readonly waba_id: string | null;
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
  /** Our own channels: origins a browser delivery must come from. */
  readonly origins?: readonly string[];
  /** A Custom Channel: where replies are posted. */
  readonly outbound_url?: string | null;
}

export interface ChannelSettingsInput {
  readonly wabaId?: string;
  readonly origins?: readonly string[];
  readonly outboundUrl?: string | null;
}

export interface ChannelCatalogueEntry {
  readonly kind: ChannelKind;
  readonly provider: string;
  readonly implemented: boolean;
  readonly capabilities: CapabilityMatrix;
}

export interface TemplateSyncResult {
  readonly connection_id: string;
  readonly imported: number;
  readonly disabled: number;
  readonly synced_at: string;
}

export interface WebhookSubscriptionResult {
  readonly waba_id: string;
  readonly updated_connections: number;
}

export interface MetaAppSummary {
  readonly id: string;
  readonly external_app_id: string;
  readonly scope: 'workspace' | 'installation';
  readonly status: string;
  readonly secret_held: boolean;
  readonly created_at: string;
}

export interface CreatedMetaApp extends MetaAppSummary {
  /** Shown exactly once after creation; never included in later reads. */
  readonly verify_token: string;
}

export interface ChannelTestRecipient {
  readonly id: string;
  readonly connection_id: string;
  readonly identity_id: string;
  readonly peer_identity: string;
  readonly display_name: string;
  readonly label: string;
  readonly authorized_at: string;
}

export interface QueuedContactMessage {
  readonly id: string;
  readonly command_state: string;
}

export interface QuickWhatsAppResult {
  readonly conversationId: string;
  readonly message: QueuedContactMessage;
}

export interface QuickWhatsAppOptions {
  readonly connections: readonly { readonly id: string; readonly displayName: string }[];
  readonly templates: readonly WhatsAppTemplate[];
}

export interface ConnectChannelInput {
  readonly kind: ChannelKind;
  readonly externalAssetId: string;
  readonly displayName: string;
  readonly accessToken: string;
  readonly providerAppId: string | null;
  readonly settings?: { readonly facebookPageId: string } | { readonly wabaId: string } | { readonly origins: readonly string[]; readonly outboundUrl?: string };
}

export class ChannelsApi {
  constructor(private readonly client: ApiClient) {}

  quickWhatsAppOptions(tenantId: string): Promise<ApiResult<QuickWhatsAppOptions>> {
    return this.client.get<QuickWhatsAppOptions>(`/tenants/${tenantId}/quick-whatsapp/options`);
  }

  metaApps(tenantId: string): Promise<ApiResult<readonly MetaAppSummary[]>> {
    return this.client.get<readonly MetaAppSummary[]>(`/tenants/${tenantId}/channel-apps/meta`);
  }

  createMetaApp(tenantId: string, externalAppId: string, appSecret: string): Promise<ApiResult<CreatedMetaApp>> {
    return this.client.post<CreatedMetaApp>(`/tenants/${tenantId}/channel-apps/meta`, {
      body: { externalAppId, appSecret },
    });
  }

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

  syncWhatsAppTemplates(tenantId: string, connectionId: string): Promise<ApiResult<TemplateSyncResult>> {
    return this.client.post<TemplateSyncResult>(`/tenants/${tenantId}/channels/${connectionId}/templates/sync`);
  }

  sendContactTemplate(tenantId: string, connectionId: string, peerIdentity: string, templateId: string, parameters: Readonly<Record<string, string>>, clientMessageId: string): Promise<ApiResult<QueuedContactMessage>> {
    return this.client.post<QueuedContactMessage>(`/tenants/${tenantId}/channels/${connectionId}/messages`, {
      body: { peerIdentity, messageType: 'template', text: '', template: { id: templateId, parameters }, clientMessageId, trafficClass: 'interactive' },
    });
  }

  sendQuickWhatsApp(tenantId: string, connectionId: string, input: {
    readonly peerIdentity: string;
    readonly consentReference: string;
    readonly template: { readonly id: string; readonly parameters: Readonly<Record<string, string>> };
    readonly clientMessageId: string;
  }): Promise<ApiResult<QuickWhatsAppResult>> {
    return this.client.post<QuickWhatsAppResult>(`/tenants/${tenantId}/channels/${connectionId}/quick-messages`, { body: input });
  }

  subscribeWhatsAppWebhook(tenantId: string, connectionId: string): Promise<ApiResult<WebhookSubscriptionResult>> {
    return this.client.post<WebhookSubscriptionResult>(`/tenants/${tenantId}/channels/${connectionId}/webhook/subscribe`);
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

  setInstagramPage(tenantId: string, connectionId: string, facebookPageId: string): Promise<ApiResult<ChannelConnection>> {
    return this.client.post<ChannelConnection>(`/tenants/${tenantId}/channels/${connectionId}/instagram-page`, {
      body: { facebookPageId },
    });
  }

  updateSettings(tenantId: string, connectionId: string, settings: ChannelSettingsInput): Promise<ApiResult<ChannelConnection>> {
    return this.client.post<ChannelConnection>(`/tenants/${tenantId}/channels/${connectionId}/settings`, { body: settings });
  }

  disconnect(tenantId: string, connectionId: string): Promise<ApiResult<undefined>> {
    return this.client.delete<undefined>(`/tenants/${tenantId}/channels/${connectionId}`);
  }

  testRecipients(tenantId: string, connectionId: string): Promise<ApiResult<readonly ChannelTestRecipient[]>> {
    return this.client.get(`/tenants/${tenantId}/channels/${connectionId}/test-recipients`);
  }

  authorizeTestRecipient(
    tenantId: string,
    connectionId: string,
    peerIdentity: string,
    label: string,
  ): Promise<ApiResult<ChannelTestRecipient>> {
    return this.client.post(`/tenants/${tenantId}/channels/${connectionId}/test-recipients`, {
      body: { peerIdentity, label },
    });
  }

  revokeTestRecipient(tenantId: string, connectionId: string, id: string): Promise<ApiResult<undefined>> {
    return this.client.delete(`/tenants/${tenantId}/channels/${connectionId}/test-recipients/${id}`);
  }
}
