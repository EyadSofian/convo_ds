import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { OutboundService } from './outbound.service.js';

/**
 * The outbound send surface.
 *
 * `202`, not `201` and not `200`: the command is durably queued and nothing has
 * been sent yet. Answering `200` would tell an agent their message went out at
 * the moment we had only written it down, which is the specific lie the whole
 * delivery design exists to avoid (DEL-10).
 *
 * No `Idempotency-Key` header: the body already carries `clientMessageId`, which
 * is the caller's own identifier for the message and is unique per company. A
 * second header saying the same thing would be a second thing to get wrong.
 */
@Controller()
export class OutboundController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
  ) {}

  @Post('tenants/:tenantId/channels/:connectionId/messages')
  async queue(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const queued = await this.outbound.queue(session, tenantId, connectionId, body);
    await reply.status(202).send({ data: queued, request_id: request.id });
  }

  @Get('tenants/:tenantId/channels/:connectionId/messages')
  async list(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.outbound.list(session, tenantId, connectionId), null, request.id);
  }

  @Get('tenants/:tenantId/outbound-messages/:messageId')
  async read(
    @Param('tenantId') tenantId: string,
    @Param('messageId') messageId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.outbound.read(session, tenantId, messageId), request_id: request.id };
  }
}
