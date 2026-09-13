import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'convo_session';
export const CSRF_COOKIE = 'convo_csrf';

export interface AuthTokens {
  readonly session: string;
  readonly csrf: string;
}

export function issueAuthTokens(): AuthTokens {
  return { session: randomToken(), csrf: randomToken() };
}

export function tokenFingerprint(secret: string, purpose: string, token: string): string {
  return createHmac('sha256', secret).update(purpose).update('\0').update(token).digest('hex');
}

export function tokenMatches(
  expectedFingerprint: string,
  secret: string,
  purpose: string,
  candidate: string | string[] | undefined,
): boolean {
  if (typeof candidate !== 'string' || candidate.length < 32 || candidate.length > 256) {
    return false;
  }
  const expected = Buffer.from(expectedFingerprint, 'hex');
  const actual = Buffer.from(tokenFingerprint(secret, purpose, candidate), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] !== '' ? values[0] : undefined;
}

/**
 * Where each cookie lives.
 *
 * The session cookie is HttpOnly and only ever needed by the API, so it stays
 * on the API path. The CSRF cookie exists to be read by the page and echoed in
 * `x-csrf-token` (double submit), so it must be visible to `document.cookie` on
 * the app's own pages at `/`. On `/api/v1` the page could never read it, and
 * every browser mutation was refused as `csrf_invalid`.
 */
const SESSION_COOKIE_PATH = '/api/v1';
const CSRF_COOKIE_PATH = '/';
/** Where the CSRF cookie used to be set. Browsers may still hold one there. */
const LEGACY_CSRF_COOKIE_PATH = '/api/v1';

/**
 * The cookies a new session sets.
 *
 * `clearLegacyCsrf` expires a CSRF cookie left on the old path. Two cookies of
 * the same name on different paths are both sent to the API, and `readCookie`
 * refuses an ambiguous value, so a browser holding the old one would fail every
 * CSRF check until it expired.
 */
export function sessionCookieHeaders(
  tokens: AuthTokens,
  secure: boolean,
  ttlSeconds: number,
  clearLegacyCsrf = false,
): readonly string[] {
  return [
    SESSION_COOKIE + '=' + tokens.session + '; HttpOnly; ' + cookieAttributes(SESSION_COOKIE_PATH, secure, ttlSeconds),
    CSRF_COOKIE + '=' + tokens.csrf + '; ' + cookieAttributes(CSRF_COOKIE_PATH, secure, ttlSeconds),
    ...(clearLegacyCsrf ? [CSRF_COOKIE + '=; ' + cookieAttributes(LEGACY_CSRF_COOKIE_PATH, secure, 0)] : []),
  ];
}

/** Expires every cookie a session may have left, on every path it may be on. */
export function clearedSessionCookieHeaders(secure: boolean): readonly string[] {
  return [
    SESSION_COOKIE + '=; HttpOnly; ' + cookieAttributes(SESSION_COOKIE_PATH, secure, 0),
    CSRF_COOKIE + '=; ' + cookieAttributes(CSRF_COOKIE_PATH, secure, 0),
    CSRF_COOKIE + '=; ' + cookieAttributes(LEGACY_CSRF_COOKIE_PATH, secure, 0),
  ];
}

/** Whether a Cookie header carries `name` at all, even ambiguously or empty. */
export function hasCookie(header: string | undefined, name: string): boolean {
  return (header ?? '').split(';').some((part) => part.trim().startsWith(name + '='));
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function cookieAttributes(path: string, secure: boolean, maxAge: number): string {
  return (
    'Path=' + path + '; SameSite=Strict; Max-Age=' +
    maxAge +
    (secure ? '; Secure' : '')
  );
}
