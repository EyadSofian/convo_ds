import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { parseQuickReply, parseVersion, parseVersioned } from './quick-reply-request.js';
import { QuickReplyService } from './quick-reply.service.js';

@Controller()
export class QuickReplyController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(QuickReplyService) private readonly replies: QuickReplyService) {}

  @Get('tenants/:tenantId/quick-replies')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.replies.list(session, tenantId), null, request.id);
  }

  @Post('tenants/:tenantId/quick-replies')
  async create(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.replies.create(session, tenantId, parseQuickReply(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/quick-replies/:quickReplyId')
  async update(@Param('tenantId') tenantId: string, @Param('quickReplyId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    const parsed = parseVersioned(body);
    return { data: await this.replies.update(session, tenantId, id, parsed.version, parsed.value), request_id: request.id };
  }

  @Delete('tenants/:tenantId/quick-replies/:quickReplyId')
  async remove(@Param('tenantId') tenantId: string, @Param('quickReplyId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    await this.replies.remove(session, tenantId, id, parseVersion(body));
    return { data: { deleted: true }, request_id: request.id };
  }

  private async mutating(request: FastifyRequest, csrf: string | string[] | undefined) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return session;
  }
}
