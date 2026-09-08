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

export function sessionCookieHeaders(
  tokens: AuthTokens,
  secure: boolean,
  ttlSeconds: number,
): readonly string[] {
  const attributes = cookieAttributes(secure, ttlSeconds);
  return [
    SESSION_COOKIE + '=' + tokens.session + '; HttpOnly; ' + attributes,
    CSRF_COOKIE + '=' + tokens.csrf + '; ' + attributes,
  ];
}

export function clearedSessionCookieHeaders(secure: boolean): readonly string[] {
  const attributes = cookieAttributes(secure, 0);
  return [
    SESSION_COOKIE + '=; HttpOnly; ' + attributes,
    CSRF_COOKIE + '=; ' + attributes,
  ];
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function cookieAttributes(secure: boolean, maxAge: number): string {
  return (
    'Path=/api/v1; SameSite=Strict; Max-Age=' +
    maxAge +
    (secure ? '; Secure' : '')
  );
}
