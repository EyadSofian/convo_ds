import { Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChannelIngressService } from './ingress.service.js';
import { rawBodyOf } from './raw-body.js';

/**
 * The webhook ingress routes.
 *
 * Deliberately outside every other guard in this application: there is no
 * session, no CSRF and no membership, because the caller is a provider and the
 * only thing that authenticates it is the signature over the raw bytes. Adding
 * a session check here would not make it safer; it would make it impossible.
 *
 * The response codes carry meaning to the provider, which retries on non-2xx:
 *
 * - **200** — journaled durably. The only thing an ACK promises (ADR-0005).
 * - **202** — verified, understood, and nothing here to route. Retrying will not
 *   change that, so it is not a failure.
 * - **401** — the signature did not verify. Not our problem to retry.
 * - **400** — verified sender, unparsable body. Retrying the same bytes cannot
 *   help.
 * - **503** — *our* configuration is missing. Retry, please.
 */
@Controller()
export class ChannelIngressController {
  constructor(@Inject(ChannelIngressService) private readonly ingress: ChannelIngressService) {}

  @Get('webhooks/meta/:appConnectionId')
  async challenge(
    @Param('appConnectionId') appConnectionId: string,
    @Query() query: Record<string, string | undefined>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const answer = await this.ingress.challenge(appConnectionId, query);
    // Echoed verbatim as text, which is what the provider expects. It is the
    // provider's own value coming straight back, so there is nothing of ours
    // in it to leak.
    await reply.status(200).type('text/plain').send(answer);
  }

  @Post('webhooks/meta/:appConnectionId')
  async receive(
    @Param('appConnectionId') appConnectionId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const outcome = await this.ingress.receive({
      routeKey: appConnectionId,
      rawBody: rawBodyOf(request),
      headers: request.headers as Record<string, string | undefined>,
      receivedAt: new Date(),
    });

    if (outcome.status === 'rejected') {
      await reply
        .status(outcome.httpStatus)
        .send({ status: 'rejected', reason: outcome.code, request_id: request.id });
      return;
    }
    // The counts are returned because they are the operator's evidence that
    // redelivery is happening and being absorbed rather than duplicated.
    await reply.status(200).send({
      status: 'received',
      receipt_id: outcome.receiptId,
      stored: outcome.stored,
      duplicates: outcome.duplicates,
      request_id: request.id,
    });
  }
}
