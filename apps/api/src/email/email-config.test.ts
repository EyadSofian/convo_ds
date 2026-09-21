import type { ErrorDetail } from '@convo/contracts';
import { describe, expect, it } from 'vitest';
import { isSendingIdentity, readEmailConfig } from './email-config.js';

/**
 * The fail-closed rule.
 *
 * The property being defended is narrow and worth stating: **a production
 * process must not be able to start believing it can send email when it
 * cannot.** Everything below is that one sentence, checked from both sides.
 */

function read(env: Record<string, string | undefined>, consumesProvider = true) {
  const issues: ErrorDetail[] = [];
  const config = readEmailConfig(env, issues, consumesProvider);
  return { config, issues, codes: issues.map((issue) => `${issue.field}:${issue.code}`) };
}

const PRODUCTION = { NODE_ENV: 'production' };
const KEY = 're_0123456789abcdefghij';
const EMPTY_SMTP = { host: '', port: 0, secure: false, username: '', password: '' };
const SMTP = {
  CONVO_EMAIL_PROVIDER: 'smtp',
  CONVO_EMAIL_FROM: 'Digital School <ops@digital-school.example>',
  CONVO_SMTP_HOST: 'smtp.example.test',
  CONVO_SMTP_PORT: '465',
  CONVO_SMTP_SECURE: 'true',
  CONVO_SMTP_USERNAME: 'ops@digital-school.example',
  CONVO_SMTP_PASSWORD: 'smtp-secret-password',
};

describe('outside production', () => {
  it('defaults the integration worker to the disabled adapter', () => {
    const { config, issues } = read({});
    expect(config.provider).toBe('disabled');
    expect(issues).toHaveLength(0);
  });

  it('allows the logging adapter to be chosen explicitly', () => {
    const { config, issues } = read({ CONVO_EMAIL_PROVIDER: 'logging' });
    expect(config.provider).toBe('logging');
    expect(issues).toHaveLength(0);
  });

  it('allows the integration worker to be disabled explicitly', () => {
    const { config, issues } = read({ CONVO_EMAIL_PROVIDER: 'disabled' });
    expect(config).toEqual({ provider: 'disabled', from: '', resendApiKey: '', smtp: EMPTY_SMTP });
    expect(issues).toHaveLength(0);
  });
});

describe('in production', () => {
  it('starts the integration worker disabled with no provider configured', () => {
    const { config, issues } = read(PRODUCTION);
    expect(config.provider).toBe('disabled');
    expect(issues).toHaveLength(0);
  });

  it('refuses the logging adapter, which sends nothing', () => {
    const { codes } = read({ ...PRODUCTION, CONVO_EMAIL_PROVIDER: 'logging' });
    expect(codes).toContain('CONVO_EMAIL_PROVIDER:not_permitted_in_production');
  });

  it('accepts a complete Resend configuration', () => {
    const { config, issues } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'Digital School <ops@digital-school.example>',
      CONVO_RESEND_API_KEY: KEY,
    });
    expect(issues).toHaveLength(0);
    expect(config).toEqual({
      provider: 'resend',
      from: 'Digital School <ops@digital-school.example>',
      resendApiKey: KEY,
      smtp: EMPTY_SMTP,
    });
  });

  it('refuses Resend with no sender', () => {
    const { codes } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_RESEND_API_KEY: KEY,
    });
    expect(codes).toContain('CONVO_EMAIL_FROM:required');
  });

  it('refuses Resend with no API key', () => {
    const { codes } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'ops@digital-school.example',
    });
    expect(codes).toContain('CONVO_RESEND_API_KEY:required');
  });

  it('refuses an API key short enough to be a placeholder', () => {
    const { codes } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'ops@digital-school.example',
      CONVO_RESEND_API_KEY: 'changeme',
    });
    expect(codes).toContain('CONVO_RESEND_API_KEY:too_short');
  });

  it('never repeats the key back in the issue it raises', () => {
    const { issues } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'ops@digital-school.example',
      CONVO_RESEND_API_KEY: 'secret-but-short',
    });
    for (const issue of issues) {
      expect(issue.message).not.toContain('secret-but-short');
    }
  });

  it('reports every problem at once rather than one restart at a time', () => {
    const { codes } = read({ ...PRODUCTION, CONVO_EMAIL_PROVIDER: 'resend' });
    expect(codes).toContain('CONVO_EMAIL_FROM:required');
    expect(codes).toContain('CONVO_RESEND_API_KEY:required');
  });
});

describe('an unknown provider name', () => {
  it('is refused rather than silently ignored', () => {
    const { codes } = read({ CONVO_EMAIL_PROVIDER: 'sendgrid' });
    expect(codes).toContain('CONVO_EMAIL_PROVIDER:unsupported_value');
  });
});

describe('SMTP configuration', () => {
  it('accepts complete implicit-TLS SMTP configuration in production', () => {
    const { config, issues } = read({ ...PRODUCTION, ...SMTP });
    expect(issues).toHaveLength(0);
    expect(config).toEqual({
      provider: 'smtp',
      from: SMTP.CONVO_EMAIL_FROM,
      resendApiKey: '',
      smtp: {
        host: SMTP.CONVO_SMTP_HOST,
        port: 465,
        secure: true,
        username: SMTP.CONVO_SMTP_USERNAME,
        password: SMTP.CONVO_SMTP_PASSWORD,
      },
    });
  });

  it('reports every required SMTP setting without repeating a password', () => {
    const secret = 'do-not-echo-this-smtp-password';
    const { issues, codes } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'smtp',
      CONVO_SMTP_PASSWORD: secret,
    });
    for (const field of [
      'CONVO_EMAIL_FROM',
      'CONVO_SMTP_HOST',
      'CONVO_SMTP_PORT',
      'CONVO_SMTP_SECURE',
      'CONVO_SMTP_USERNAME',
    ]) {
      expect(codes).toContain(`${field}:required`);
    }
    for (const issue of issues) expect(issue.message).not.toContain(secret);
  });

  it.each(['0', '465.5', '65536', 'not-a-port'])('rejects SMTP port %s', (port) => {
    const { codes } = read({ ...PRODUCTION, ...SMTP, CONVO_SMTP_PORT: port });
    expect(codes).toContain('CONVO_SMTP_PORT:out_of_range');
  });

  it.each(['', 'yes', 'TRUE', '1'])('requires an explicit SMTP secure boolean: %s', (secure) => {
    const { codes } = read({ ...PRODUCTION, ...SMTP, CONVO_SMTP_SECURE: secure });
    expect(codes).toContain(
      secure === '' ? 'CONVO_SMTP_SECURE:required' : 'CONVO_SMTP_SECURE:invalid_boolean',
    );
  });

  it('refuses STARTTLS mode on implicit-TLS port 465', () => {
    const { codes } = read({ ...PRODUCTION, ...SMTP, CONVO_SMTP_SECURE: 'false' });
    expect(codes).toContain('CONVO_SMTP_SECURE:required_for_port_465');
  });

  it('allows explicit STARTTLS negotiation on a submission port', () => {
    const { issues } = read({ ...PRODUCTION, ...SMTP, CONVO_SMTP_PORT: '587', CONVO_SMTP_SECURE: 'false' });
    expect(issues).toHaveLength(0);
  });
});

describe('a process that does not consume email', () => {
  it('always binds the refusing adapter and ignores provider-only fields', () => {
    const { config, issues } = read(
      {
        ...PRODUCTION,
        CONVO_EMAIL_PROVIDER: 'resend',
        CONVO_EMAIL_FROM: 'not-an-address',
        CONVO_RESEND_API_KEY: 'short',
      },
      false,
    );
    expect(config).toEqual({ provider: 'disabled', from: '', resendApiKey: '', smtp: EMPTY_SMTP });
    expect(issues).toHaveLength(0);
  });

  it('does not read SMTP credentials or validate SMTP syntax outside worker-integration', () => {
    const { config, issues } = read(
      {
        ...PRODUCTION,
        CONVO_EMAIL_PROVIDER: 'smtp',
        CONVO_EMAIL_FROM: 'not-an-address',
        CONVO_SMTP_HOST: '',
        CONVO_SMTP_PORT: 'not-a-port',
        CONVO_SMTP_SECURE: 'not-a-boolean',
        CONVO_SMTP_USERNAME: 'operator',
        CONVO_SMTP_PASSWORD: 'secret',
      },
      false,
    );
    expect(config).toEqual({ provider: 'disabled', from: '', resendApiKey: '', smtp: EMPTY_SMTP });
    expect(issues).toHaveLength(0);
  });
});

describe('the sending identity', () => {
  it.each([
    'ops@digital-school.example',
    'Digital School <ops@digital-school.example>',
    'Digital School Operations <a.b+c@mail.digital-school.example>',
  ])('accepts %s', (value) => {
    expect(isSendingIdentity(value)).toBe(true);
  });

  it.each([
    '',
    'ops',
    'ops@localhost',
    'ops@digital-school',
    'two addresses@a.example, b@b.example',
    '<ops@digital-school.example>extra',
    'Name <not-an-address>',
  ])('refuses %s', (value) => {
    expect(isSendingIdentity(value)).toBe(false);
  });
});

describe('the sender and key readers, in isolation', () => {
  it('refuses a malformed sender with a message naming both accepted shapes', () => {
    const { codes, issues } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'ops@localhost',
      CONVO_RESEND_API_KEY: KEY,
    });
    expect(codes).toContain('CONVO_EMAIL_FROM:malformed');
    expect(issues.find((issue) => issue.field === 'CONVO_EMAIL_FROM')?.message).toContain(
      'Display Name',
    );
  });

  it('returns an empty sender when it refuses one, so nothing downstream uses it', () => {
    const { config } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'nonsense',
      CONVO_RESEND_API_KEY: KEY,
    });
    expect(config.from).toBe('');
  });

  it('returns an empty key when it refuses one', () => {
    const { config } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: 'ops@digital-school.example',
      CONVO_RESEND_API_KEY: 'short',
    });
    expect(config.resendApiKey).toBe('');
  });

  it('treats whitespace-only values as absent rather than as present and empty', () => {
    const { codes } = read({
      ...PRODUCTION,
      CONVO_EMAIL_PROVIDER: 'resend',
      CONVO_EMAIL_FROM: '   ',
      CONVO_RESEND_API_KEY: '   ',
    });
    expect(codes).toContain('CONVO_EMAIL_FROM:required');
    expect(codes).toContain('CONVO_RESEND_API_KEY:required');
  });
});

describe('what counts as production', () => {
  it('is NODE_ENV=production and nothing else', () => {
    // A request cannot influence it, and no other spelling enables it.
    for (const value of ['Production', 'prod', 'staging', '']) {
      expect(read({ NODE_ENV: value }).issues).toHaveLength(0);
    }
    expect(read({ NODE_ENV: 'production' }).config.provider).toBe('disabled');
  });
});
