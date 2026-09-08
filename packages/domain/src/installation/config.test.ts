import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseInstallationConfig } from './config.js';

const minimal = {
  CONVO_DEPLOYMENT_MODE: 'saas',
  CONVO_INSTALLATION_NAME: 'CONVO Cloud',
  CONVO_PUBLIC_BASE_URL: 'https://app.convo.example',
} as const;

function issues(env: Record<string, string | undefined>): string[] {
  try {
    parseInstallationConfig(env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.issues.map((i) => `${i.field}:${i.code}`);
    }
    throw error;
  }
  throw new Error('expected parseInstallationConfig to reject');
}

describe('parseInstallationConfig (MODE-01)', () => {
  it('accepts a minimal valid environment and applies documented defaults', () => {
    const config = parseInstallationConfig(minimal);
    expect(config.deploymentMode).toBe('saas');
    expect(config.installationName).toBe('CONVO Cloud');
    expect(config.publicBaseUrl).toBe('https://app.convo.example');
    expect(config.defaultLocale).toBe('ar');
    expect([...config.supportedLocales]).toEqual(['ar', 'en']);
    expect(config.ssoConfigured).toBe(false);
    expect(config.mfaAvailable).toBe(true);
  });

  it('returns a frozen object, so nothing can flip the mode after boot', () => {
    const config = parseInstallationConfig(minimal);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { deploymentMode: string }).deploymentMode = 'self_hosted_single';
    }).toThrow(TypeError);
    expect(config.deploymentMode).toBe('saas');
  });

  it('reads self_hosted_single when configured', () => {
    expect(
      parseInstallationConfig({ ...minimal, CONVO_DEPLOYMENT_MODE: 'self_hosted_single' })
        .deploymentMode,
    ).toBe('self_hosted_single');
  });

  it('refuses to boot without a deployment mode', () => {
    expect(issues({ ...minimal, CONVO_DEPLOYMENT_MODE: undefined })).toContain(
      'CONVO_DEPLOYMENT_MODE:required',
    );
    expect(issues({ ...minimal, CONVO_DEPLOYMENT_MODE: '   ' })).toContain(
      'CONVO_DEPLOYMENT_MODE:required',
    );
  });

  it('refuses an unrecognised deployment mode instead of guessing', () => {
    expect(issues({ ...minimal, CONVO_DEPLOYMENT_MODE: 'single' })).toContain(
      'CONVO_DEPLOYMENT_MODE:unsupported_value',
    );
  });

  it('trims surrounding whitespace before validating', () => {
    expect(
      parseInstallationConfig({ ...minimal, CONVO_DEPLOYMENT_MODE: ' saas ' }).deploymentMode,
    ).toBe('saas');
  });

  it('requires an installation name and bounds its length', () => {
    expect(issues({ ...minimal, CONVO_INSTALLATION_NAME: undefined })).toContain(
      'CONVO_INSTALLATION_NAME:required',
    );
    expect(issues({ ...minimal, CONVO_INSTALLATION_NAME: 'x'.repeat(81) })).toContain(
      'CONVO_INSTALLATION_NAME:too_long',
    );
    expect(parseInstallationConfig({ ...minimal, CONVO_INSTALLATION_NAME: 'x'.repeat(80) }).installationName).toHaveLength(80);
  });

  describe('public base URL', () => {
    it('is required', () => {
      expect(issues({ ...minimal, CONVO_PUBLIC_BASE_URL: undefined })).toContain(
        'CONVO_PUBLIC_BASE_URL:required',
      );
    });

    it('must parse as a URL', () => {
      expect(issues({ ...minimal, CONVO_PUBLIC_BASE_URL: 'app.convo.example' })).toContain(
        'CONVO_PUBLIC_BASE_URL:malformed',
      );
    });

    it('must be http or https', () => {
      expect(issues({ ...minimal, CONVO_PUBLIC_BASE_URL: 'ftp://convo.example' })).toContain(
        'CONVO_PUBLIC_BASE_URL:unsupported_scheme',
      );
    });

    it.each([
      ['a query string', 'https://convo.example/?a=1'],
      ['a fragment', 'https://convo.example/#x'],
    ])('rejects %s', (_label, value) => {
      expect(issues({ ...minimal, CONVO_PUBLIC_BASE_URL: value })).toContain(
        'CONVO_PUBLIC_BASE_URL:unexpected_components',
      );
    });

    it('normalises trailing slashes so every later callback is built the same way', () => {
      expect(
        parseInstallationConfig({ ...minimal, CONVO_PUBLIC_BASE_URL: 'https://convo.example///' })
          .publicBaseUrl,
      ).toBe('https://convo.example');
      expect(
        parseInstallationConfig({ ...minimal, CONVO_PUBLIC_BASE_URL: 'http://convo.example/base/' })
          .publicBaseUrl,
      ).toBe('http://convo.example/base');
    });
  });

  describe('locales', () => {
    it('accepts an explicit supported list and de-duplicates it', () => {
      const config = parseInstallationConfig({
        ...minimal,
        CONVO_SUPPORTED_LOCALES: ' en , ar , en ',
        CONVO_DEFAULT_LOCALE: 'en',
      });
      expect([...config.supportedLocales]).toEqual(['en', 'ar']);
      expect(config.defaultLocale).toBe('en');
    });

    it('rejects an unknown supported locale', () => {
      expect(issues({ ...minimal, CONVO_SUPPORTED_LOCALES: 'ar,fr' })).toContain(
        'CONVO_SUPPORTED_LOCALES:unsupported_value',
      );
    });

    it('rejects an unknown default locale', () => {
      expect(issues({ ...minimal, CONVO_DEFAULT_LOCALE: 'fr' })).toContain(
        'CONVO_DEFAULT_LOCALE:unsupported_value',
      );
    });

    it('rejects a default locale the installation does not serve', () => {
      expect(
        issues({ ...minimal, CONVO_SUPPORTED_LOCALES: 'en', CONVO_DEFAULT_LOCALE: 'ar' }),
      ).toContain('CONVO_DEFAULT_LOCALE:not_supported_here');
    });
  });

  describe('booleans and presence flags', () => {
    it('accepts exactly "true" and "false"', () => {
      expect(parseInstallationConfig({ ...minimal, CONVO_MFA_ENABLED: 'false' }).mfaAvailable).toBe(
        false,
      );
      expect(parseInstallationConfig({ ...minimal, CONVO_MFA_ENABLED: 'true' }).mfaAvailable).toBe(
        true,
      );
    });

    it.each(['1', 'yes', 'TRUE', 'off'])('rejects the sloppy boolean %s', (value) => {
      expect(issues({ ...minimal, CONVO_MFA_ENABLED: value })).toContain(
        'CONVO_MFA_ENABLED:not_boolean',
      );
    });

    it('falls back to the default when the variable is blank', () => {
      expect(parseInstallationConfig({ ...minimal, CONVO_MFA_ENABLED: '  ' }).mfaAvailable).toBe(
        true,
      );
    });

    it('reports SSO as configured from issuer presence, without keeping the value', () => {
      const config = parseInstallationConfig({
        ...minimal,
        CONVO_OIDC_ISSUER: 'https://idp.example/realms/convo',
      });
      expect(config.ssoConfigured).toBe(true);
      expect(JSON.stringify(config)).not.toContain('idp.example');
    });
  });

  it('reports every problem at once rather than one restart at a time', () => {
    const reported = issues({
      CONVO_DEPLOYMENT_MODE: 'nope',
      CONVO_INSTALLATION_NAME: undefined,
      CONVO_PUBLIC_BASE_URL: 'nonsense',
      CONVO_MFA_ENABLED: 'maybe',
    });
    expect(reported).toEqual([
      'CONVO_DEPLOYMENT_MODE:unsupported_value',
      'CONVO_INSTALLATION_NAME:required',
      'CONVO_PUBLIC_BASE_URL:malformed',
      'CONVO_MFA_ENABLED:not_boolean',
    ]);
  });

  it('is a typed error carrying a stable machine code', () => {
    try {
      parseInstallationConfig({});
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const failure = error as ConfigurationError;
      expect(failure.code).toBe('installation_configuration_invalid');
      expect(failure.name).toBe('ConfigurationError');
      expect(failure.message).toContain('CONVO_DEPLOYMENT_MODE (required)');
    }
  });
});
