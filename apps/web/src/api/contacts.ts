import type { ApiClient, ApiResult } from './client.js';
import type { EntityMetadata } from './metadata.js';

/**
 * The contact operations, typed against the pinned OpenAPI.
 *
 * There is no `create` and no `merge` here because there are none on the wire:
 * a contact exists because somebody wrote to us, and joining two of them is a
 * reviewed act this build does not offer. Their absence is the point — a
 * "create contact" form would invite somebody to type a phone number and call
 * it a person, which is the identity inference the model refuses.
 */

export interface ContactIdentity {
  readonly id: string;
  readonly kind: string;
  readonly scopeId: string;
  readonly externalId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface ConsentRecord {
  readonly channel: string;
  readonly purpose: string;
  readonly state: string;
  readonly source: string;
  readonly recordedAt: string;
  readonly actorMembershipId: string | null;
}

/**
 * A row in the directory.
 *
 * Deliberately without consent: a list is not the place to decide whether we
 * may write to somebody, and a summary that carried a half-answer would invite
 * exactly that. The two shapes are separate types for the same reason the
 * server keeps them separate — so nothing can read a consent history that was
 * never loaded and find it empty.
 */
export interface ContactSummary extends EntityMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly attributes: Record<string, unknown>;
  readonly version: number;
  readonly createdAt: string;
  readonly identities: readonly ContactIdentity[];
}

/** One contact, read whole: identities, consent history, and suppressions. */
export interface Contact extends ContactSummary {
  /** Newest first. */
  readonly consent: readonly ConsentRecord[];
  /** Channels this contact opted out on. Outranks any consent above. */
  readonly suppressed: readonly string[];
}

export interface ConsentInput {
  readonly channel: string;
  readonly purpose: string;
  readonly state: 'granted' | 'withdrawn';
  readonly source: string;
  readonly proofRef: string | null;
}

export class ContactsApi {
  constructor(private readonly client: ApiClient) {}

  list(
    tenantId: string,
    input: string | { readonly query: string; readonly labelId: string; readonly fieldId: string; readonly fieldValue: string },
  ): Promise<ApiResult<readonly ContactSummary[]>> {
    const filters = typeof input === 'string'
      ? { query: input, labelId: '', fieldId: '', fieldValue: '' }
      : input;
    const query = new URLSearchParams();
    if (filters.query.trim() !== '') query.set('q', filters.query.trim());
    if (filters.labelId !== '') query.append('label', filters.labelId);
    if (filters.fieldId !== '' && filters.fieldValue !== '') {
      query.set('fieldId', filters.fieldId);
      query.set('fieldValue', filters.fieldValue);
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.get<readonly ContactSummary[]>(`/tenants/${tenantId}/contacts${suffix}`);
  }

  read(tenantId: string, contactId: string): Promise<ApiResult<Contact>> {
    return this.client.get<Contact>(`/tenants/${tenantId}/contacts/${contactId}`);
  }

  update(
    tenantId: string,
    contactId: string,
    input: { readonly displayName: string },
  ): Promise<ApiResult<Contact>> {
    return this.client.patch<Contact>(`/tenants/${tenantId}/contacts/${contactId}`, {
      body: input,
    });
  }

  recordConsent(
    tenantId: string,
    contactId: string,
    input: ConsentInput,
  ): Promise<ApiResult<Contact>> {
    return this.client.post<Contact>(`/tenants/${tenantId}/contacts/${contactId}/consents`, {
      body: input,
    });
  }
}
