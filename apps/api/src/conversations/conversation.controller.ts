import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { pageEnvelope } from '../pagination.js';
import { ConversationService } from './conversation.service.js';

/**
 * Conversations: the queue, the claim, and the record.
 *
 * The two read routes are deliberately different endpoints rather than one
 * endpoint with a `?full=true`. A queue card and a conversation are different
 * things with different permissions, and an endpoint that returns either
 * depending on a flag is one bug away from returning the wrong one.
 */
@Controller()
export class ConversationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConversationService) private readonly conversations: ConversationService,
  ) {}

  /** The Unassigned queue, as projected cards. Never a transcript. */
  @Get('tenants/:tenantId/conversations/unassigned')
  async unassigned(
    @Param('tenantId') tenantId: string,
    @Query('inboxId') inboxId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const cards = await this.conversations.unassigned(session, tenantId, inboxId ?? null);
    return pageEnvelope(cards, null, request.id);
  }

  @Get('tenants/:tenantId/conversations/:conversationId')
  async read(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return {
      data: await this.conversations.read(session, tenantId, conversationId),
      request_id: request.id,
    };
  }

  /**
   * Claims a conversation at a version the caller has actually seen.
   *
   * The version is required, not optional-with-a-default. A claim without one
   * would be "take this from whoever has it", which is a different operation
   * with a different permission (`conversation.assign`).
   */
  @Post('tenants/:tenantId/conversations/:conversationId/claim')
  async claim(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.conversations.claim(
        session,
        tenantId,
        conversationId,
        expectedVersion(body),
      ),
      request_id: request.id,
    };
  }
}

function expectedVersion(body: unknown): number {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['version']
      : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ApiHttpError(
      400,
      'validation_failed',
      'The request body is not valid.',
      [{ field: 'version', code: 'required', message: 'Send the version you saw on the card.' }],
    );
  }
  return value;
}
