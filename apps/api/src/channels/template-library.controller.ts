import { Body, Controller, Get, Headers, Inject, Param, Patch, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { TemplateLibraryService } from './template-library.service.js';

@Controller()
export class TemplateLibraryController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(TemplateLibraryService) private readonly library: TemplateLibraryService) {}
  @Get('tenants/:tenantId/template-library')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    return { data: await this.library.list(await this.auth.authenticate(request.headers.cookie), tenantId), request_id: request.id };
  }
  @Patch('tenants/:tenantId/template-library/access')
  async update(@Param('tenantId') tenantId: string, @Body() body: unknown, @Headers('x-csrf-token') csrf: string | string[] | undefined, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return { data: await this.library.update(session, tenantId, body), request_id: request.id };
  }
}
