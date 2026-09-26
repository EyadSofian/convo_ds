import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HANDOFF_DEFAULT_TTL_MS } from '@convo/domain';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { OutboundService } from '../channels/outbound.service.js';
import { pageEnvelope } from '../pagination.js';
import { ConversationService } from './conversation.service.js';
import { LifecycleService } from './lifecycle.service.js';
import type { LifecycleCommand } from './lifecycle.service.js';
import { NoteService } from './note.service.js';
import { isPriority, RoutingService } from './routing.service.js';
import type { AssignmentCommand } from './routing.service.js';
import { parseInboxQuery } from './inbox-query-request.js';

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
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(NoteService) private readonly notes: NoteService,
    @Inject(RoutingService) private readonly routing: RoutingService,
  ) {}

  /** The conversations this caller may read, newest activity first. */
  @Get('tenants/:tenantId/conversations')
  async list(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const page = await this.conversations.list(session, tenantId, parseInboxQuery(query));
    return pageEnvelope(page.items, page.nextCursor, request.id);
  }

  @Get('tenants/:tenantId/supervisor/agents')
  async supervisorAgents(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest) {
    const session = await this.auth.authenticate(request.headers.cookie);
    return pageEnvelope(await this.conversations.supervisorAgents(session, tenantId), null, request.id);
  }

  @Get('tenants/:tenantId/supervisor/conversations')
  async supervisorList(
    @Param('tenantId') tenantId: string,
    @Query('agent') agent: string | undefined,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const agentMembershipId = optionalUuid(agent, 'agent');
    if (agentMembershipId === null) throw queryError('agent', 'Choose an agent.');
    const inboxQuery = { ...query };
    delete inboxQuery.agent;
    const page = await this.conversations.supervisorList(session, tenantId, agentMembershipId, parseInboxQuery(inboxQuery));
    return pageEnvelope(page.items, page.nextCursor, request.id);
  }

  @Get('tenants/:tenantId/supervisor/workload')
  async supervisorWorkload(
    @Param('tenantId') tenantId: string,
    @Query('agent') agent: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const agentMembershipId = optionalUuid(agent, 'agent');
    if (agentMembershipId === null) throw queryError('agent', 'Choose an agent.');
    return { data: await this.conversations.supervisorWorkload(session, tenantId, agentMembershipId), request_id: request.id };
  }

  /** The Unassigned queue, as projected cards. Never a transcript. */
  @Get('tenants/:tenantId/conversations/unassigned')
  async unassigned(
    @Param('tenantId') tenantId: string,
    @Query('inboxId') inboxId: string | undefined,
    @Query('priority') priority: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('label') label: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const cards = await this.conversations.unassigned(session, tenantId, {
      connectionId: optionalUuid(inboxId, 'inboxId'),
      priority: optionalPriority(priority),
      channel: optionalChannel(channel),
      labelIds: uuidList(label, 'label'),
    });
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

  @Get('tenants/:tenantId/conversations/:conversationId/whatsapp-templates')
  async whatsappTemplates(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, string | undefined>,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const status = query['status'] ?? 'approved';
    if (!['approved', 'pending', 'paused', 'rejected', 'disabled'].includes(status)) {
      throw new ApiHttpError(400, 'invalid_input', 'The template status filter is invalid.');
    }
    const search = (query['search'] ?? '').trim().slice(0, 100);
    const language = (query['language'] ?? '').trim().slice(0, 20);
    const category = (query['category'] ?? '').trim().toLowerCase().slice(0, 40);
    const page = await this.outbound.templates(session, tenantId, conversationId, {
      search, language, category, status, cursor: query['cursor'] ?? null,
    });
    return pageEnvelope(page.items, page.nextCursor, request.id);
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
      conversationId,
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
  @HttpCode(200)
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

  /**
   * Moves a conversation through its lifecycle.
   *
   * One endpoint for five commands rather than five endpoints, because they are
   * one decision: §18.1's table answers all of them, and splitting it across
   * routes would let a future route answer differently. The command is in the
   * body; the version the caller saw is required on every one of them.
   */
  @Post('tenants/:tenantId/conversations/:conversationId/transitions')
  @HttpCode(200)
  async transition(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.lifecycle.command(
        session,
        tenantId,
        conversationId,
        expectedVersion(body),
        lifecycleCommand(body),
      ),
      request_id: request.id,
    };
  }

  /** Restores or removes a selection of archived conversations. */
  @Post('tenants/:tenantId/conversations/archived')
  @HttpCode(200)
  async archived(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const input = archivedBody(body);
    return { data: await this.lifecycle.archived(session, tenantId, input.action, input.conversationIds), request_id: request.id };
  }

  /** The reporting episodes of one conversation, oldest first. */
  @Get('tenants/:tenantId/conversations/:conversationId/episodes')
  async episodes(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.lifecycle.episodes(session, tenantId, conversationId);
    return pageEnvelope(rows, null, request.id);
  }

  /** The private notes on a conversation. Never sent, never on a wire. */
  @Get('tenants/:tenantId/conversations/:conversationId/notes')
  async listNotes(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.notes.list(session, tenantId, conversationId);
    return pageEnvelope(rows, null, request.id);
  }

  @Post('tenants/:tenantId/conversations/:conversationId/notes')
  async addNote(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const note = await this.notes.add(session, tenantId, conversationId, noteBody(body));
    await reply.status(201).send({ data: note, request_id: request.id });
  }

  @Patch('tenants/:tenantId/notes/:noteId')
  async editNote(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.notes.edit(session, tenantId, noteId, noteBody(body)),
      request_id: request.id,
    };
  }

  @Delete('tenants/:tenantId/notes/:noteId')
  async deleteNote(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.notes.remove(session, tenantId, noteId),
      request_id: request.id,
    };
  }

  /* ------------------------------------------------------------ routing -- */

  /**
   * Puts the conversation on a named person's desk, or takes it off every desk.
   *
   * A different operation from `/claim` and a different permission: taking work
   * nobody holds is not the same act as giving somebody else's work away, and
   * business-rules.md §7 grants an Agent the first and denies them the second.
   */
  @Post('tenants/:tenantId/conversations/:conversationId/assignments')
  @HttpCode(200)
  async assign(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.routing.assign(
        session,
        tenantId,
        conversationId,
        expectedVersion(body),
        assignmentCommand(body),
      ),
      request_id: request.id,
    };
  }

  @Post('tenants/:tenantId/conversations/:conversationId/release')
  @HttpCode(200)
  async releaseOwn(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return { data: await this.routing.releaseOwn(session, tenantId, conversationId, expectedVersion(body)), request_id: request.id };
  }

  /**
   * The people who could actually take this conversation.
   *
   * Not `GET /people`: that needs `member.manage` and returns roles, scopes and
   * login emails. A Supervisor may route work and may not administer
   * memberships, so the picker has to answer without any of that.
   */
  @Get('tenants/:tenantId/directory/agents')
  async assignableAgents(
    @Param('tenantId') tenantId: string,
    @Query('conversation_id') conversationId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    if (conversationId === undefined) {
      throw new ApiHttpError(400, 'validation_failed', 'The request is not valid.', [
        {
          field: 'conversation_id',
          code: 'required',
          message: 'Name the conversation the assignee is for.',
        },
      ]);
    }
    const rows = await this.routing.assignableAgents(session, tenantId, conversationId);
    return pageEnvelope(rows, null, request.id);
  }

  /** Offers the conversation to a named colleague, who may decline. */
  @Post('tenants/:tenantId/conversations/:conversationId/handoffs')
  async requestHandoff(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const offer = await this.routing.requestHandoff(session, tenantId, conversationId, {
      expectedVersion: expectedVersion(body),
      toMembershipId: requireText(asObject(body)['toMembershipId'], 'toMembershipId', 64),
      note: optionalText(asObject(body)['note'], 'note', 1000),
      expiresAt: handoffExpiry(body),
    });
    await reply.status(201).send({ data: offer, request_id: request.id });
  }

  @Get('tenants/:tenantId/conversations/:conversationId/handoffs')
  async listHandoffs(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.routing.listHandoffs(session, tenantId, conversationId);
    return pageEnvelope(rows, null, request.id);
  }

  /**
   * Answers or withdraws an offer.
   *
   * One route with the action in the path rather than three services: accept,
   * decline and cancel share every check but the last, and three endpoints
   * would be three places for the fence, the expiry and the identity rule to
   * drift apart.
   */
  @Post('tenants/:tenantId/handoffs/:handoffId/:action')
  @HttpCode(200)
  async settleHandoff(
    @Param('tenantId') tenantId: string,
    @Param('handoffId') handoffId: string,
    @Param('action') action: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new ApiHttpError(404, 'resource_not_found', 'The requested resource does not exist.');
    }
    return {
      data: await this.routing.settleHandoff(session, tenantId, handoffId, action),
      request_id: request.id,
    };
  }

  /**
   * Changes the queue position the conversation argues for.
   *
   * A dedicated route rather than a general `PATCH /conversations/{id}`: a
   * generic patch is an endpoint whose authorization depends on which keys
   * happen to be in the body, and the first field somebody adds to it that
   * needs a different permission is a hole nobody notices.
   */
  @Patch('tenants/:tenantId/conversations/:conversationId/priority')
  async setPriority(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const priority = asObject(body)['priority'];
    if (!isPriority(priority)) {
      throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
        { field: 'priority', code: 'unsupported', message: 'Send low, normal, high or urgent.' },
      ]);
    }
    return {
      data: await this.routing.setPriority(
        session,
        tenantId,
        conversationId,
        expectedVersion(body),
        priority,
        optionalText(asObject(body)['reason'], 'reason', 200),
      ),
      request_id: request.id,
    };
  }

  /** The people invited to help, and whether each of them actually acted. */
  @Get('tenants/:tenantId/conversations/:conversationId/collaborators')
  async collaborators(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const rows = await this.routing.collaborators(session, tenantId, conversationId);
    return pageEnvelope(rows, null, request.id);
  }

  @Post('tenants/:tenantId/conversations/:conversationId/collaborators')
  @HttpCode(200)
  async addCollaborator(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const rows = await this.routing.setCollaborator(
      session,
      tenantId,
      conversationId,
      expectedVersion(body),
      requireText(asObject(body)['membershipId'], 'membershipId', 64),
      true,
    );
    return pageEnvelope(rows, null, request.id);
  }

  /**
   * Ends an invitation.
   *
   * Deliberately not "remove the participant": whatever this person actually
   * did stays on the record and keeps giving them permitted read access to it.
   * What ends is the invitation, and only for the future.
   */
  @Delete('tenants/:tenantId/conversations/:conversationId/collaborators/:membershipId')
  async removeCollaborator(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Param('membershipId') membershipId: string,
    @Query('version') version: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    const rows = await this.routing.setCollaborator(
      session,
      tenantId,
      conversationId,
      expectedVersion({ version: Number(version) }),
      membershipId,
      false,
    );
    return pageEnvelope(rows, null, request.id);
  }

  /**
   * Moves this caller's read cursor.
   *
   * Not a receipt. Nothing here reaches the customer, and nothing here changes
   * the conversation's state: reading a thread is bookkeeping for one person.
   */
  @Post('tenants/:tenantId/conversations/:conversationId/read')
  @HttpCode(200)
  async markRead(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return {
      data: await this.notes.markRead(session, tenantId, conversationId, readThrough(body)),
      request_id: request.id,
    };
  }

  @Post('tenants/:tenantId/conversations/:conversationId/unread')
  @HttpCode(200)
  async markUnread(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Headers('x-csrf-token') csrfHeader: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    this.auth.requireCsrf(session, request.headers.cookie, csrfHeader);
    return { data: await this.notes.markUnread(session, tenantId, conversationId), request_id: request.id };
  }
}

const CHANNELS = ['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalPriority(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (isPriority(value)) return value;
  throw queryError('priority', 'Use low, normal, high or urgent.');
}

function optionalChannel(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (CHANNELS.includes(value)) return value;
  throw queryError('channel', 'Use a supported channel kind.');
}

function optionalUuid(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  if (UUID.test(value)) return value;
  throw queryError(field, 'Use a UUID.');
}

function uuidList(value: string | string[] | undefined, field: string): readonly string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.length > 20 || values.some((entry) => !UUID.test(entry))) {
    throw queryError(field, 'Use at most 20 UUID values.');
  }
  return [...new Set(values)];
}

function queryError(field: string, message: string): ApiHttpError {
  return new ApiHttpError(400, 'validation_failed', 'The query is not valid.', [
    { field, code: 'invalid', message },
  ]);
}

/**
 * The lifecycle command, parsed from the body.
 *
 * Each command validates exactly what it needs and nothing else: a resolve
 * without a disposition is refused because §18.1 says "resolve with required
 * disposition", and a resolution nobody wrote is a report nobody can read.
 */
function lifecycleCommand(body: unknown): LifecycleCommand {
  const input = asObject(body);
  const kind = input['command'];
  if (kind === 'wait') {
    return { kind: 'wait', reason: requireText(input['reason'], 'reason', 500) };
  }
  if (kind === 'snooze') {
    return {
      kind: 'snooze',
      wakeAt: requireInstant(input['wakeAt']),
      timezone: requireText(input['timezone'], 'timezone', 80),
    };
  }
  if (kind === 'resolve') {
    return { kind: 'resolve', resolution: requireText(input['resolution'], 'resolution', 120) };
  }
  if (kind === 'reopen' || kind === 'archive') {
    return { kind };
  }
  throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
    {
      field: 'command',
      code: 'unsupported',
      message: 'Send one of wait, snooze, resolve, reopen or archive.',
    },
  ]);
}

function noteBody(body: unknown): string {
  return requireText(asObject(body)['body'], 'body', 4000);
}

/**
 * The point the caller has read up to.
 *
 * Absent means "now" — the common case is an agent opening a conversation and
 * having seen all of it. An explicit instant exists for the case that is not
 * true, and a caller cannot use it to claim to have read the future.
 */
function readThrough(body: unknown): Date {
  const value = asObject(body)['readThrough'];
  if (value === undefined || value === null) {
    return new Date();
  }
  const at = requireInstant(value);
  const now = new Date();
  return at.getTime() > now.getTime() ? now : at;
}

function requireText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > max) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
      {
        field,
        code: 'invalid',
        message: `Send between 1 and ${max} characters.`,
      },
    ]);
  }
  return text;
}

function requireInstant(value: unknown): Date {
  const at = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
      { field: 'wakeAt', code: 'invalid', message: 'Send an ISO 8601 timestamp.' },
    ]);
  }
  return at;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, field, max);
}

/**
 * The assignee a caller asked for.
 *
 * `null` is a real answer, not a missing one: taking a conversation off every
 * desk is an operation, and expressing it as "assign to nobody" keeps one
 * endpoint and one fence rather than two routes with two ways to race.
 */
function assignmentCommand(body: unknown): AssignmentCommand {
  const value = asObject(body)['assigneeMembershipId'];
  if (value === null) {
    return { kind: 'unassign' };
  }
  return { kind: 'assign', toMembershipId: requireText(value, 'assigneeMembershipId', 64) };
}

/**
 * When an offer stops standing.
 *
 * Absent means the default hour. The bounds themselves are the domain's, so the
 * API and the sweep agree about what "too soon" means.
 */
function handoffExpiry(body: unknown): Date {
  const value = asObject(body)['expiresAt'];
  if (value === undefined || value === null) {
    return new Date(Date.now() + HANDOFF_DEFAULT_TTL_MS);
  }
  const at = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) {
    throw new ApiHttpError(400, 'validation_failed', 'The request body is not valid.', [
      { field: 'expiresAt', code: 'invalid', message: 'Send an ISO 8601 timestamp.' },
    ]);
  }
  return at;
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

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An action on up to 200 archived conversations, each named once. */
function archivedBody(body: unknown): { readonly action: 'restore' | 'delete'; readonly conversationIds: readonly string[] } {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const action = record['action'];
  const ids = record['conversationIds'];
  if ((action !== 'restore' && action !== 'delete') || !Array.isArray(ids) || ids.length < 1 || ids.length > 200 ||
      !ids.every((id) => typeof id === 'string' && CONVERSATION_ID.test(id))) {
    throw new ApiHttpError(400, 'validation_failed', 'Send restore or delete with 1 to 200 conversation ids.');
  }
  return { action, conversationIds: [...new Set(ids as readonly string[])] };
}
