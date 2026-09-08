import { Body, Controller, Inject, Get, Headers, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InstanceService, responseRequestId } from './instance.service.js';

@Controller('instance')
export class InstanceController {
  constructor(@Inject(InstanceService) private readonly service: InstanceService) {}

  @Get()
  describe() {
    return this.service.describe();
  }

  @Post('bootstrap')
  async bootstrap(
    @Body() body: unknown,
    @Headers('x-bootstrap-token') bootstrapToken: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.service.bootstrap(body, bootstrapToken, idempotencyKey, request.id);
    reply.header('x-request-id', responseRequestId(response));
    await reply.status(response.statusCode).send(response.body);
  }
}
