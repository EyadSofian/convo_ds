import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { parseAudience, parseSavedView, parseVersion, parseVersioned, type ViewResource } from './segment-request.js';
import { SegmentService } from './segment.service.js';

@Controller()
export class SegmentController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SegmentService) private readonly segments: SegmentService) {}

  @Get('tenants/:tenantId/saved-views')
  async views(@Param('tenantId') tenantId: string, @Query('resource') resource: string | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.segments.listViews(session, tenantId, viewResource(resource)), null, request.id);
  }

  @Post('tenants/:tenantId/saved-views')
  async createView(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.segments.createView(session, tenantId, parseSavedView(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/saved-views/:viewId')
  async updateView(@Param('tenantId') tenantId: string, @Param('viewId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf); const parsed = parseVersioned(body, parseSavedView);
    return { data: await this.segments.updateView(session, tenantId, id, parsed.version, parsed.value), request_id: request.id };
  }

  @Delete('tenants/:tenantId/saved-views/:viewId')
  async retireView(@Param('tenantId') tenantId: string, @Param('viewId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf); await this.segments.retireView(session, tenantId, id, parseVersion(body));
    return { data: { retired: true }, request_id: request.id };
  }

  @Get('tenants/:tenantId/audiences')
  async audiences(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.segments.listAudiences(session, tenantId), null, request.id);
  }

  @Post('tenants/:tenantId/audiences')
  async createAudience(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf);
    return { data: await this.segments.createAudience(session, tenantId, parseAudience(body)), request_id: request.id };
  }

  @Patch('tenants/:tenantId/audiences/:audienceId')
  async updateAudience(@Param('tenantId') tenantId: string, @Param('audienceId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf); const parsed = parseVersioned(body, parseAudience);
    return { data: await this.segments.updateAudience(session, tenantId, id, parsed.version, parsed.value), request_id: request.id };
  }

  @Delete('tenants/:tenantId/audiences/:audienceId')
  async retireAudience(@Param('tenantId') tenantId: string, @Param('audienceId') id: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.mutating(request, csrf); await this.segments.retireAudience(session, tenantId, id, parseVersion(body));
    return { data: { retired: true }, request_id: request.id };
  }

  private async mutating(request: FastifyRequest, csrf: string | string[] | undefined) { const session = await this.auth.authenticate(request.headers.cookie); this.auth.requireCsrf(session, request.headers.cookie, csrf); return session; }
}

function viewResource(value: string | undefined): ViewResource {
  if (value === 'conversations' || value === 'contacts') return value;
  throw new ApiHttpError(400, 'validation_failed', 'resource must be conversations or contacts.');
}
