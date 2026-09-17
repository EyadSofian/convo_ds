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

function read(env: Record<string, string | undefined>) {
  const issues: ErrorDetail[] = [];
  const config = readEmailConfig(env, issues);
  return { config, issues, codes: issues.map((issue) => `${issue.field}:${issue.code}`) };
}

const PRODUCTION = { NODE_ENV: 'production' };
const KEY = 're_0123456789abcdefghij';

describe('outside production', () => {
  it('defaults to the logging adapter with no complaint', () => {
    const { config, issues } = read({});
    expect(config.provider).toBe('logging');
    expect(issues).toHaveLength(0);
  });

  it('allows the logging adapter to be chosen explicitly', () => {
    const { config, issues } = read({ CONVO_EMAIL_PROVIDER: 'logging' });
    expect(config.provider).toBe('logging');
    expect(issues).toHaveLength(0);
  });
});

describe('in production', () => {
  it('refuses to start with no provider configured', () => {
    const { codes } = read(PRODUCTION);
    expect(codes).toContain('CONVO_EMAIL_PROVIDER:required');
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
    expect(read({ NODE_ENV: 'production' }).codes).toContain('CONVO_EMAIL_PROVIDER:required');
  });
});
