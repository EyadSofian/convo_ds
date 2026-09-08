import {
  UI_LOCALES,
  isDeploymentMode,
  isUiLocale,
  type DeploymentMode,
  type ErrorDetail,
  type UiLocale,
} from '@convo/contracts';

/**
 * Boot-time installation configuration (MODE-01).
 *
 * This module is the **only** place in the product that turns an environment
 * variable into a deployment mode. `tests/integration/deployment-mode.test.ts`
 * greps first-party source to keep that true, because the security property is
 * not "we validate the value" -- it is "there is nowhere else to get it from".
 * Nothing in a request body, query string, header or Host can reach this.
 */
export interface InstallationConfig {
  readonly deploymentMode: DeploymentMode;
  readonly installationName: string;
  readonly publicBaseUrl: string;
  readonly defaultLocale: UiLocale;
  readonly supportedLocales: readonly UiLocale[];
  readonly ssoConfigured: boolean;
  readonly mfaAvailable: boolean;
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  readonly code = 'installation_configuration_invalid';
  readonly issues: readonly ErrorDetail[];

  constructor(issues: readonly ErrorDetail[]) {
    super(
      `Installation configuration is invalid: ${issues.map((i) => `${i.field} (${i.code})`).join(', ')}`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

const MAX_NAME_LENGTH = 80;

/**
 * Parses and validates the whole configuration, reporting **every** problem at
 * once. An operator fixing a self-hosted install should not have to restart
 * five times to discover five typos.
 */
export function parseInstallationConfig(env: EnvironmentSource): InstallationConfig {
  const issues: ErrorDetail[] = [];

  const rawMode = trimmed(env['CONVO_DEPLOYMENT_MODE']);
  let deploymentMode: DeploymentMode = 'saas';
  if (rawMode === undefined) {
    issues.push(issue('CONVO_DEPLOYMENT_MODE', 'required', 'Deployment mode must be configured.'));
  } else if (!isDeploymentMode(rawMode)) {
    issues.push(
      issue(
        'CONVO_DEPLOYMENT_MODE',
        'unsupported_value',
        'Deployment mode must be "saas" or "self_hosted_single".',
      ),
    );
  } else {
    deploymentMode = rawMode;
  }

  const rawName = trimmed(env['CONVO_INSTALLATION_NAME']);
  let installationName = '';
  if (rawName === undefined) {
    issues.push(issue('CONVO_INSTALLATION_NAME', 'required', 'Installation name must be set.'));
  } else if (rawName.length > MAX_NAME_LENGTH) {
    issues.push(
      issue(
        'CONVO_INSTALLATION_NAME',
        'too_long',
        `Installation name must be at most ${MAX_NAME_LENGTH} characters.`,
      ),
    );
  } else {
    installationName = rawName;
  }

  const publicBaseUrl = parseBaseUrl(trimmed(env['CONVO_PUBLIC_BASE_URL']), issues);
  const { defaultLocale, supportedLocales } = parseLocales(env, issues);

  const mfaAvailable = parseBoolean(env['CONVO_MFA_ENABLED'], 'CONVO_MFA_ENABLED', true, issues);

  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }

  // Presence only. The issuer value itself never leaves the server.
  const ssoConfigured = trimmed(env['CONVO_OIDC_ISSUER']) !== undefined;

  return Object.freeze({
    deploymentMode,
    installationName,
    publicBaseUrl,
    defaultLocale,
    supportedLocales: Object.freeze(supportedLocales),
    ssoConfigured,
    mfaAvailable,
  });
}

function parseBaseUrl(raw: string | undefined, issues: ErrorDetail[]): string {
  if (raw === undefined) {
    issues.push(
      issue('CONVO_PUBLIC_BASE_URL', 'required', 'The public base URL must be configured.'),
    );
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push(issue('CONVO_PUBLIC_BASE_URL', 'malformed', 'The public base URL is not a URL.'));
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    issues.push(
      issue('CONVO_PUBLIC_BASE_URL', 'unsupported_scheme', 'Only http and https are supported.'),
    );
    return '';
  }
  if (url.search !== '' || url.hash !== '') {
    issues.push(
      issue(
        'CONVO_PUBLIC_BASE_URL',
        'unexpected_components',
        'The public base URL must not carry a query string or fragment.',
      ),
    );
    return '';
  }
  // Normalise once here so that every later signature, redirect and webhook
  // callback is built from the same string.
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parseLocales(
  env: EnvironmentSource,
  issues: ErrorDetail[],
): { defaultLocale: UiLocale; supportedLocales: UiLocale[] } {
  const rawSupported = trimmed(env['CONVO_SUPPORTED_LOCALES']);
  let supportedLocales: UiLocale[] = [...UI_LOCALES];
  if (rawSupported !== undefined) {
    const parts = rawSupported.split(',').map((p) => p.trim());
    const unknown = parts.filter((p) => !isUiLocale(p));
    if (unknown.length > 0) {
      issues.push(
        issue(
          'CONVO_SUPPORTED_LOCALES',
          'unsupported_value',
          `Unsupported locale(s): ${unknown.join(', ')}.`,
        ),
      );
    } else {
      supportedLocales = [...new Set(parts.filter(isUiLocale))];
    }
  }

  const rawDefault = trimmed(env['CONVO_DEFAULT_LOCALE']);
  let defaultLocale: UiLocale = 'ar';
  if (rawDefault !== undefined) {
    if (!isUiLocale(rawDefault)) {
      issues.push(
        issue('CONVO_DEFAULT_LOCALE', 'unsupported_value', 'Default locale must be "ar" or "en".'),
      );
      return { defaultLocale, supportedLocales };
    }
    defaultLocale = rawDefault;
  }

  if (!supportedLocales.includes(defaultLocale)) {
    issues.push(
      issue(
        'CONVO_DEFAULT_LOCALE',
        'not_supported_here',
        'The default locale must be one of the supported locales.',
      ),
    );
  }
  return { defaultLocale, supportedLocales };
}

function parseBoolean(
  raw: string | undefined,
  field: string,
  fallback: boolean,
  issues: ErrorDetail[],
): boolean {
  const value = trimmed(raw);
  if (value === undefined) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  issues.push(issue(field, 'not_boolean', 'Value must be exactly "true" or "false".'));
  return fallback;
}

function trimmed(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function issue(field: string, code: string, message: string): ErrorDetail {
  return { field, code, message };
}
