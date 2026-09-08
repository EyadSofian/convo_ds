import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requestIdFor(request: IncomingMessage): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}
