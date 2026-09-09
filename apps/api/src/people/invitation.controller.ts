import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { InvitationService } from './invitation.service.js';

/**
 * Invitation endpoints.
 *
 * `POST` and `DELETE` are browser mutations, so they carry CSRF. Creation also
 * carries `Idempotency-Key`, because a retried create would otherwise mint a
 * second live token for the same seat.
 *
 * Acceptance is deliberately unauthenticated and CSRF-free: the accepter has no
 * session yet, and the token in the URL is the only thing that identifies the
 * request. It is single-use, short-lived and rate-limited for that reason.
 */
@Controller()
export class InvitationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}

  @Get('tenants/:tenantId/invitations')
  async list(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.invitations.list(session, tenantId), null, request.id);
  }

  @Post('tenants/:tenantId/invitations')
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const created = await this.invitations.create(
      session,
      tenantId,
      body,
      requireIdempotencyKey(idempotencyKey),
    );
    await reply.status(201).send({ data: created, request_id: request.id });
  }

  @Delete('tenants/:tenantId/invitations/:invitationId')
  async revoke(
    @Param('tenantId') tenantId: string,
    @Param('invitationId') invitationId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    await this.invitations.revoke(session, tenantId, invitationId);
    await reply.status(204).send();
  }

  @Post('invitations/:token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const accepted = await this.invitations.accept(token, body, request.ip);
    await reply.status(201).send({
      data: { tenant_id: accepted.tenantId, membership_id: accepted.membershipId },
      request_id: request.id,
    });
  }
}

/**
 * Creating an invitation mints a credential, so a retry must not mint a second
 * one. The key is required rather than optional: an optional idempotency key is
 * one a client forgets exactly when the network is bad enough to need it.
 */
function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 255) {
    throw new ApiHttpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.', [
      {
        field: 'Idempotency-Key',
        code: 'required',
        message: 'Provide a stable key of 8 to 255 characters.',
      },
    ]);
  }
  return value;
}
