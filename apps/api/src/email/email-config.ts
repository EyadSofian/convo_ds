import type { ErrorDetail } from '@convo/contracts';
import type { EnvironmentSource } from '@convo/domain';

/**
 * Email configuration, and the rule that makes it fail closed.
 *
 * The product used to bind a logging adapter by default, which meant a
 * production installation with no email configuration booted happily, accepted
 * invitations, reported success, and delivered nothing. Nobody finds that until
 * a new employee says they never got the link.
 *
 * So the default is gone. A production process must name a real provider and
 * configure it completely, or it does not start. The logging adapter still
 * exists — it is how the integration tests drive the whole outbox state machine
 * without a network — but selecting it in production is a configuration error
 * with its own code, not a shrug.
 *
 * "Production" is `NODE_ENV=production`, which the Dockerfile sets and which no
 * request can influence. It is read here and nowhere else.
 */

export const EMAIL_PROVIDERS = ['resend', 'logging'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

export interface EmailConfig {
  readonly provider: EmailProviderName;
  /** `Name <address@domain>` or a bare address. Empty for the logging provider. */
  readonly from: string;
  /** Empty for the logging provider. Never logged, never returned by an API. */
  readonly resendApiKey: string;
}

/**
 * `Display Name <local@domain.tld>` or `local@domain.tld`.
 *
 * Deliberately stricter than RFC 5322 allows. A sending identity is configured
 * once by an operator, so the cost of rejecting an exotic-but-legal address is
 * a support question, and the cost of accepting a malformed one is every email
 * this installation will ever send being refused at 422.
 */
const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;".]+(?:\.[^\s<>@,;".]+)*\.[A-Za-z]{2,}$/;
const NAMED_ADDRESS = /^(?<name>[^<>]{1,120})<(?<address>[^\s<>@,;"]+@[^\s<>,;"]+)>$/;

/** Short enough to be obviously a placeholder, long enough that a real key passes. */
const MIN_API_KEY_LENGTH = 16;

export function isProductionEnvironment(env: EnvironmentSource): boolean {
  return env['NODE_ENV']?.trim() === 'production';
}

export function readEmailConfig(env: EnvironmentSource, issues: ErrorDetail[]): EmailConfig {
  const production = isProductionEnvironment(env);
  const raw = optional(env, 'CONVO_EMAIL_PROVIDER');

  if (raw === undefined) {
    if (production) {
      issues.push(
        issue(
          'CONVO_EMAIL_PROVIDER',
          'required',
          'A production installation must configure an email provider. Invitations and password recovery do not work without one.',
        ),
      );
    }
    return { provider: 'logging', from: '', resendApiKey: '' };
  }

  if (!(EMAIL_PROVIDERS as readonly string[]).includes(raw)) {
    issues.push(
      issue(
        'CONVO_EMAIL_PROVIDER',
        'unsupported_value',
        `The email provider must be one of: ${EMAIL_PROVIDERS.join(', ')}.`,
      ),
    );
    return { provider: 'logging', from: '', resendApiKey: '' };
  }

  const provider = raw as EmailProviderName;

  if (provider === 'logging') {
    if (production) {
      issues.push(
        issue(
          'CONVO_EMAIL_PROVIDER',
          'not_permitted_in_production',
          'The logging email provider sends nothing. It is available only outside production.',
        ),
      );
    }
    return { provider: 'logging', from: '', resendApiKey: '' };
  }

  const from = readFrom(env, issues);
  const resendApiKey = readApiKey(env, issues);
  return { provider, from, resendApiKey };
}

function readFrom(env: EnvironmentSource, issues: ErrorDetail[]): string {
  const value = optional(env, 'CONVO_EMAIL_FROM');
  if (value === undefined) {
    issues.push(
      issue('CONVO_EMAIL_FROM', 'required', 'A verified sending identity must be configured.'),
    );
    return '';
  }
  if (!isSendingIdentity(value)) {
    issues.push(
      issue(
        'CONVO_EMAIL_FROM',
        'malformed',
        'Use "name@domain.tld" or "Display Name <name@domain.tld>".',
      ),
    );
    return '';
  }
  return value;
}

function readApiKey(env: EnvironmentSource, issues: ErrorDetail[]): string {
  const value = optional(env, 'CONVO_RESEND_API_KEY');
  if (value === undefined) {
    issues.push(issue('CONVO_RESEND_API_KEY', 'required', 'The Resend API key must be configured.'));
    return '';
  }
  if (value.length < MIN_API_KEY_LENGTH) {
    // The message says the length and never the value.
    issues.push(
      issue(
        'CONVO_RESEND_API_KEY',
        'too_short',
        `A Resend API key is at least ${String(MIN_API_KEY_LENGTH)} characters.`,
      ),
    );
    return '';
  }
  return value;
}

export function isSendingIdentity(value: string): boolean {
  const named = NAMED_ADDRESS.exec(value);
  if (named?.groups?.['address'] !== undefined) {
    return ADDRESS.test(named.groups['address']);
  }
  return ADDRESS.test(value);
}

function optional(env: EnvironmentSource, field: string): string | undefined {
  const value = env[field]?.trim();
  return value === '' ? undefined : value;
}

function issue(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
