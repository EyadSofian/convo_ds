import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { PermissionService } from './permission.service.js';

/**
 * The tenant administration read surface: permissions, roles, people, teams.
 *
 * Every route authenticates first, then delegates the decision to
 * `PermissionService`, which asks the shared authorization engine by permission
 * key. No route here inspects a role name.
 */
@Controller('tenants/:tenantId')
export class PermissionController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
  ) {}

  @Get('permissions')
  async listPermissions(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.permissions.listCatalogue(session, tenantId), null, request.id);
  }

  @Get('roles')
  async listRoles(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.permissions.listRoles(session, tenantId), null, request.id);
  }

  @Get('people')
  async listPeople(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.permissions.listPeople(session, tenantId), null, request.id);
  }

  @Get('teams')
  async listTeams(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.permissions.listTeams(session, tenantId), null, request.id);
  }
}
