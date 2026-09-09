import type { ErrorDetail } from '@convo/contracts';

/**
 * Request parsing for the invitation endpoints.
 *
 * Shape errors are reported plainly — a missing field is not a secret. What
 * must never vary is the *outcome* of a well-formed accept: an unknown,
 * expired, revoked or already-used token, and a wrong password, all answer the
 * same way.
 */

export interface CreateInvitationRequest {
  readonly email: string;
  readonly roleId: string;
  readonly scopes: readonly { readonly type: 'tenant' | 'team' | 'inbox'; readonly id: string | null }[];
}

export interface AcceptInvitationRequest {
  readonly password: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly details: readonly ErrorDetail[] };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_SCOPES = 50;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 512;

/** Invitation tokens are 32 random bytes, base64url — 43 characters. */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCreateInvitation(input: unknown): ParseResult<CreateInvitationRequest> {
  const record = asRecord(input);
  if (record === null) {
    return {
      ok: false,
      details: [{ field: 'body', code: 'malformed', message: 'The body must be an object.' }],
    };
  }

  const details: ErrorDetail[] = [];
  const email = record['email'];
  const roleId = record['roleId'];
  const rawScopes = record['scopes'] ?? [];

  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    details.push({ field: 'email', code: 'malformed', message: 'Provide a valid email address.' });
  }
  if (typeof roleId !== 'string' || !UUID_PATTERN.test(roleId)) {
    details.push({ field: 'roleId', code: 'malformed', message: 'Provide a role id.' });
  }

  const scopes: { type: 'tenant' | 'team' | 'inbox'; id: string | null }[] = [];
  if (!Array.isArray(rawScopes)) {
    details.push({ field: 'scopes', code: 'malformed', message: 'Scopes must be an array.' });
  } else if (rawScopes.length > MAX_SCOPES) {
    details.push({ field: 'scopes', code: 'too_many', message: `At most ${String(MAX_SCOPES)}.` });
  } else {
    for (const [index, entry] of rawScopes.entries()) {
      const scope = asRecord(entry);
      const type = scope?.['type'];
      const id = scope?.['id'] ?? null;
      const typed = type === 'tenant' || type === 'team' || type === 'inbox';
      // A tenant scope has no id; a team or inbox scope must name one. The
      // database enforces the same pairing, so a mismatch here is a client bug
      // worth naming rather than a constraint violation to translate later.
      const idOk = type === 'tenant' ? id === null : typeof id === 'string' && UUID_PATTERN.test(id);
      if (!typed || !idOk) {
        details.push({
          field: `scopes.${String(index)}`,
          code: 'malformed',
          message: 'Each scope is {type: tenant|team|inbox, id}; only a tenant scope has a null id.',
        });
        continue;
      }
      scopes.push({ type, id: type === 'tenant' ? null : (id as string) });
    }
  }

  if (details.length > 0) {
    return { ok: false, details };
  }
  return {
    ok: true,
    value: { email: trimmed.toLowerCase(), roleId: roleId as string, scopes },
  };
}

export function parseAcceptInvitation(input: unknown): ParseResult<AcceptInvitationRequest> {
  const record = asRecord(input);
  if (record === null) {
    return {
      ok: false,
      details: [{ field: 'body', code: 'malformed', message: 'The body must be an object.' }],
    };
  }
  const password = record['password'];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      details: [
        {
          field: 'password',
          code: 'too_short',
          message: `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
        },
      ],
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      details: [
        {
          field: 'password',
          code: 'too_long',
          message: `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`,
        },
      ],
    };
  }
  return { ok: true, value: { password } };
}
