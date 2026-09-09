import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { ContactService } from './contact.service.js';

/**
 * The contact surface.
 *
 * Reading, correcting the business fields, and recording consent. There is no
 * "create contact" and no "merge": a contact comes into existence because
 * somebody wrote to us, and joining two of them is a reviewed act that this
 * build does not offer. Both absences are deliberate — an endpoint that created
 * contacts from typed-in phone numbers would be the identity inference the
 * whole model refuses (CT-03).
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
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.contacts.list(
      session,
      tenantId,
      query === undefined || query.trim() === '' ? null : query.trim(),
    );
    return pageEnvelope(rows, null, request.id);
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
  readonly displayName?: string;
  readonly attributes?: Record<string, unknown>;
}

function parseUpdate(body: unknown): UpdateInput {
  const record = asRecord(body);
  const details: { field: string; code: string; message: string }[] = [];
  const input: { displayName?: string; attributes?: Record<string, unknown> } = {};

  const name = record['displayName'];
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200) {
      details.push({
        field: 'displayName',
        code: 'invalid',
        message: 'A display name is 1 to 200 characters.',
      });
    } else {
      input.displayName = name.trim();
    }
  }

  const attributes = record['attributes'];
  if (attributes !== undefined) {
    const parsed = asRecordOrNull(attributes);
    if (parsed === null) {
      details.push({
        field: 'attributes',
        code: 'invalid',
        message: 'Business fields are an object of named values.',
      });
    } else {
      input.attributes = parsed;
    }
  }

  if (details.length > 0) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', details);
  }
  if (input.displayName === undefined && input.attributes === undefined) {
    // An update that changes nothing is a request that was not written
    // correctly; answering 200 would hide that from whoever sent it.
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
      { field: 'displayName', code: 'required', message: 'Send a display name or attributes.' },
    ]);
  }
  return input;
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
