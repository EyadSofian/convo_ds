export interface CrmSender {
  readonly id: string;
  readonly displayName: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string | null;
  readonly sendReady: boolean;
}

export interface CrmKey {
  readonly id: string;
  readonly label: string;
  readonly connection_ids: readonly string[];
  readonly expires_at: string;
}

export interface CrmSettings {
  readonly tenantId: string;
  readonly senders: readonly CrmSender[];
  readonly keys: readonly CrmKey[];
}

export interface CreatedCrmKey {
  readonly key: CrmKey;
  readonly token: string;
}
