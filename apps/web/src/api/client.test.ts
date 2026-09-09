import { describe, expect, it } from 'vitest';
import { ApiClient, csrfFromCookie } from './client.js';
import type { FetchLike } from './client.js';

/**
 * The HTTP boundary, at the edges.
 *
 * The happy paths are exercised end to end in `live/live.test.ts` against the
 * real screens. What is worth asserting directly is what the client does with
 * answers a server should not send but might: a page envelope with no page, a
 * body that is not an object, a cursor that is not a string. Every one of those
 * has to become an ordinary empty page rather than a crash halfway through a
 * render.
 */

function clientFor(reply: { status: number; body: unknown }): ApiClient {
  const fetch: FetchLike = () =>
    Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  return new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => null });
}

describe('reading a page', () => {
  it('returns the rows and the cursor', async () => {
    const client = clientFor({
      status: 200,
      body: { data: [{ id: 'a' }], page: { next_cursor: 'c1', has_more: true } },
    });
    const result = await client.page<{ id: string }>('/things');
    expect(result).toEqual({
      ok: true,
      data: { data: [{ id: 'a' }], nextCursor: 'c1', hasMore: true },
    });
  });

  it('reads a page with nothing after it', async () => {
    const client = clientFor({
      status: 200,
      body: { data: [], page: { next_cursor: null, has_more: false } },
    });
    const result = await client.page<unknown>('/things');
    expect(result.ok && result.data).toEqual({ data: [], nextCursor: null, hasMore: false });
  });

  it('answers an envelope with no page as one page of rows', async () => {
    const client = clientFor({ status: 200, body: { data: [{ id: 'a' }] } });
    const result = await client.page<{ id: string }>('/things');
    // No cursor is not an error: it means there is nothing after this.
    expect(result.ok && result.data).toEqual({
      data: [{ id: 'a' }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('answers a body that is not an envelope as an empty page', async () => {
    for (const body of [null, ['not', 'an', 'envelope'], { data: 'not an array' }]) {
      const result = await clientFor({ status: 200, body }).page<unknown>('/things');
      // A screen rendering `[]` is recoverable; one crashing mid-render is not.
      expect(result.ok && result.data.data).toEqual([]);
    }
  });

  it('passes a failure through unchanged', async () => {
    const client = clientFor({
      status: 403,
      body: { error: { code: 'permission_denied', message: 'No.', request_id: 'r1' } },
    });
    const result = await client.page<unknown>('/things');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ code: 'permission_denied', status: 403 });
  });
});

describe('describing a failure', () => {
  async function failWith(status: number, body: unknown): Promise<{ code: string; message: string; details: readonly { field: string }[] }> {
    const result = await clientFor({ status, body }).get<unknown>('/things');
    if (result.ok) throw new Error('expected a failure');
    return result.error;
  }

  it('uses the status when the body carries no error envelope', async () => {
    // A proxy or a crash can answer a real status code with something that is
    // not our envelope. That is still a failure a screen must describe.
    const error = await failWith(502, { unexpected: true });
    expect(error).toMatchObject({ code: 'http_502', status: 502 });
    expect(error.message).toBe('The server rejected the request.');
  });

  it('falls back for an envelope whose fields are the wrong type', async () => {
    const error = await failWith(400, { error: { code: 7, message: null, request_id: 9 } });
    expect(error).toMatchObject({ code: 'http_400', message: 'The server rejected the request.' });
  });

  it('reads details, and survives ones that are not objects', async () => {
    const error = await failWith(400, {
      error: {
        code: 'validation_failed',
        message: 'No.',
        details: [{ field: 'email', code: 'required', message: 'Give an email.' }, 'nonsense', null],
      },
    });
    expect(error.details).toEqual([
      { field: 'email', code: 'required', message: 'Give an email.' },
    ]);
  });

  it('fills in a detail whose fields are missing', async () => {
    const error = await failWith(400, { error: { code: 'x', message: 'y', details: [{}] } });
    expect(error.details).toEqual([{ field: '', code: '', message: '' }]);
  });

  it('reports a request that never reached the server as a network failure', async () => {
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetch: () => Promise.reject(new Error('connection refused')),
      readCsrfToken: () => null,
    });
    const result = await client.get<unknown>('/things');
    expect(result.ok).toBe(false);
    // A different situation from a rejection, and the screen says so.
    expect(!result.ok && result.error).toMatchObject({
      code: 'network',
      message: 'connection refused',
      status: null,
    });
  });

  it('describes a rejection that is not an Error at all', async () => {
    const client = new ApiClient({
      baseUrl: '/api/v1',
      // A rejection that is not an `Error` — exactly the case under test.
      fetch: () => Promise.reject(new (class {})() as unknown as Error),
      readCsrfToken: () => null,
    });
    const result = await client.get<unknown>('/things');
    expect(!result.ok && result.error.message).toBe('The request could not be sent.');
  });

  it('passes an abort signal through to the transport', async () => {
    const seen: RequestInit[] = [];
    const client = new ApiClient({
      baseUrl: '/api/v1',
      fetch: (_url, init) => {
        seen.push(init);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      readCsrfToken: () => null,
    });
    const controller = new AbortController();
    await client.request('GET', '/things', { signal: controller.signal });
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe('the CSRF cookie', () => {
  it('finds the token among other cookies, and reports its absence', () => {
    expect(csrfFromCookie('a=1; convo_csrf=token-value; b=2')).toBe('token-value');
    expect(csrfFromCookie('a=1; b=2')).toBeNull();
    // Present but empty is not a token; sending an empty header would fail the
    // check in a way that reads like a bug rather than a missing cookie.
    expect(csrfFromCookie('convo_csrf=')).toBeNull();
  });
});
