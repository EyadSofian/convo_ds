import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ChannelAppService } from './channel-app.service.js';

@Controller()
export class ChannelAppController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChannelAppService) private readonly apps: ChannelAppService,
  ) {}

  @Get('tenants/:tenantId/channel-apps/meta')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.apps.list(session, tenantId), request_id: request.id };
  }

  @Post('tenants/:tenantId/channel-apps/meta')
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    const created = await this.apps.create(session, tenantId, body);
    await reply.status(201).send({ data: created, request_id: request.id });
  }
}
