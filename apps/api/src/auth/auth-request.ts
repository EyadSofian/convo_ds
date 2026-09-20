import type { ErrorDetail } from '@convo/contracts';
import { MAX_PASSWORD_LENGTH } from './recovery-request.js';

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

export type LoginRequestParse =
  | { readonly status: 'valid'; readonly value: LoginRequest }
  | { readonly status: 'invalid'; readonly details: readonly ErrorDetail[] };

const LOGIN_FIELDS = new Set(['email', 'password']);

export function parseLoginRequest(input: unknown): LoginRequestParse {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return rejected([detail('body', 'not_an_object', 'A JSON object is required.')]);
  }
  const record = input as Readonly<Record<string, unknown>>;
  const details: ErrorDetail[] = [];
  for (const field of Object.keys(record)) {
    if (!LOGIN_FIELDS.has(field)) {
      details.push(detail(field, 'unexpected', 'This field is not accepted.'));
    }
  }
  const email = readText(record, 'email', details, true);
  const password = readText(record, 'password', details, false);
  if (email !== '' && !plausibleEmail(email)) {
    details.push(detail('email', 'malformed', 'A valid email is required.'));
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    details.push(
      detail('password', 'too_long', `At most ${String(MAX_PASSWORD_LENGTH)} characters are accepted.`),
    );
  }
  return details.length === 0
    ? { status: 'valid', value: { email: email.toLowerCase(), password } }
    : rejected(details);
}

function readText(
  record: Readonly<Record<string, unknown>>,
  field: keyof LoginRequest,
  details: ErrorDetail[],
  trim: boolean,
): string {
  const raw = record[field];
  if (typeof raw !== 'string') {
    details.push(detail(field, raw === undefined ? 'required' : 'not_a_string', 'A string is required.'));
    return '';
  }
  const value = trim ? raw.trim() : raw;
  if (value === '') {
    details.push(detail(field, 'required', 'A value is required.'));
  }
  return value;
}

function plausibleEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) {
    return false;
  }
  const parts = value.split('@');
  return (
    parts.length === 2 &&
    parts[0] !== '' &&
    /^[^.]+(?:\.[^.]+)*$/.test(parts[0] as string) &&
    /^[^.@]+(?:\.[^.@]+)*\.[A-Za-z]{2,}$/.test(parts[1] as string)
  );
}

function rejected(details: readonly ErrorDetail[]): LoginRequestParse {
  return { status: 'invalid', details };
}

function detail(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
