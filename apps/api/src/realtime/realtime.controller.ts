import { Controller, Get, Headers, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { ApiHttpError } from '../http-error.js';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { RealtimeService } from './realtime.service.js';
import type { FeedPage } from './realtime.service.js';
import { encodeCursor } from '@convo/domain';

/**
 * The subscription surface.
 *
 * **Server-Sent Events, not WebSocket.** The traffic is one-directional — the
 * server tells the browser what happened — and SSE gets three things for free
 * that a socket would have to reimplement: the session cookie authenticates the
 * connection like any other request, `Last-Event-ID` makes reconnect resume
 * from a cursor without a bespoke handshake, and a proxy that speaks HTTP
 * speaks this. Commands travel the other way as ordinary authenticated `POST`s,
 * where idempotency and CSRF already live.
 *
 * **The tenant comes from the path and the membership, never from a payload.**
 * A subscriber cannot ask for another company's feed by naming it: the
 * principal is loaded inside that company's RLS context, and a caller with no
 * membership there gets the same 404 as for a company that does not exist.
 *
 * **A connection is bounded.** It closes on its own after `maxStreamMs` and the
 * client reconnects with its cursor. An unbounded stream accumulates until
 * something else fails; a bounded one makes reconnect the normal path, which is
 * also the path that must work after a deploy.
 */
@Controller()
export class RealtimeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Catch-up: one page, as ordinary JSON.
   *
   * The same decision path as the stream, and deliberately so — a client that
   * has been offline uses this and then subscribes, and the two must not
   * disagree about what it may see.
   */
  @Get('tenants/:tenantId/realtime/events')
  async events(
    @Param('tenantId') tenantId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const session = await this.auth.authenticate(request.headers.cookie);
    const page = await this.realtime.page(
      session,
      tenantId,
      cursorOf(cursor, undefined),
      this.config.realtime.maxBatch,
      this.config.realtime.maxBacklog,
    );
    return { data: bodyOf(page), request_id: request.id };
  }

  /**
   * The live stream.
   *
   * Each pass re-reads the principal, so a membership revoked while the stream
   * is open stops it on the next poll rather than at the next login. The frames
   * are ordinary SSE: `id` carries the cursor, `event` carries the type, and a
   * comment line is the heartbeat.
   */
  @Get('tenants/:tenantId/realtime/stream')
  async stream(
    @Param('tenantId') tenantId: string,
    @Query('cursor') cursor: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.authenticate(request.headers.cookie);
    const tuning = this.config.realtime;
    // `Last-Event-ID` is the browser's own reconnect header and wins over the
    // query parameter, because it is what EventSource resends automatically.
    let position = cursorOf(cursor, lastEventId);

    // The first page happens *before* any bytes are written, so an unauthorized
    // subscription is a 401 or a 404 like every other request rather than a 200
    // stream that closes immediately. A client cannot tell those apart, and a
    // monitor certainly cannot.
    let page = await this.realtime.page(
      session,
      tenantId,
      position,
      tuning.maxBatch,
      tuning.maxBacklog,
    );

    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // A buffering proxy turns a stream into a very slow request. These say
      // "do not", to both the standard cache layer and nginx.
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    // Reconnect delay floor. The client adds its own jitter; a fleet that all
    // reconnects on the same tick is how one restart becomes an outage.
    raw.write(`retry: ${String(tuning.pollMs * 4)}\n\n`);

    let open = true;
    const close = (): void => {
      open = false;
    };
    request.raw.on('close', close);
    request.raw.on('error', close);

    const deadline = Date.now() + tuning.maxStreamMs;
    let lastFrameAt = Date.now();
    // Where a client should resume from. Always a real cursor after the first
    // page, which is why the closing frames never have to invent one.
    let resume = page.cursor;

    try {
      for (;;) {
        if (page.status === 'reset_required') {
          raw.write(frame('reset_required', page.cursor, { reason: page.reason }));
          break;
        }
        for (const event of page.events) {
          // A page can contain several events. Advancing the browser's
          // Last-Event-ID to the page end on its first frame would skip the
          // remaining frames if the connection broke mid-write.
          const eventCursor = encodeCursor({ tenantId, seq: event.seq, authority: page.authority });
          raw.write(
            frame(event.type, frameId(eventCursor), {
              ...event,
              // Repeated in the data as well as the frame id: a consumer that
              // stores events keeps the cursor with them, and the frame id is
              // gone by then.
              cursor: eventCursor,
            }),
          );
          lastFrameAt = Date.now();
        }
        position = page.cursor;
        resume = page.cursor;
        if (page.events.length === 0 && Date.now() - lastFrameAt >= tuning.heartbeatMs) {
          // A comment frame: it keeps proxies and load balancers from closing an
          // idle connection, and it is invisible to `EventSource`.
          raw.write(': keep-alive\n\n');
          lastFrameAt = Date.now();
        }
        if (!open || Date.now() >= deadline) {
          break;
        }
        if (page.backlog === 0) {
          await sleep(tuning.pollMs);
        }
        try {
          page = await this.realtime.page(
            session,
            tenantId,
            position,
            tuning.maxBatch,
            tuning.maxBacklog,
          );
        } catch (error) {
          // The headers are long gone, so this cannot become a status code. It
          // becomes a final frame instead, which is more useful anyway: the
          // client learns whether to log in again or simply reconnect.
          raw.write(frame('stream_closed', resume, { reason: closureOf(error) }));
          return;
        }
      }
      if (open && Date.now() >= deadline) {
        // Said out loud rather than dropped, so a client can tell a planned
        // cycle from a network failure.
        raw.write(frame('stream_cycled', resume, { reason: 'max_stream_age' }));
      }
    } finally {
      request.raw.off('close', close);
      request.raw.off('error', close);
      raw.end();
    }
  }
}

/**
 * Why a live stream stopped.
 *
 * A membership revoked mid-stream reads as `access_revoked`, which tells the
 * client to stop reconnecting. Anything else is `server_error`: reconnecting is
 * the right response to that, and calling a database blip a revocation would
 * log people out of a working session.
 */
function closureOf(error: unknown): string {
  // `page` refuses a caller whose membership is gone with the same 404 a
  // stranger gets. Anything else — a database that went away, a bug — is a
  // server problem, and reconnecting is the right response to it.
  return error instanceof ApiHttpError && error.getStatus() === 404
    ? 'access_revoked'
    : 'server_error';
}

/** The response body for a page, in the same shape for both outcomes. */
function bodyOf(page: FeedPage): Record<string, unknown> {
  if (page.status === 'reset_required') {
    return { status: page.status, reason: page.reason, cursor: page.cursor, events: [] };
  }
  return {
    status: page.status,
    events: page.events,
    cursor: page.cursor,
    backlog: page.backlog,
  };
}

function frame(event: string, id: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The frame id.
 *
 * `EventSource` sends the last id back as `Last-Event-ID` on reconnect, so the
 * id has to *be* the cursor. Newlines would end the field, so an id that
 * somehow contained one is refused rather than truncated — base64url never
 * does, and this is what keeps that true if the encoding ever changes.
 */
function frameId(cursor: string): string {
  return cursor.replace(/[\r\n]/g, '');
}

function cursorOf(query: string | undefined, header: string | undefined): string | null {
  const value = header ?? query;
  return value === undefined || value === '' ? null : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
