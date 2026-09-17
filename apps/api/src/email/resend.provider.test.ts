import { describe, expect, it } from 'vitest';
import type { EmailMessage } from './email-provider.port.js';
import { ResendEmailProvider } from './resend.provider.js';

/**
 * The Resend adapter, against a scripted `fetch`.
 *
 * The classification is the whole subject. Getting it wrong in one direction
 * retries forever against a key that will never work; getting it wrong in the
 * other abandons a real message because the provider had a bad ten seconds.
 */

const MESSAGE: EmailMessage = {
  to: 'nadia@digital-school.example',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
  idempotencyKey: 'delivery-id-0001',
};

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function provider(responder: () => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Promise.resolve(responder());
  }) as unknown as typeof fetch;
  return {
    calls,
    adapter: new ResendEmailProvider({
      apiKey: 're_test_key_0123456789',
      from: 'Digital School <ops@digital-school.example>',
      fetchImpl,
    }),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('a successful send', () => {
  it('reports the provider message id', async () => {
    const { adapter } = provider(() => json(200, { id: 'msg_abc' }));
    expect(await adapter.send(MESSAGE)).toEqual({
      status: 'accepted',
      providerMessageId: 'msg_abc',
    });
  });

  it('sends the configured sender, the recipient and both bodies', async () => {
    const { adapter, calls } = provider(() => json(200, { id: 'msg_abc' }));
    await adapter.send(MESSAGE);
    expect(calls[0]?.body).toEqual({
      from: 'Digital School <ops@digital-school.example>',
      to: ['nadia@digital-school.example'],
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
    });
  });

  it('presents the delivery id as the provider idempotency key', async () => {
    const { adapter, calls } = provider(() => json(200, { id: 'msg_abc' }));
    await adapter.send(MESSAGE);
    expect(calls[0]?.headers['idempotency-key']).toBe('delivery-id-0001');
    expect(calls[0]?.headers['authorization']).toBe('Bearer re_test_key_0123456789');
  });

  it('treats a 2xx with no id as unknown rather than as sent', async () => {
    // `sent` in this product means "we hold the provider's id for it". A
    // success we cannot evidence is not one.
    const { adapter } = provider(() => json(200, {}));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'unknown',
      code: 'provider_response_unusable',
    });
  });
});

describe('failures that waiting can fix', () => {
  it('retries a rate limit', async () => {
    const { adapter } = provider(() => json(429, { message: 'Too many requests' }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('retries a provider outage', async () => {
    const { adapter } = provider(() => json(503, { message: 'Service unavailable' }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it('reports an unreachable provider as unknown, not as refused', async () => {
    const { adapter } = provider(() => {
      throw new TypeError('fetch failed');
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'unknown',
      code: 'provider_unreachable',
    });
  });

  it('reports a timeout as unknown', async () => {
    const { adapter } = provider(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'unknown',
      code: 'provider_timeout',
    });
  });
});

describe('failures that need a person', () => {
  it('does not retry a rejected API key', async () => {
    const { adapter } = provider(() => json(401, { message: 'API key is invalid' }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'provider_credentials_rejected',
      retryable: false,
    });
  });

  it('does not retry an unverified sending domain', async () => {
    const { adapter } = provider(() =>
      json(403, { name: 'validation_error', message: 'The domain is not verified' }),
    );
    expect(await adapter.send(MESSAGE)).toMatchObject({
      code: 'provider_credentials_rejected',
      retryable: false,
    });
  });

  it('names the validation problem so an operator can act on it', async () => {
    const { adapter } = provider(() =>
      json(422, { name: 'missing_required_field', message: 'from is required' }),
    );
    expect(await adapter.send(MESSAGE)).toMatchObject({
      code: 'invalid_request:missing_required_field',
      retryable: false,
    });
  });

  it('survives an error body that is not JSON at all', async () => {
    const { adapter } = provider(() => new Response('<html>502</html>', { status: 502 }));
    expect(await adapter.send(MESSAGE)).toMatchObject({
      status: 'refused',
      code: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('what an error message is allowed to carry', () => {
  it('redacts any address the provider echoed back', async () => {
    const { adapter } = provider(() =>
      json(422, { message: 'nadia@digital-school.example is not a valid recipient' }),
    );
    const outcome = await adapter.send(MESSAGE);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.message).not.toContain('nadia@digital-school.example');
    expect(outcome.message).toContain('n***@digital-school.example');
  });

  it('never repeats the API key, even when the provider quotes it back', async () => {
    // An authentication error routinely echoes the credential it rejected. That
    // string becomes `last_error_message`, which an operator reads and a log
    // may carry, so the key is removed before it can get there.
    const { adapter } = provider(() => json(401, { message: 'key re_test_key_0123456789 invalid' }));
    const outcome = await adapter.send(MESSAGE);
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.message).not.toContain('re_test_key_0123456789');
    expect(outcome.message).toBe('key [redacted] invalid');
  });
});
