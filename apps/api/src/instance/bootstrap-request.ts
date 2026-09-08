import type { ErrorDetail } from '@convo/contracts';

export interface BootstrapRequest {
  readonly companyName: string;
  readonly companySlug: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
}

export type BootstrapRequestParse =
  | { readonly status: 'valid'; readonly value: BootstrapRequest }
  | { readonly status: 'invalid'; readonly details: readonly ErrorDetail[] };

const ALLOWED_FIELDS = new Set([
  'companyName',
  'companySlug',
  'ownerEmail',
  'ownerPassword',
]);
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function parseBootstrapRequest(input: unknown): BootstrapRequestParse {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      status: 'invalid',
      details: [detail('body', 'not_an_object', 'A JSON object is required.')],
    };
  }
  const record = input as Readonly<Record<string, unknown>>;
  const details: ErrorDetail[] = [];
  for (const field of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(field)) {
      details.push(detail(field, 'unexpected', 'This field is not accepted.'));
    }
  }

  const companyName = textField(record, 'companyName', details);
  const companySlug = textField(record, 'companySlug', details);
  const ownerEmail = textField(record, 'ownerEmail', details);
  const ownerPassword = textField(record, 'ownerPassword', details, false);

  if (companyName.length > 80) {
    details.push(detail('companyName', 'too_long', 'At most 80 characters are allowed.'));
  }
  if (companySlug !== '' && !SLUG_PATTERN.test(companySlug)) {
    details.push(
      detail(
        'companySlug',
        'malformed',
        'Use 1-40 lowercase letters, digits or hyphens, without edge hyphens.',
      ),
    );
  }
  if (ownerEmail !== '' && !plausibleEmail(ownerEmail)) {
    details.push(detail('ownerEmail', 'malformed', 'A valid owner email is required.'));
  }
  if (ownerPassword !== '' && (ownerPassword.length < 12 || ownerPassword.length > 128)) {
    details.push(
      detail('ownerPassword', 'invalid_length', 'Use between 12 and 128 characters.'),
    );
  }

  if (details.length > 0) {
    return { status: 'invalid', details };
  }
  return {
    status: 'valid',
    value: { companyName, companySlug, ownerEmail, ownerPassword },
  };
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error('invalid_idempotency_key');
  }
  return value;
}

function textField(
  record: Readonly<Record<string, unknown>>,
  field: keyof BootstrapRequest,
  details: ErrorDetail[],
  trim = true,
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
  if (parts.length !== 2 || parts[0] === '') {
    return false;
  }
  return /^[^.@]+(?:\.[^.@]+)*\.[A-Za-z]{2,}$/.test(parts[1]!);
}

function detail(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
