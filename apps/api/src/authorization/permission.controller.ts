import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { PermissionService } from './permission.service.js';

@Controller('tenants/:tenantId/permissions')
export class PermissionController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
  ) {}

  @Get()
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(
      await this.permissions.listCatalogue(session, tenantId),
      null,
      request.id,
    );
  }
}
