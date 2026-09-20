import type { ErrorDetail } from '@convo/contracts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type ParseResult } from './recovery-request.js';

export interface PasswordChangeRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword: string;
}

const FIELDS = new Set(['currentPassword', 'newPassword', 'confirmPassword']);

/** Strict parser for an authenticated, account-wide password change. */
export function parsePasswordChange(input: unknown): ParseResult<PasswordChangeRequest> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, details: [detail('body', 'malformed', 'The request body must be an object.')] };
  }
  const record = input as Readonly<Record<string, unknown>>;
  const details: ErrorDetail[] = [];
  for (const field of Object.keys(record)) {
    if (!FIELDS.has(field)) details.push(detail(field, 'unexpected', 'This field is not accepted.'));
  }
  const currentPassword = password(record, 'currentPassword', details, 1);
  const newPassword = password(record, 'newPassword', details, MIN_PASSWORD_LENGTH);
  const confirmPassword = password(record, 'confirmPassword', details, MIN_PASSWORD_LENGTH);
  if (newPassword !== '' && confirmPassword !== '' && newPassword !== confirmPassword) {
    details.push(detail('confirmPassword', 'mismatch', 'The passwords do not match.'));
  }
  return details.length === 0
    ? { ok: true, value: { currentPassword, newPassword, confirmPassword } }
    : { ok: false, details };
}

function password(
  record: Readonly<Record<string, unknown>>,
  field: keyof PasswordChangeRequest,
  details: ErrorDetail[],
  minimum: number,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    details.push(detail(field, value === undefined ? 'required' : 'not_a_string', 'A string is required.'));
    return '';
  }
  if (value.length < minimum) {
    details.push(detail(field, 'too_short', `Use at least ${String(minimum)} characters.`));
  } else if (value.length > MAX_PASSWORD_LENGTH) {
    details.push(detail(field, 'too_long', `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`));
  }
  return value;
}

function detail(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
