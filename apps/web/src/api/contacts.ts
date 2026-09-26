import type { ApiClient, ApiResult } from './client.js';
import type { EntityMetadata } from './metadata.js';

/**
 * The contact operations, typed against the pinned OpenAPI.
 *
 * Contacts may be explicitly created against one selected channel identity.
 * Identities are never inferred or merged, and create does not imply consent.
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

export interface ContactImportRow { readonly displayName: string; readonly externalId: string }
export type ContactCsvPreview =
  | { readonly ok: true; readonly rows: readonly ContactImportRow[] }
  | { readonly ok: false; readonly message: string };

/** Parse the deliberately narrow, documented CSV format without guessing identities. */
export function previewContactCsv(source: string): ContactCsvPreview {
  if (new TextEncoder().encode(source).byteLength > 1_000_000) return { ok: false, message: 'CSV must be 1 MB or smaller.' };
  const records = csvRecords(source.replace(/^\uFEFF/, ''));
  if (records === null || records.length < 2) return { ok: false, message: 'Use a CSV header and at least one contact row.' };
  const headers = records[0]?.map((cell) => cell.trim().toLowerCase());
  if (headers?.length !== 2 || headers[0] !== 'display_name' || headers[1] !== 'external_id') {
    return { ok: false, message: 'Expected exactly these columns: display_name, external_id.' };
  }
  const data = records.slice(1).filter((record) => record.some((cell) => cell.trim() !== ''));
  if (data.length < 1 || data.length > 500) return { ok: false, message: 'Import between 1 and 500 contacts per file.' };
  const seen = new Set<string>();
  const rows: ContactImportRow[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const row = data[index]!;
    // csvRecords always starts each record with a first cell; a missing second
    // cell is allowed through parsing and rejected by the shape check below.
    const displayName = row[0]!.trim();
    const externalId = row[1]?.trim() ?? '';
    if (row.length !== 2 || displayName.length < 1 || displayName.length > 200 || externalId.length < 1 || externalId.length > 256) {
      return { ok: false, message: `Row ${index + 2} must contain a name (1–200 characters) and channel ID (1–256 characters).` };
    }
    if (seen.has(externalId)) return { ok: false, message: `Row ${index + 2} repeats a channel ID from this file.` };
    seen.add(externalId);
    rows.push({ displayName, externalId });
  }
  return { ok: true, rows };
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

  /** A contact, on a channel identity when one is given. */
  create(tenantId: string, input: { readonly displayName: string; readonly connectionId?: string; readonly externalId?: string }): Promise<ApiResult<Contact>> {
    return this.client.post<Contact>(`/tenants/${tenantId}/contacts`, { body: input });
  }

  addIdentity(tenantId: string, contactId: string, input: { readonly connectionId: string; readonly externalId: string }): Promise<ApiResult<Contact>> {
    return this.client.post<Contact>(`/tenants/${tenantId}/contacts/${contactId}/identities`, { body: input });
  }

  import(tenantId: string, input: { readonly connectionId: string; readonly rows: readonly ContactImportRow[] }): Promise<ApiResult<{ readonly created: number }>> {
    return this.client.post<{ readonly created: number }>(`/tenants/${tenantId}/contacts/import`, { body: input });
  }

  export(tenantId: string): Promise<ApiResult<{ readonly filename: string; readonly content: string; readonly rowCount: number }>> {
    return this.client.get<{ readonly filename: string; readonly content: string; readonly rowCount: number }>(`/tenants/${tenantId}/contacts/export`);
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

function csvRecords(source: string): string[][] | null {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (char === '"' && cell === '' && !closedQuote) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; closedQuote = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); records.push(row); row = []; cell = ''; closedQuote = false;
    } else if (char === '"') return null;
    else if (closedQuote) return null;
    else cell += char;
  }
  if (quoted) return null;
  if (cell !== '' || row.length > 0) { row.push(cell); records.push(row); }
  return records;
}
