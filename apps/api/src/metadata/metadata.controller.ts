import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import {
  parseBoolean,
  parseFieldCreate,
  parseFieldUpdate,
  parseLabelCreate,
  parseLabelUpdate,
  parseMutation,
  parseTarget,
  parseVersion,
} from './metadata-request.js';
import { MetadataService } from './metadata.service.js';

@Controller()
export class MetadataController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MetadataService) private readonly metadata: MetadataService,
  ) {}

  @Get('tenants/:tenantId/labels')
  async labels(@Param('tenantId') tenantId: string, @Query('includeRetired') retired: string | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.metadata.listLabels(session, tenantId, parseBoolean(retired)), null, request.id);
  }

  @Post('tenants/:tenantId/labels')
  async createLabel(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.createLabel(session, tenantId, parseLabelCreate(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/labels/:labelId')
  async updateLabel(@Param('tenantId') tenantId: string, @Param('labelId') labelId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.updateLabel(session, tenantId, labelId, parseLabelUpdate(body)), request_id: request.id };
  }

  @Delete('tenants/:tenantId/labels/:labelId')
  async retireLabel(@Param('tenantId') tenantId: string, @Param('labelId') labelId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.retireLabel(session, tenantId, labelId, parseVersion(body)), request_id: request.id };
  }

  @Get('tenants/:tenantId/custom-fields')
  async fields(@Param('tenantId') tenantId: string, @Query('target') target: string | undefined, @Query('includeRetired') retired: string | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.metadata.listFields(session, tenantId, parseTarget(target), parseBoolean(retired)), null, request.id);
  }

  @Post('tenants/:tenantId/custom-fields')
  async createField(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.createField(session, tenantId, parseFieldCreate(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/custom-fields/:fieldId')
  async updateField(@Param('tenantId') tenantId: string, @Param('fieldId') fieldId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.updateField(session, tenantId, fieldId, parseFieldUpdate(body)), request_id: request.id };
  }

  @Delete('tenants/:tenantId/custom-fields/:fieldId')
  async retireField(@Param('tenantId') tenantId: string, @Param('fieldId') fieldId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.retireField(session, tenantId, fieldId, parseVersion(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/conversations/:conversationId/metadata')
  async conversation(@Param('tenantId') tenantId: string, @Param('conversationId') conversationId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.mutateConversation(session, tenantId, conversationId, parseMutation(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/contacts/:contactId/metadata')
  async contact(@Param('tenantId') tenantId: string, @Param('contactId') contactId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.metadata.mutateContact(session, tenantId, contactId, parseMutation(body)), request_id: request.id };
  }

  private async mutating(request: FastifyRequest, csrf: string | string[] | undefined) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return session;
  }
}
