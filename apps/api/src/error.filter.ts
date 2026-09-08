import {
  BadRequestException,
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { errorEnvelope } from '@convo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiHttpError } from './http-error.js';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const mapped = mapError(error);
    reply.header('x-request-id', request.id);
    for (const [name, value] of Object.entries(mapped.headers)) {
      reply.header(name, value);
    }
    void reply.status(mapped.statusCode).send({
      error: errorEnvelope(mapped.code, mapped.message, {
        requestId: request.id,
        details: mapped.details,
      }),
    });
  }
}

interface MappedError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly details: ApiHttpError['details'];
  readonly headers: Readonly<Record<string, string>>;
}

function mapError(error: unknown): MappedError {
  if (error instanceof ApiHttpError) {
    return {
      statusCode: error.getStatus(),
      code: error.code,
      message: error.safeMessage,
      details: error.details,
      headers: error.headers,
    };
  }
  if (error instanceof BadRequestException) {
    return {
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request could not be parsed.',
      details: [],
      headers: {},
    };
  }
  if (error instanceof HttpException) {
    const statusCode = error.getStatus();
    return {
      statusCode,
      code: statusCode === 404 ? 'route_not_found' : 'http_error',
      message: statusCode === 404 ? 'The requested route does not exist.' : 'The request failed.',
      details: [],
      headers: {},
    };
  }
  return {
    statusCode: 500,
    code: 'internal_error',
    message: 'The server could not complete the request.',
    details: [],
    headers: {},
  };
}
