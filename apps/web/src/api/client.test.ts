import { describe, expect, it } from 'vitest';
import type { FetchLike } from './client.js';
import { ApiClient, csrfFromCookie } from './client.js';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(
  responder: (call: Recorded) => Response | Promise<Response> | Promise<never>,
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  responder: (call: Recorded) => Response | Promise<Response> | Promise<never>,
  csrf: string | null = 'csrf-token',
): { client: ApiClient; calls: Recorded[] } {
  const { fetch, calls } = stub(responder);
  return {
    client: new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => csrf }),
    calls,
  };
}

describe('csrfFromCookie', () => {
  it('finds the token among other cookies', () => {
    expect(csrfFromCookie('a=1; convo_csrf=abc123; b=2')).toBe('abc123');
    expect(csrfFromCookie('convo_csrf=abc123')).toBe('abc123');
  });

  it('reports absence rather than an empty string', () => {
    expect(csrfFromCookie('')).toBeNull();
    expect(csrfFromCookie('a=1; b=2')).toBeNull();
    expect(csrfFromCookie('convo_csrf=')).toBeNull();
  });
});

describe('ApiClient', () => {
  it('unwraps the success envelope', async () => {
    const { client } = clientWith(() => json({ data: [{ id: 'a' }], request_id: 'r-1' }));
    const result = await client.get<readonly { id: string }[]>('/things');
    expect(result).toEqual({ ok: true, data: [{ id: 'a' }] });
  });

  it('returns a body with no envelope as it stands', async () => {
    const { client } = clientWith(() => json([1, 2, 3]));
    const result = await client.get<readonly number[]>('/things');
    expect(result).toEqual({ ok: true, data: [1, 2, 3] });
  });

  it('treats 204 as success with no body, without trying to parse one', async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    const result = await client.delete('/things/1');
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('sends CSRF on every mutation and on no read', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }));
    await client.get('/things');
    await client.post('/things', { body: { a: 1 } });
    await client.patch('/things/1', { body: { a: 1 } });
    await client.delete('/things/1');

    const header = (index: number): unknown =>
      (calls[index]?.init.headers as Record<string, string>)['x-csrf-token'];
    expect(header(0)).toBeUndefined();
    expect(header(1)).toBe('csrf-token');
    expect(header(2)).toBe('csrf-token');
    expect(header(3)).toBe('csrf-token');
  });

  it('omits the CSRF header when there is no cookie to read', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }), null);
    await client.post('/things', { body: {} });
    expect((calls[0]?.init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('sends an idempotency key only when one is given', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }));
    await client.post('/things', { body: {}, idempotencyKey: 'key-1' });
    await client.post('/things', { body: {} });
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
    expect((calls[1]?.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });

  it('serialises a body and declares its type, and sends neither without one', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }));
    await client.post('/things', { body: { a: 1 } });
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );

    await client.post('/things');
    expect(calls[1]?.init.body).toBeUndefined();
    expect((calls[1]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('passes an abort signal through', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }));
    const controller = new AbortController();
    await client.get('/things', { signal: controller.signal });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('parses the error envelope, keeping the code, request id and details', async () => {
    const { client } = clientWith(() =>
      json(
        {
          error: {
            code: 'delegation_ceiling',
            message: 'You cannot grant access wider than your own.',
            request_id: 'r-9',
            details: [{ field: 'tenant.delete', code: 'not_held', message: 'Exceeds your access.' }],
          },
        },
        403,
      ),
    );
    const result = await client.post('/roles', { body: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toEqual({
      code: 'delegation_ceiling',
      message: 'You cannot grant access wider than your own.',
      requestId: 'r-9',
      status: 403,
      details: [{ field: 'tenant.delete', code: 'not_held', message: 'Exceeds your access.' }],
    });
  });

  it('degrades honestly when a failure carries no envelope', async () => {
    // A proxy or a crash can answer with a real status and no JSON. That is
    // still a failure the screen has to describe, not a success with no data.
    const { client } = clientWith(() => new Response('<html>502</html>', { status: 502 }));
    const result = await client.get('/things');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('http_502');
    expect(result.error.status).toBe(502);
    expect(result.error.details).toEqual([]);
  });

  it('fills in missing envelope fields rather than trusting them', async () => {
    const { client } = clientWith(() => json({ error: { details: ['not-an-object', {}] } }, 400));
    const result = await client.get('/things');
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('http_400');
    expect(result.error.message).toBe('The server rejected the request.');
    expect(result.error.requestId).toBeNull();
    // A detail that is not an object is dropped; one with missing fields is
    // kept with empty strings, so the screen can still render the row.
    expect(result.error.details).toEqual([{ field: '', code: '', message: '' }]);
  });

  it('reports a dropped connection as a network failure, not a rejection', async () => {
    const { client } = clientWith(() => Promise.reject(new Error('connection refused')));
    const result = await client.get('/things');
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('network');
    expect(result.error.message).toBe('connection refused');
    expect(result.error.status).toBeNull();
  });

  it('describes a non-Error transport failure without leaking its shape', async () => {
    const { client } = clientWith(() => Promise.reject('nope' as unknown as Error));
    const result = await client.get('/things');
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toBe('The request could not be sent.');
  });

  it('prefixes every path with the base url and sends cookies', async () => {
    const { client, calls } = clientWith(() => json({ data: {} }));
    await client.get('/tenants/t1/people');
    expect(calls[0]?.url).toBe('/api/v1/tenants/t1/people');
    expect(calls[0]?.init.credentials).toBe('same-origin');
  });
});
