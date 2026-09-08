import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { requestIdFor } from './request-id.js';

function request(value: string | string[] | undefined): IncomingMessage {
  return { headers: { 'x-request-id': value } } as unknown as IncomingMessage;
}

describe('requestIdFor', () => {
  it('preserves a safe caller request id', () => {
    expect(requestIdFor(request('client.req-1:retry'))).toBe('client.req-1:retry');
  });

  it.each([undefined, ['one', 'two'], ' has-space', 'a'.repeat(129)])(
    'generates a UUID for an unsafe header: %j',
    (value) => {
      expect(requestIdFor(request(value))).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );
});
