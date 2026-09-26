import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { ContactService } from './contact.service.js';

/**
 * The contact surface.
 *
 * Contacts can be created only with an explicit, selected channel identity;
 * identity matching and merge remain human decisions. Consent is append-only
 * evidence recorded through its dedicated endpoint, never inferred from
 * contact creation or import.
 */
@Controller()
export class ContactController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ContactService) private readonly contacts: ContactService,
  ) {}

  @Get('tenants/:tenantId/contacts')
  async list(
    @Param('tenantId') tenantId: string,
    @Query('q') query: string | undefined,
    @Query('label') label: string | string[] | undefined,
    @Query('fieldId') fieldId: string | undefined,
    @Query('fieldValue') fieldValue: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.contacts.list(
      session,
      tenantId,
      {
        text: query === undefined || query.trim() === '' ? null : query.trim(),
        labelIds: uuidList(label),
        fieldId: optionalUuid(fieldId, 'fieldId'),
        fieldValue: fieldValue === undefined || fieldValue === '' ? null : fieldValue,
      },
    );
    return pageEnvelope(rows, null, request.id);
  }

  @Get('tenants/:tenantId/contacts/export')
  async export(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.contacts.exportCsv(session, tenantId), request_id: request.id };
  }

  @Get('tenants/:tenantId/contacts/:contactId')
  async read(
    @Param('tenantId') tenantId: string,
    @Param('contactId') contactId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return {
      data: await this.contacts.read(session, tenantId, contactId),
      request_id: request.id,
    };
  }

  @Post('tenants/:tenantId/contacts')
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.contacts.create(session, tenantId, parseCreate(body)),
      request_id: request.id,
    };
  }

  @Post('tenants/:tenantId/contacts/:contactId/identities')
  async addIdentity(
    @Param('tenantId') tenantId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return { data: await this.contacts.addIdentity(session, tenantId, contactId, parseIdentityBody(body)), request_id: request.id };
  }

  @Post('tenants/:tenantId/contacts/import')
  async import(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const input = parseImport(body);
    return { data: await this.contacts.importBatch(session, tenantId, input), request_id: request.id };
  }

  @Patch('tenants/:tenantId/contacts/:contactId')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.contacts.update(session, tenantId, contactId, parseUpdate(body)),
      request_id: request.id,
    };
  }

  /**
   * Records consent, or its withdrawal.
   *
   * A `POST` that appends, never a `PATCH` that edits: the history is the point.
   */
  @Post('tenants/:tenantId/contacts/:contactId/consents')
  async recordConsent(
    @Param('tenantId') tenantId: string,
    @Param('contactId') contactId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.contacts.recordConsent(session, tenantId, contactId, parseConsent(body)),
      request_id: request.id,
    };
  }
}

const CHANNELS = ['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'];
const PURPOSES = ['service', 'marketing'];
const STATES = ['granted', 'withdrawn'];
const SOURCES = ['customer_message', 'agent_recorded', 'import', 'web_form'];

interface UpdateInput {
  readonly displayName: string;
}

/** A channel identity: a live connection and the customer's id on it. */
export interface IdentityInput {
  readonly connectionId: string;
  readonly externalId: string;
}

function parseIdentity(record: Record<string, unknown>, details: { field: string; code: string; message: string }[]): IdentityInput {
  const connectionId = record['connectionId'];
  const externalId = typeof record['externalId'] === 'string' ? record['externalId'].trim() : '';
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) details.push({ field: 'connectionId', code: 'invalid', message: 'Choose a valid channel connection.' });
  if (externalId.length < 1 || externalId.length > 256) details.push({ field: 'externalId', code: 'invalid', message: 'A channel identity is 1 to 256 characters.' });
  return { connectionId: connectionId as string, externalId };
}

/**
 * A new contact. The channel identity is optional: a customer typed in by
 * hand may not be reachable anywhere yet, and one who writes in gets theirs
 * attached by the message itself.
 */
function parseCreate(body: unknown): { displayName: string; identity: IdentityInput | null } {
  const record = asRecord(body);
  const displayName = typeof record['displayName'] === 'string' ? record['displayName'].trim() : '';
  const details: { field: string; code: string; message: string }[] = [];
  if (displayName.length < 1 || displayName.length > 200) details.push({ field: 'displayName', code: 'invalid', message: 'A display name is 1 to 200 characters.' });
  const named = (record['connectionId'] ?? null) !== null || (typeof record['externalId'] === 'string' && record['externalId'].trim() !== '');
  const identity = named ? parseIdentity(record, details) : null;
  if (details.length > 0) throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', details);
  return { displayName, identity };
}

function parseIdentityBody(body: unknown): IdentityInput {
  const details: { field: string; code: string; message: string }[] = [];
  const identity = parseIdentity(asRecord(body), details);
  if (details.length > 0) throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', details);
  return identity;
}

function parseImport(body: unknown): { connectionId: string; rows: readonly { displayName: string; externalId: string }[] } {
  const record = asRecord(body);
  const details: { field: string; code: string; message: string }[] = [];
  const connectionId = record['connectionId'];
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) details.push({ field: 'connectionId', code: 'invalid', message: 'Choose a valid channel connection.' });
  const sourceRows = record['rows'];
  if (!Array.isArray(sourceRows) || sourceRows.length < 1 || sourceRows.length > 500) {
    details.push({ field: 'rows', code: 'invalid', message: 'Import between 1 and 500 contacts per file.' });
  }
  const rows = Array.isArray(sourceRows) ? sourceRows.flatMap((value, index) => {
    const row = asRecordOrNull(value);
    const displayName = typeof row?.['displayName'] === 'string' ? row['displayName'].trim() : '';
    const externalId = typeof row?.['externalId'] === 'string' ? row['externalId'].trim() : '';
    if (displayName.length < 1 || displayName.length > 200) details.push({ field: `rows[${index}].displayName`, code: 'invalid', message: 'Use a display name of 1 to 200 characters.' });
    if (externalId.length < 1 || externalId.length > 256) details.push({ field: `rows[${index}].externalId`, code: 'invalid', message: 'Use a channel identity of 1 to 256 characters.' });
    return displayName.length > 0 && displayName.length <= 200 && externalId.length > 0 && externalId.length <= 256
      ? [{ displayName, externalId }]
      : [];
  }) : [];
  if (details.length > 0) throw new ApiHttpError(400, 'validation_failed', 'The import file is not valid.', details);
  return { connectionId: connectionId as string, rows };
}

function parseUpdate(body: unknown): UpdateInput {
  const record = asRecord(body);
  const details: { field: string; code: string; message: string }[] = [];
  let displayName: string | null = null;

  const name = record['displayName'];
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200) {
      details.push({
        field: 'displayName',
        code: 'invalid',
        message: 'A display name is 1 to 200 characters.',
      });
    } else {
      displayName = name.trim();
    }
  }

  if (record['attributes'] !== undefined) {
    details.push({
      field: 'attributes',
      code: 'retired_input',
      message: 'Use the typed custom-field catalogue instead of arbitrary attributes.',
    });
  }

  if (details.length > 0) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', details);
  }
  if (displayName === null) {
    // An update that changes nothing is a request that was not written
    // correctly; answering 200 would hide that from whoever sent it.
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
      { field: 'displayName', code: 'required', message: 'Send a display name.' },
    ]);
  }
  return { displayName };
}

interface ConsentInput {
  readonly channel: string;
  readonly purpose: string;
  readonly state: string;
  readonly source: string;
  readonly proofRef: string | null;
}

function parseConsent(body: unknown): ConsentInput {
  const record = asRecord(body);
  const details: { field: string; code: string; message: string }[] = [];
  const pick = (field: string, allowed: readonly string[]): string => {
    const value = record[field];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      details.push({
        field,
        code: 'unsupported_value',
        message: `${field} must be one of: ${allowed.join(', ')}.`,
      });
      return '';
    }
    return value;
  };

  const input = {
    channel: pick('channel', CHANNELS),
    purpose: pick('purpose', PURPOSES),
    state: pick('state', STATES),
    source: pick('source', SOURCES),
    proofRef: typeof record['proofRef'] === 'string' ? record['proofRef'] : null,
  };
  if (details.length > 0) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', details);
  }
  return input;
}

function asRecord(body: unknown): Record<string, unknown> {
  return asRecordOrNull(body) ?? {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalUuid(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  if (UUID.test(value)) return value;
  throw new ApiHttpError(400, 'validation_failed', 'The query is not valid.', [
    { field, code: 'invalid', message: 'Use a UUID.' },
  ]);
}

function uuidList(value: string | string[] | undefined): readonly string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.length > 20 || values.some((entry) => !UUID.test(entry))) {
    throw new ApiHttpError(400, 'validation_failed', 'The query is not valid.', [
      { field: 'label', code: 'invalid', message: 'Use at most 20 UUID values.' },
    ]);
  }
  return [...new Set(values)];
}
