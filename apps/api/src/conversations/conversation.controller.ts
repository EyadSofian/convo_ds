import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { OutboundService } from '../channels/outbound.service.js';
import { pageEnvelope } from '../pagination.js';
import { ConversationService } from './conversation.service.js';

/**
 * Conversations: the queue, the list, the record, the timeline and the reply.
 *
 * The queue and the list are deliberately **different endpoints** rather than
 * one endpoint with a flag. `/conversations/unassigned` returns projected cards
 * for work nobody holds; `/conversations` returns records, and every row it
 * returns is one the caller passed `conversation.read` for. They are different
 * things with different permissions, and an endpoint that returns either
 * depending on a query parameter is one bug away from returning the wrong one.
 *
 * Replying is addressed to a **conversation**, and the recipient comes from the
 * record. An agent allowed to reply to one customer must not be able to reach
 * another by editing a field in the request body.
 */
@Controller()
export class ConversationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConversationService) private readonly conversations: ConversationService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
  ) {}

  /** The conversations this caller may read, newest activity first. */
  @Get('tenants/:tenantId/conversations')
  async list(
    @Param('tenantId') tenantId: string,
    @Query('queue') queue: string | undefined,
    @Query('status') status: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.conversations.list(session, tenantId, {
      queue: queue === 'all' ? 'all' : 'mine',
      status: conversationStatus(status),
    });
    return pageEnvelope(rows, null, request.id);
  }

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
   * One page of the timeline, oldest-first within the page.
   *
   * `cursor` walks *backwards* through the history, because that is the
   * direction a conversation is read further into.
   */
  @Get('tenants/:tenantId/conversations/:conversationId/messages')
  async timeline(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const page = await this.conversations.timeline(
      session,
      tenantId,
      conversationId,
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return pageEnvelope(page.messages, page.nextCursor, request.id);
  }

  /**
   * Replies inside a conversation.
   *
   * The recipient comes from the conversation, never from the body: an agent
   * with permission to reply to one customer must not be able to reach another
   * by editing a field. Everything after that is the ordinary outbound path —
   * the same 202, the same permit re-check at dispatch, the same outbox row.
   */
  @Post('tenants/:tenantId/conversations/:conversationId/messages')
  async reply(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const target = await this.conversations.replyTarget(session, tenantId, conversationId);
    const queued = await this.outbound.queue(
      session,
      tenantId,
      target.connectionId,
      { ...asObject(body), peerIdentity: target.peerIdentity },
      target.resource,
    );
    await reply.status(202).send({ data: queued, request_id: request.id });
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

/**
 * The status filter, accepted only from the closed set the column allows.
 *
 * An unrecognised value is treated as no filter rather than as an error: it is
 * a list query, and the honest answer to "show me conversations that are
 * `flurble`" is the unfiltered list rather than a 400 that hides the inbox.
 */
function conversationStatus(value: string | undefined): string | null {
  return value === 'open' || value === 'snoozed' || value === 'resolved' ? value : null;
}

/** The body as an object, so a non-object one reaches the parser as empty. */
function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
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
