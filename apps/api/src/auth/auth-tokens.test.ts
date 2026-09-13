import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearedSessionCookieHeaders,
  hasCookie,
  issueAuthTokens,
  readCookie,
  sessionCookieHeaders,
  tokenFingerprint,
  tokenMatches,
} from './auth-tokens.js';

const SECRET = 'auth-token-test-secret-value-00000001';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE';

describe('auth tokens', () => {
  it('issues independent 256-bit bearer and CSRF values', () => {
    const first = issueAuthTokens();
    const second = issueAuthTokens();
    expect(first.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([first.session, first.csrf, second.session, second.csrf]).size).toBe(4);
  });

  it('binds fingerprints to the secret, purpose and exact token', () => {
    const expected = tokenFingerprint(SECRET, 'session', TOKEN);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches(expected, SECRET, 'session', TOKEN)).toBe(true);
    expect(tokenMatches(expected, SECRET, 'csrf', TOKEN)).toBe(false);
    expect(tokenMatches(expected, SECRET + 'x', 'session', TOKEN)).toBe(false);
    expect(tokenMatches(expected, SECRET, 'session', TOKEN + 'x')).toBe(false);
  });

  it.each([undefined, ['repeated'], 'short', 'x'.repeat(257)])(
    'rejects malformed candidate %j',
    (candidate) => {
      expect(tokenMatches('not-hex', SECRET, 'session', candidate)).toBe(false);
    },
  );

  it('reads exactly one named non-empty cookie', () => {
    expect(readCookie('a=1; ' + SESSION_COOKIE + '=' + TOKEN + '; z=2', SESSION_COOKIE)).toBe(
      TOKEN,
    );
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(SESSION_COOKIE + '=', SESSION_COOKIE)).toBeUndefined();
    expect(
      readCookie(SESSION_COOKIE + '=' + TOKEN + '; ' + SESSION_COOKIE + '=second', SESSION_COOKIE),
    ).toBeUndefined();
  });

  it('serializes hardened production cookies and explicit deletion cookies', () => {
    const set = sessionCookieHeaders({ session: TOKEN, csrf: TOKEN }, true, 3600);
    expect(set).toEqual([
      SESSION_COOKIE + '=' + TOKEN + '; HttpOnly; Path=/api/v1; SameSite=Strict; Max-Age=3600; Secure',
      // Readable by the app's pages at `/`: the page echoes it as x-csrf-token.
      CSRF_COOKIE + '=' + TOKEN + '; Path=/; SameSite=Strict; Max-Age=3600; Secure',
    ]);
    expect(clearedSessionCookieHeaders(false)).toEqual([
      SESSION_COOKIE + '=; HttpOnly; Path=/api/v1; SameSite=Strict; Max-Age=0',
      CSRF_COOKIE + '=; Path=/; SameSite=Strict; Max-Age=0',
      CSRF_COOKIE + '=; Path=/api/v1; SameSite=Strict; Max-Age=0',
    ]);
  });

  it('expires a CSRF cookie left on the old API path when asked', () => {
    expect(sessionCookieHeaders({ session: TOKEN, csrf: TOKEN }, false, 60, true)).toEqual([
      SESSION_COOKIE + '=' + TOKEN + '; HttpOnly; Path=/api/v1; SameSite=Strict; Max-Age=60',
      CSRF_COOKIE + '=' + TOKEN + '; Path=/; SameSite=Strict; Max-Age=60',
      CSRF_COOKIE + '=; Path=/api/v1; SameSite=Strict; Max-Age=0',
    ]);
  });

  it('tells whether a cookie header carries a name at all', () => {
    expect(hasCookie(undefined, CSRF_COOKIE)).toBe(false);
    expect(hasCookie('other=1', CSRF_COOKIE)).toBe(false);
    expect(hasCookie('other=1; ' + CSRF_COOKIE + '=', CSRF_COOKIE)).toBe(true);
    expect(hasCookie(CSRF_COOKIE + '=a; ' + CSRF_COOKIE + '=b', CSRF_COOKIE)).toBe(true);
  });
});
