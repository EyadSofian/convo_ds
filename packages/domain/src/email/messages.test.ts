import { describe, expect, it } from 'vitest';
import {
  invitationUrl,
  recoveryUrl,
  renderInvitationEmail,
  renderRecoveryEmail,
  type EmailLocale,
} from './messages.js';

const BASE = 'https://ops.digital-school.example';
const EXPIRES = new Date('2026-03-04T09:30:00.000Z');

function invitation(locale: EmailLocale, workspaceName = 'Digital School') {
  return renderInvitationEmail({
    locale,
    publicBaseUrl: BASE,
    installationName: 'Digital School Operations',
    workspaceName,
    roleName: 'Agent',
    token: 'tok_abc-123',
    expiresAt: EXPIRES,
  });
}

function recovery(locale: EmailLocale) {
  return renderRecoveryEmail({
    locale,
    publicBaseUrl: BASE,
    installationName: 'Digital School Operations',
    token: 'tok_abc-123',
    expiresAt: EXPIRES,
  });
}

describe('email link construction', () => {
  it('derives every link from the configured public base URL', () => {
    expect(invitationUrl(BASE, 'abc')).toBe(`${BASE}/#/accept-invitation?token=abc`);
    expect(recoveryUrl(BASE, 'abc')).toBe(`${BASE}/#/reset-password?token=abc`);
  });

  it('never emits a double slash when the base URL carries a trailing one', () => {
    expect(invitationUrl('https://x.example/', 'abc')).toBe('https://x.example/#/accept-invitation?token=abc');
  });

  it('url-encodes the token so a token is never able to add a query parameter', () => {
    expect(recoveryUrl(BASE, 'a&b=c')).toBe(`${BASE}/#/reset-password?token=a%26b%3Dc`);
  });
});

describe.each(['ar', 'en'] as const)('rendered in %s', (locale) => {
  it('carries the link in both the HTML and the plain-text part', () => {
    const rendered = invitation(locale);
    const url = invitationUrl(BASE, 'tok_abc-123');
    expect(rendered.html).toContain(url);
    expect(rendered.text).toContain(url);
  });

  it('declares the right direction and language on the document', () => {
    const rendered = recovery(locale);
    expect(rendered.html).toContain(`lang="${locale}"`);
    expect(rendered.html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
  });

  it('states the expiry in UTC so it cannot be read three hours wrong', () => {
    expect(invitation(locale).html).toContain('UTC');
    expect(recovery(locale).text).toContain('UTC');
  });

  it('names the role and the workspace on an invitation', () => {
    const rendered = invitation(locale);
    expect(rendered.html).toContain('Agent');
    expect(rendered.html).toContain('Digital School');
    expect(rendered.subject).toContain('Digital School');
  });

  it('tells a recovery recipient who did not ask to ignore it', () => {
    const rendered = recovery(locale);
    const ignore = locale === 'ar' ? 'تجاهل هذه الرسالة' : 'ignore this email';
    expect(rendered.text).toContain(ignore);
  });

  it('never prints the bare token outside the link', () => {
    const rendered = recovery(locale);
    // The only occurrences are inside the URL: once in the button href and once
    // in the copy-paste fallback.
    const bare = rendered.text.split(recoveryUrl(BASE, 'tok_abc-123')).join('');
    expect(bare).not.toContain('tok_abc-123');
  });
});

describe('injection safety', () => {
  it('escapes an operator-supplied workspace name rather than emitting markup', () => {
    const rendered = invitation('en', '<img src=x onerror="alert(1)">');
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('keeps the escaped name readable in the plain-text part', () => {
    expect(invitation('en', 'A & B <School>').text).toContain('A & B <School>');
  });
});

describe('the two messages are distinguishable', () => {
  it('uses different subjects and different links', () => {
    expect(invitation('en').subject).not.toBe(recovery('en').subject);
    expect(invitation('en').html).toContain('accept-invitation');
    expect(recovery('en').html).toContain('reset-password');
  });
});
