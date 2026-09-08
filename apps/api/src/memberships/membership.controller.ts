import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { pageEnvelope } from '../pagination.js';
import { MembershipService } from './membership.service.js';

@Controller('me/memberships')
export class MembershipController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
  ) {}

  @Get()
  async list(@Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.memberships.listActive(session), null, request.id);
  }
}
