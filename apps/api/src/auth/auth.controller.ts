import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pageEnvelope } from '../pagination.js';
import {
  clearedSessionCookieHeaders,
  sessionCookieHeaders,
} from './auth-tokens.js';
import { AuthService, type AuthenticatedSession } from './auth.service.js';
import { RecoveryService } from './recovery.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
  ) {}

  /**
   * Starts password recovery.
   *
   * Always 202 with the same body, whether or not the address has an account —
   * including when the request is rate limited. A different status for a known
   * address is an account-existence oracle, which is precisely what IAM-03
   * forbids. The token is delivered out of band and never appears here.
   */
  @Post('recovery')
  async startRecovery(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.recovery.start(body, request.ip);
    await reply.status(202).send({
      data: {
        status: 'accepted',
        message: 'If that address has an account, a recovery message has been sent.',
      },
      request_id: request.id,
    });
  }

  /**
   * Completes recovery: replaces the password and revokes every session.
   *
   * The caller is logged out here too — the cookies are cleared — because the
   * transaction revoked every session for the account, including this one.
   */
  @Post('recovery/complete')
  async completeRecovery(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.recovery.complete(body, request.ip);
    reply.header('set-cookie', clearedSessionCookieHeaders(this.auth.secureCookies));
    await reply.status(204).send();
  }

  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const outcome = await this.auth.login(body, request.ip, singleHeader(request.headers['user-agent']));
    reply.header(
      'set-cookie',
      sessionCookieHeaders(outcome.tokens, this.auth.secureCookies, this.auth.sessionTtlSeconds),
    );
    await reply.status(200).send(sessionEnvelope(outcome.principal, request.id));
  }

  @Post('logout')
  async logout(
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    await this.auth.logout(session);
    reply.header('set-cookie', clearedSessionCookieHeaders(this.auth.secureCookies));
    await reply.status(204).send();
  }

  @Get('session')
  async current(@Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return sessionEnvelope(session, request.id);
  }

  @Get('sessions')
  async list(@Req() request: FastifyRequest) {
    const current = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.auth.listSessions(current), null, request.id);
  }

  @Get('sessions/:id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const current = await this.auth.authenticate(request.headers.cookie);
    return {
      data: await this.auth.getSession(current, id),
      request_id: request.id,
    };
  }

  @Delete('sessions/:id')
  async revoke(
    @Param('id') id: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const current = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(current, request.headers.cookie, csrfHeader);
    const revokedCurrent = await this.auth.revokeSession(current, id);
    if (revokedCurrent) {
      reply.header('set-cookie', clearedSessionCookieHeaders(this.auth.secureCookies));
    }
    await reply.status(204).send();
  }
}

function sessionEnvelope(session: AuthenticatedSession, requestId: string) {
  return {
    data: {
      user: { id: session.userId, email: session.email },
      session: {
        id: session.sessionId,
        created_at: session.createdAt.toISOString(),
        last_seen_at: session.lastSeenAt.toISOString(),
        expires_at: session.expiresAt.toISOString(),
      },
    },
    request_id: requestId,
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
