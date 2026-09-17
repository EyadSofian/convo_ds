import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { ChannelService } from './channel.service.js';

/**
 * The Channels surface.
 *
 * Every mutation is a browser mutation, so every one carries CSRF. Only
 * `connect` carries an `Idempotency-Key`: it is the one operation whose replay
 * would duplicate an effect — a second connection racing the first for the same
 * inbound messages. A repeated test, rotate or disconnect converges on the same
 * state, so demanding a key there would be ceremony without a reason.
 */
@Controller()
export class ChannelController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChannelService) private readonly channels: ChannelService,
  ) {}

  @Get('tenants/:tenantId/channels')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.channels.list(session, tenantId), null, request.id);
  }

  @Get('tenants/:tenantId/channels/catalogue')
  async catalogue(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.channels.catalogue(session, tenantId), null, request.id);
  }

  @Post('tenants/:tenantId/channels')
  async connect(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const created = await this.channels.connect(
      session,
      tenantId,
      body,
      requireIdempotencyKey(idempotencyKey),
    );
    await reply.status(201).send({ data: created, request_id: request.id });
  }

  @Post('tenants/:tenantId/channels/:connectionId/test')
  async test(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const tested = await this.channels.test(session, tenantId, connectionId);
    await reply.status(200).send({ data: tested, request_id: request.id });
  }

  @Post('tenants/:tenantId/channels/:connectionId/templates/sync')
  async syncTemplates(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return { data: await this.channels.syncTemplates(session, tenantId, connectionId), request_id: request.id };
  }

  @Post('tenants/:tenantId/channels/:connectionId/credential')
  async rotate(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const rotated = await this.channels.rotate(session, tenantId, connectionId, body);
    await reply.status(200).send({ data: rotated, request_id: request.id });
  }

  @Delete('tenants/:tenantId/channels/:connectionId')
  async disconnect(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    await this.channels.disconnect(session, tenantId, connectionId);
    await reply.status(204).send();
  }
}

function requireIdempotencyKey(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApiHttpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.', [
      { field: 'Idempotency-Key', code: 'required', message: 'Send a unique key for this command.' },
    ]);
  }
  return header.trim();
}
