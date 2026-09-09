import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { PeopleService } from './people.service.js';

/**
 * The People, Roles and Teams mutation surface.
 *
 * Every route here changes something a browser can reach, so every route
 * requires CSRF. None of them is replayable in a way that would duplicate an
 * effect — a repeated role change sets the same role, a repeated archive
 * archives the same team — so none carries an `Idempotency-Key`. The one
 * mutation that mints a credential, creating an invitation, does.
 */
@Controller('tenants/:tenantId')
export class PeopleController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  private async session(request: FastifyRequest, csrf: string | string[] | undefined) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrf);
    return session;
  }

  @Patch('people/:membershipId')
  async updateMembership(
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const person = await this.people.updateMembership(session, tenantId, membershipId, body);
    await reply.status(200).send({ data: person, request_id: request.id });
  }

  @Post('roles')
  async createRole(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const role = await this.people.createRole(session, tenantId, body);
    await reply.status(201).send({ data: role, request_id: request.id });
  }

  @Patch('roles/:roleId')
  async updateRole(
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const role = await this.people.updateRole(session, tenantId, roleId, body);
    await reply.status(200).send({ data: role, request_id: request.id });
  }

  @Delete('roles/:roleId')
  async deleteRole(
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    await this.people.deleteRole(session, tenantId, roleId);
    await reply.status(204).send();
  }

  @Post('teams')
  async createTeam(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const team = await this.people.createTeam(session, tenantId, body);
    await reply.status(201).send({ data: team, request_id: request.id });
  }

  @Patch('teams/:teamId')
  async updateTeam(
    @Param('tenantId') tenantId: string,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const team = await this.people.updateTeam(session, tenantId, teamId, body);
    await reply.status(200).send({ data: team, request_id: request.id });
  }

  @Post('teams/:teamId/members')
  async addTeamMember(
    @Param('tenantId') tenantId: string,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const team = await this.people.addTeamMember(session, tenantId, teamId, body);
    await reply.status(200).send({ data: team, request_id: request.id });
  }

  @Delete('teams/:teamId/members/:membershipId')
  async removeTeamMember(
    @Param('tenantId') tenantId: string,
    @Param('teamId') teamId: string,
    @Param('membershipId') membershipId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const team = await this.people.removeTeamMember(session, tenantId, teamId, membershipId);
    await reply.status(200).send({ data: team, request_id: request.id });
  }

  @Get('ownership-transfers')
  async listTransfers(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(
      await this.people.listOwnershipTransfers(session, tenantId),
      null,
      request.id,
    );
  }

  @Post('ownership-transfers')
  async offerOwnership(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const transfer = await this.people.offerOwnership(session, tenantId, body);
    await reply.status(201).send({ data: transfer, request_id: request.id });
  }

  @Post('ownership-transfers/:transferId/accept')
  async acceptOwnership(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const transfer = await this.people.settleOwnership(session, tenantId, transferId, 'accepted');
    await reply.status(200).send({ data: transfer, request_id: request.id });
  }

  @Post('ownership-transfers/:transferId/decline')
  async declineOwnership(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    const transfer = await this.people.settleOwnership(session, tenantId, transferId, 'declined');
    await reply.status(200).send({ data: transfer, request_id: request.id });
  }

  @Delete('ownership-transfers/:transferId')
  async cancelOwnership(
    @Param('tenantId') tenantId: string,
    @Param('transferId') transferId: string,
    @Headers('x-csrf-token') csrf: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.session(request, csrf);
    await this.people.settleOwnership(session, tenantId, transferId, 'cancelled');
    await reply.status(204).send();
  }
}
