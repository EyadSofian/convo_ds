import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiErrorFilter } from './error.filter.js';
import { ApiHttpError } from './http-error.js';

function harness() {
  const send = vi.fn();
  const reply = {
    header: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send,
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'request-123' }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply, send };
}

describe('ApiErrorFilter', () => {
  it.each([
    [
      new ApiHttpError(409, 'known_conflict', 'Known conflict.', [
        { field: 'key', code: 'used', message: 'Used.' },
      ]),
      409,
      'known_conflict',
      'Known conflict.',
    ],
    [new BadRequestException(), 400, 'invalid_request', 'The request could not be parsed.'],
    [new NotFoundException(), 404, 'route_not_found', 'The requested route does not exist.'],
    [new ForbiddenException(), 403, 'http_error', 'The request failed.'],
    [new Error('database password leaked'), 500, 'internal_error', 'The server could not complete the request.'],
  ] as const)('maps every failure to the nested safe envelope', (error, status, code, message) => {
    const { host, reply, send } = harness();
    new ApiErrorFilter().catch(error, host);
    expect(reply.header).toHaveBeenCalledWith('x-request-id', 'request-123');
    expect(reply.status).toHaveBeenCalledWith(status);
    expect(send).toHaveBeenCalledWith({
      error: {
        code,
        message,
        request_id: 'request-123',
        details: error instanceof ApiHttpError ? error.details : [],
      },
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('database password leaked');
  });

  it('forwards safe protocol headers from typed errors', () => {
    const { host, reply } = harness();
    new ApiErrorFilter().catch(
      new ApiHttpError(429, 'rate_limited', 'Try later.', [], { 'retry-after': '60' }),
      host,
    );
    expect(reply.header).toHaveBeenCalledWith('retry-after', '60');
  });
});
