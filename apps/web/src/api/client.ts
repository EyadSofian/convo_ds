/**
 * The HTTP boundary between the browser and the CONVO API.
 *
 * Three decisions shape it:
 *
 * 1. **Failures are values, not exceptions.** Every call returns a discriminated
 *    result. A screen has to decide what to draw for a denial, a conflict and a
 *    dropped connection, and a `try`/`catch` around a render is how those get
 *    collapsed into one apologetic message.
 * 2. **The error envelope is parsed, not guessed.** The API always answers a
 *    failure with `{ error: { code, message, request_id, details } }`, so the
 *    code is available to branch on and the request id is available to quote in
 *    a support conversation.
 * 3. **`fetch` is injected.** Tests drive the real client against the real API
 *    without a browser, and without a global stub that leaks between cases.
 */

export interface ApiErrorDetail {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ApiError {
  /** `network` when the request never produced a response at all. */
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly status: number | null;
  readonly details: readonly ApiErrorDetail[];
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly body?: unknown;
  /** Required by the API on any mutation that would duplicate an effect. */
  readonly idempotencyKey?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Prefix for every path, e.g. `/api/v1`. */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /**
   * Reads the CSRF token the API set as a readable cookie. Injected because a
   * test has no `document`, and because reading it in one place is what stops
   * a mutation being written without it.
   */
  readonly readCsrfToken: () => string | null;
}

/**
 * Where the API lives, relative to the page. The dev server proxies this to the
 * running API (see apps/web/vite.config.ts), and a deployed build is served
 * from the same origin as the API, so a same-origin path is correct in both.
 */
export const API_BASE_URL = '/api/v1';

const CSRF_COOKIE = 'convo_csrf';

/** Reads the CSRF cookie from a `document.cookie` string. */
export function csrfFromCookie(cookie: string): string | null {
  const match = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  if (match === undefined) {
    return null;
  }
  const value = match.slice(CSRF_COOKIE.length + 1);
  return value.length === 0 ? null : value;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    // Every state-changing verb carries CSRF. Deciding that here rather than at
    // each call site is what makes "all browser mutations use CSRF" a property
    // of the client instead of a habit.
    if (method !== 'GET') {
      const token = this.options.readCsrfToken();
      if (token !== null) {
        headers['x-csrf-token'] = token;
      }
    }
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      // The request never reached the server, or the connection died. That is a
      // different situation from a rejection, and the screen says so.
      return {
        ok: false,
        error: {
          code: 'network',
          message: messageOf(cause),
          requestId: null,
          status: null,
          details: [],
        },
      };
    }

    // 204 carries no body by design; reading one would throw.
    if (response.status === 204) {
      return { ok: true, data: undefined as T };
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, error: parseError(payload, response.status) };
    }
    return { ok: true, data: dataOf(payload) as T };
  }

  get<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>('POST', path, options);
  }

  patch<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>('PATCH', path, options);
  }

  delete<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    return this.request<T>('DELETE', path, options);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The request could not be sent.';
}

/**
 * Reads the API's error envelope, and degrades honestly when it is absent.
 *
 * A proxy or a crash can produce a non-JSON body with a real status code. That
 * is still a failure the screen must describe, so the status becomes the code
 * rather than being reported as a success with no data.
 */
function parseError(payload: unknown, status: number): ApiError {
  const envelope = asRecord(asRecord(payload)?.['error']);
  if (envelope === null) {
    return {
      code: `http_${String(status)}`,
      message: 'The server rejected the request.',
      requestId: null,
      status,
      details: [],
    };
  }
  const rawDetails = envelope['details'];
  return {
    code: typeof envelope['code'] === 'string' ? envelope['code'] : `http_${String(status)}`,
    message:
      typeof envelope['message'] === 'string'
        ? envelope['message']
        : 'The server rejected the request.',
    requestId: typeof envelope['request_id'] === 'string' ? envelope['request_id'] : null,
    status,
    details: Array.isArray(rawDetails) ? rawDetails.flatMap(asDetail) : [],
  };
}

function asDetail(value: unknown): ApiErrorDetail[] {
  const record = asRecord(value);
  if (record === null) {
    return [];
  }
  return [
    {
      field: typeof record['field'] === 'string' ? record['field'] : '',
      code: typeof record['code'] === 'string' ? record['code'] : '',
      message: typeof record['message'] === 'string' ? record['message'] : '',
    },
  ];
}

/** Every success envelope carries its payload under `data`. */
function dataOf(payload: unknown): unknown {
  const record = asRecord(payload);
  return record === null ? payload : record['data'];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
