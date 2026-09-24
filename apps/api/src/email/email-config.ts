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
 * Provider validation belongs only to the integration worker, which is the
 * sole process that calls an email provider. Every other role receives the
 * disabled binding, even if unrelated provider variables are malformed. That
 * keeps Inbox/auth/readiness independent from Resend without creating a silent
 * fallback. The logging adapter still exists for non-production integration
 * workers and tests, but selecting it in production is a configuration error.
 *
 * "Production" is `NODE_ENV=production`, which the Dockerfile sets and which no
 * request can influence. It is read here and nowhere else.
 */

export const EMAIL_LOCALES = ['en', 'ar'] as const;
export type EmailLocaleSetting = (typeof EMAIL_LOCALES)[number];

/**
 * The language invitation and recovery emails are written in.
 *
 * Separate from the interface default on purpose: the workspace opens in
 * Arabic, while the people who receive these emails asked for them in
 * English. `CONVO_EMAIL_LOCALE` is `en` (the default) or `ar`; anything else
 * is a configuration error rather than a silent guess.
 */
export function readEmailLocale(env: EnvironmentSource, issues: ErrorDetail[]): EmailLocaleSetting {
  const raw = env['CONVO_EMAIL_LOCALE']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'en';
  if ((EMAIL_LOCALES as readonly string[]).includes(raw)) return raw as EmailLocaleSetting;
  issues.push({ field: 'CONVO_EMAIL_LOCALE', code: 'invalid', message: 'CONVO_EMAIL_LOCALE must be en or ar.' });
  return 'en';
}

export const EMAIL_PROVIDERS = ['disabled', 'logging', 'resend', 'smtp'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

export interface EmailConfig {
  readonly provider: EmailProviderName;
  /** `Name <address@domain>` or a bare address. Empty when delivery is disabled. */
  readonly from: string;
  /** Empty when not using Resend. Never logged, never returned by an API. */
  readonly resendApiKey: string;
  /** SMTP settings are populated only for the SMTP integration-worker binding. */
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly username: string;
    /** Never logged, never returned by an API. */
    readonly password: string;
  };
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
const EMPTY_SMTP = Object.freeze({ host: '', port: 0, secure: false, username: '', password: '' });

export function isProductionEnvironment(env: EnvironmentSource): boolean {
  return env['NODE_ENV']?.trim() === 'production';
}

export function readEmailConfig(
  env: EnvironmentSource,
  issues: ErrorDetail[],
  consumesProvider: boolean,
): EmailConfig {
  const production = isProductionEnvironment(env);
  const raw = optional(env, 'CONVO_EMAIL_PROVIDER');

  // Only worker-integration sends email. Returning `disabled` here is not a
  // fallback provider: its adapter refuses every send with a typed error.
  if (!consumesProvider) {
    return disabledConfig();
  }

  if (raw === undefined) {
    return disabledConfig();
  }

  if (!(EMAIL_PROVIDERS as readonly string[]).includes(raw)) {
    issues.push(
      issue(
        'CONVO_EMAIL_PROVIDER',
        'unsupported_value',
        `The email provider must be one of: ${EMAIL_PROVIDERS.join(', ')}.`,
      ),
    );
    return loggingConfig();
  }

  const provider = raw as EmailProviderName;

  if (provider === 'disabled') {
    return disabledConfig();
  }

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
    return loggingConfig();
  }

  const from = readFrom(env, issues);
  if (provider === 'resend') {
    return { provider, from, resendApiKey: readApiKey(env, issues), smtp: EMPTY_SMTP };
  }
  return { provider, from, resendApiKey: '', smtp: readSmtp(env, issues) };
}

function disabledConfig(): EmailConfig {
  return { provider: 'disabled', from: '', resendApiKey: '', smtp: EMPTY_SMTP };
}

function loggingConfig(): EmailConfig {
  return { provider: 'logging', from: '', resendApiKey: '', smtp: EMPTY_SMTP };
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

function readSmtp(env: EnvironmentSource, issues: ErrorDetail[]): EmailConfig['smtp'] {
  const host = requiredSmtpText(env, 'CONVO_SMTP_HOST', issues);
  const port = readSmtpPort(env, issues);
  const secure = readSmtpSecure(env, issues);
  const username = requiredSmtpText(env, 'CONVO_SMTP_USERNAME', issues);
  const password = requiredSmtpText(env, 'CONVO_SMTP_PASSWORD', issues);

  // Port 465 is implicit TLS. Configuring it as STARTTLS makes the client wait
  // for a plaintext SMTP greeting that the server will never send.
  if (port === 465 && secure !== true) {
    issues.push(
      issue('CONVO_SMTP_SECURE', 'required_for_port_465', 'SMTP port 465 requires CONVO_SMTP_SECURE=true.'),
    );
  }
  return { host, port, secure, username, password };
}

function requiredSmtpText(env: EnvironmentSource, field: string, issues: ErrorDetail[]): string {
  const value = optional(env, field);
  if (value === undefined) {
    issues.push(issue(field, 'required', `${field} must be configured for the SMTP provider.`));
    return '';
  }
  return value;
}

function readSmtpPort(env: EnvironmentSource, issues: ErrorDetail[]): number {
  const raw = optional(env, 'CONVO_SMTP_PORT');
  if (raw === undefined) {
    issues.push(issue('CONVO_SMTP_PORT', 'required', 'SMTP port must be configured for the SMTP provider.'));
    return 0;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push(issue('CONVO_SMTP_PORT', 'out_of_range', 'SMTP port must be an integer from 1 to 65535.'));
    return 0;
  }
  return port;
}

function readSmtpSecure(env: EnvironmentSource, issues: ErrorDetail[]): boolean {
  const raw = optional(env, 'CONVO_SMTP_SECURE');
  if (raw === undefined) {
    issues.push(issue('CONVO_SMTP_SECURE', 'required', 'SMTP secure mode must be explicitly true or false.'));
    return false;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  issues.push(issue('CONVO_SMTP_SECURE', 'invalid_boolean', 'SMTP secure mode must be true or false.'));
  return false;
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
