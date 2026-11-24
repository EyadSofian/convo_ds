import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthRateLimiter } from '../auth/auth-rate-limiter.js';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { CrmWhatsAppService, type CrmKey, type CrmSender, type CrmTarget } from './crm-whatsapp.service.js';

@Controller('tenants/:tenantId/crm/whatsapp')
export class CrmWhatsAppController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CrmWhatsAppService) private readonly crm: CrmWhatsAppService,
    @Inject(AuthRateLimiter) private readonly limiter: AuthRateLimiter,
  ) {}

  @Get('settings')
  async settings(@Param('tenantId') tenant: string, @Req() request: FastifyRequest): Promise<{ data: { tenantId: string; senders: CrmSender[]; keys: readonly CrmKey[] }; request_id: string }> {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.crm.settings(session, tenant), request_id: request.id };
  }

  @Post('keys')
  @Header('Cache-Control', 'no-store')
  async createKey(@Param('tenantId') tenant: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, request.headers['x-csrf-token']);
    return { data: await this.crm.createKey(session, tenant, body), request_id: request.id };
  }

  @Delete('keys/:keyId')
  @HttpCode(204)
  async revokeKey(@Param('tenantId') tenant: string, @Param('keyId') id: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, request.headers['x-csrf-token']);
    await this.crm.revokeKey(session, tenant, id);
  }

  @Get('senders')
  @Header('Cache-Control', 'no-store')
  async senders(@Param('tenantId') tenant: string, @Req() request: FastifyRequest): Promise<{ data: CrmSender[]; request_id: string }> {
    await this.rateLimit(request);
    const data = await this.crm.withKey(tenant, request.headers.authorization, (context) => this.crm.listSenders(context));
    return { data, request_id: request.id };
  }

  @Get('senders/:connectionId/templates')
  @Header('Cache-Control', 'no-store')
  async templates(
    @Param('tenantId') tenant: string, @Param('connectionId') id: string, @Query('cursor') cursor: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    await this.rateLimit(request);
    const data = await this.crm.withKey(tenant, request.headers.authorization, (context) => this.crm.templates(context, id, cursor));
    return { data, request_id: request.id };
  }

  @Post('lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async lookup(@Param('tenantId') tenant: string, @Body() body: unknown, @Req() request: FastifyRequest): Promise<{ data: CrmTarget; request_id: string }> {
    await this.rateLimit(request);
    const data = await this.crm.withKey(tenant, request.headers.authorization, (context) => this.crm.lookup(context, body));
    return { data, request_id: request.id };
  }

  @Post('messages')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async send(@Param('tenantId') tenant: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    await this.rateLimit(request);
    const data = await this.crm.withKey(tenant, request.headers.authorization, (context) => this.crm.send(context, body));
    return { data, request_id: request.id };
  }

  @Get('messages/:messageId')
  @Header('Cache-Control', 'no-store')
  async status(@Param('tenantId') tenant: string, @Param('messageId') id: string, @Req() request: FastifyRequest) {
    await this.rateLimit(request);
    const data = await this.crm.withKey(tenant, request.headers.authorization, (context) => this.crm.status(context, id));
    return { data, request_id: request.id };
  }

  private async rateLimit(request: FastifyRequest): Promise<void> {
    const result = await this.limiter.consume('crm-whatsapp', request.ip, { windowSeconds: 60, maxAttempts: 300 });
    if (result.status === 'blocked') {
      throw new ApiHttpError(429, 'rate_limited', 'Too many CRM requests.', [], { 'retry-after': String(result.retryAfterSeconds) });
    }
  }
}
