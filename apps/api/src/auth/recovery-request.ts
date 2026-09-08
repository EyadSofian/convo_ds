import type { ErrorDetail } from '@convo/contracts';

/**
 * Request parsing for the two recovery endpoints.
 *
 * Shape errors are reported normally — a missing field is not a secret. What
 * must never differ is the response *after* a well-formed request: a known and
 * an unknown email produce byte-identical output.
 */

export interface RecoveryStartRequest {
  readonly email: string;
}

export interface RecoveryCompleteRequest {
  readonly token: string;
  readonly password: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: readonly ErrorDetail[] };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/** Minimum password length, matching the bootstrap Owner password rule. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 512;

/** Recovery tokens are 32 random bytes, base64url — 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function body(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRecoveryStart(input: unknown): ParseResult<RecoveryStartRequest> {
  const record = body(input);
  if (record === null) {
    return { ok: false, details: [{ field: 'body', code: 'malformed', message: 'The request body must be an object.' }] };
  }
  const email = record['email'];
  if (
    typeof email !== 'string' ||
    email.trim().length === 0 ||
    email.trim().length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email.trim())
  ) {
    return { ok: false, details: [{ field: 'email', code: 'malformed', message: 'Provide a valid email address.' }] };
  }
  return { ok: true, value: { email: email.trim().toLowerCase() } };
}

export function parseRecoveryComplete(input: unknown): ParseResult<RecoveryCompleteRequest> {
  const record = body(input);
  if (record === null) {
    return { ok: false, details: [{ field: 'body', code: 'malformed', message: 'The request body must be an object.' }] };
  }
  const details: ErrorDetail[] = [];
  const token = record['token'];
  const password = record['password'];

  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    details.push({
      field: 'token',
      code: 'malformed',
      message: 'The recovery token is not in the expected format.',
    });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    details.push({
      field: 'password',
      code: 'too_short',
      message: `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    });
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    details.push({
      field: 'password',
      code: 'too_long',
      message: `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`,
    });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }
  return { ok: true, value: { token: token as string, password: password as string } };
}
