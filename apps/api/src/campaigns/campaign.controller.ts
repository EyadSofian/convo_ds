import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { parseCampaignClone, parseCampaignControl, parseCampaignDraft, parseCampaignLaunch, parseCampaignRetry, parseCampaignTestSend, parseCampaignUpdate, parseTestRecipient } from './campaign-request.js';
import { CampaignService } from './campaign.service.js';
import { CampaignReportingService } from './reporting.service.js';

@Controller()
export class CampaignController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CampaignService) private readonly campaigns: CampaignService,
    @Inject(CampaignReportingService) private readonly reporting: CampaignReportingService,
  ) {}

  @Get('tenants/:tenantId/campaigns')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.campaigns.list(session, tenantId), null, request.id);
  }

  @Get('tenants/:tenantId/reports/campaigns')
  async report(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return { data: await this.reporting.report(session, tenantId), request_id: request.id };
  }

  @Post('tenants/:tenantId/campaigns')
  async create(
    @Param('tenantId') tenantId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const value = await this.campaigns.create(session, tenantId, parseCampaignDraft(body), body, requireKey(key));
    await reply.status(201).send({ data: value, request_id: request.id });
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/validate')
  async validate(@Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.campaigns.validate(session, tenantId, campaignId), request_id: request.id };
  }

  @Patch('tenants/:tenantId/campaigns/:campaignId')
  async update(
    @Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.mutating(request, csrf);
    return { data: await this.campaigns.update(session, tenantId, campaignId, parseCampaignUpdate(body), body, requireKey(key)), request_id: request.id };
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/approve')
  async approve(@Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.campaigns.approve(session, tenantId, campaignId), request_id: request.id };
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/test-send')
  async testSend(
    @Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const value = await this.campaigns.testSend(session, tenantId, campaignId, parseCampaignTestSend(body), body, requireKey(key));
    await reply.status(202).send({ data: value, request_id: request.id });
  }

  @Get('tenants/:tenantId/channels/:connectionId/test-recipients')
  async testRecipients(
    @Param('tenantId') tenantId: string, @Param('connectionId') connectionId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.campaigns.listTestRecipients(session, tenantId, connectionId), null, request.id);
  }

  @Post('tenants/:tenantId/channels/:connectionId/test-recipients')
  async authorizeTestRecipient(
    @Param('tenantId') tenantId: string, @Param('connectionId') connectionId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const value = await this.campaigns.authorizeTestRecipient(session, tenantId, connectionId, parseTestRecipient(body));
    await reply.status(201).send({ data: value, request_id: request.id });
  }

  @Delete('tenants/:tenantId/channels/:connectionId/test-recipients/:authorizationId')
  async revokeTestRecipient(
    @Param('tenantId') tenantId: string, @Param('connectionId') connectionId: string,
    @Param('authorizationId') authorizationId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    await this.campaigns.revokeTestRecipient(session, tenantId, connectionId, authorizationId);
    await reply.status(204).send();
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/launch')
  async launch(
    @Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const choice = parseCampaignLaunch(body);
    const value = await this.campaigns.launch(session, tenantId, campaignId, choice.scheduledFor, body, requireKey(key));
    await reply.status(202).send({ data: value, request_id: request.id });
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/control')
  async control(@Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.campaigns.control(session, tenantId, campaignId, parseCampaignControl(body)), request_id: request.id };
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/retry')
  async retryFailures(
    @Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const retry = parseCampaignRetry(body);
    const value = await this.campaigns.retryFailures(session, tenantId, campaignId, retry, requireKey(key));
    await reply.status(202).send({ data: value, request_id: request.id });
  }

  @Post('tenants/:tenantId/campaigns/:campaignId/clone')
  async clone(
    @Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Headers('idempotency-key') key: string | string[] | undefined,
    @Req() request: FastifyRequest, @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.mutating(request, csrf);
    const value = await this.campaigns.clone(session, tenantId, campaignId, parseCampaignClone(body).name, body, requireKey(key));
    await reply.status(201).send({ data: value, request_id: request.id });
  }

  @Get('tenants/:tenantId/campaigns/:campaignId/recipients')
  async recipients(@Param('tenantId') tenantId: string, @Param('campaignId') campaignId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.campaigns.recipients(session, tenantId, campaignId), null, request.id);
  }

  private async mutating(request: FastifyRequest, csrf: string | string[] | undefined) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return session;
  }
}

function requireKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiHttpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.');
  }
  return value.trim();
}
