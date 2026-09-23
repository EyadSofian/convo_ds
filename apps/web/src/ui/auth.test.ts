/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../api/client';
import { createState } from '../state';
import type { AppState } from '../state';
import { loadingScreen, renderGate, renderPublicAuth } from './auth';

/**
 * The gate: everything a visitor can see before the server confirms a session.
 * The assertions that matter most are the absences — no navigation, no tenant,
 * no screen.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

function failure(status: number | null, code = 'refused', requestId: string | null = 'req-1'): ApiError {
  return { code, message: 'Refused.', requestId, status, details: [] };
}

function gate(lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  return state;
}

function expectNothingProtected(element: HTMLElement): void {
  expect(element.querySelector('nav, .nav, .header, .inbox, .page')).toBeNull();
  expect(element.textContent).not.toContain('Digital School');
}

describe('while the session is being checked', () => {
  it('shows a data-free route-aware shell', () => {
    const state = gate();
    const element = renderGate(state);
    expect(element.className).toBe('app app--pending');
    expect(element.getAttribute('role')).toBe('status');
    expect(element.textContent).toContain('Checking your session');
    expect(element.querySelector('.app-pending__brand')?.textContent).toBe('DS');
    expect(element.querySelector('.app-pending__identity')?.textContent).toContain('Preparing your workspace');
    expectNothingProtected(element);
    expect(loadingScreen(gate('ar')).textContent).toContain('جارٍ التحقق من الجلسة');
    expect(loadingScreen(gate('ar')).textContent).toContain('نجهّز مساحة عملك');
  });
});

describe('the sign-in page', () => {
  it('is a real form with labelled fields and one heading', () => {
    const state = gate();
    state.live.session = { status: 'signed_out', error: null };
    const element = renderGate(state);
    const form = element.querySelector('form');
    expect(form?.getAttribute('data-submit')).toBe('live-signin');
    expect(element.querySelector('label[for="signin-email"]')?.textContent).toBe('Email');
    expect(element.querySelector('#signin-email')?.getAttribute('autocomplete')).toBe('username');
    expect(element.querySelector('#signin-password')?.getAttribute('type')).toBe('password');
    expect(element.querySelector('#signin-password')?.getAttribute('autocomplete')).toBe('current-password');
    expect(element.querySelectorAll('h1')).toHaveLength(1);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('[data-act="lang"]')).not.toBeNull();
    expect(element.querySelector('[data-act="theme"]')).not.toBeNull();
    expect(element.className).toBe('auth-layout');
    expect(element.querySelector('.auth-visual')).not.toBeNull();
    expect(element.querySelector('.auth-panel')).not.toBeNull();
    expect(element.textContent).toContain('DS Omnichannel');
    expect(element.querySelector('.auth-visual__logo')?.getAttribute('src')).toBe('/brand/digital-school-by-berlitz.png');
    expect(element.textContent).not.toContain('12 new conversations');
    expect(element.querySelectorAll('h1')).toHaveLength(1);
    expect(element.querySelector('.auth-form__forgot')?.getAttribute('href')).toBe('#/reset-password');
    expectNothingProtected(element);
  });

  it('keeps the form direction and document controls correct in Arabic', () => {
    const state = gate('ar');
    state.live.session = { status: 'signed_out', error: null };
    const element = renderGate(state);
    expect(element.getAttribute('dir')).toBe('ltr');
    expect(element.querySelector('.auth-panel')?.getAttribute('dir')).toBe('ar');
    expect(element.querySelector('#signin-email')?.getAttribute('dir')).toBe('ltr');
    expect(element.textContent).toContain('مرحبًا بعودتك');
  });

  it('says a session ended, until the next attempt says something else', () => {
    const state = gate();
    state.live.session = { status: 'signed_out', error: null, expired: true };
    expect(renderGate(state).textContent).toContain('Your session ended');
    state.live.session = { status: 'signed_out', error: failure(401), expired: true };
    expect(renderGate(state).textContent).not.toContain('Your session ended');
  });

  it('gives the same sentence for a wrong email and a wrong password', () => {
    const state = gate();
    state.live.session = { status: 'signed_out', error: failure(401) };
    const element = renderGate(state);
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('The email or password is incorrect.');
    // A refused credential is not something to quote a request id for.
    expect(element.querySelector('.request-id')).toBeNull();
  });

  it('names throttling, an unreachable server, a broken server and a malformed request apart', () => {
    const state = gate();
    const texts = [failure(429), failure(null, 'network', null), failure(503), failure(400)].map((error) => {
      state.live.session = { status: 'signed_out', error };
      return renderGate(state).querySelector('[role="alert"]')?.textContent ?? '';
    });
    expect(texts[0]).toContain('Too many attempts');
    expect(texts[1]).toContain('Can’t reach the server');
    expect(texts[2]).toContain('Sign-in isn’t available right now');
    expect(texts[2]).toContain('req-1');
    expect(texts[3]).toContain('Check the email and password');
  });

  it('marks invalid fields and ties each message to its field', () => {
    const state = gate();
    state.live.session = { status: 'signed_out', error: null };
    state.formErrors = { signinEmail: 'Enter a valid email address.', signinPassword: 'Enter your password.' };
    state.dialogForm = { signinEmail: 'not-an-email' };
    const element = renderGate(state);
    const email = element.querySelector('#signin-email') as HTMLInputElement;
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toBe('signin-email-error');
    expect(email.value).toBe('not-an-email');
    expect(element.querySelector('#signin-email-error')?.textContent).toBe('Enter a valid email address.');
    expect(element.querySelector('#signin-password')?.getAttribute('aria-describedby')).toBe('signin-password-error');
  });

  it('shows the password on request and marks the attempt in flight', () => {
    const state = gate('ar');
    state.live.session = { status: 'signed_out', error: null };
    state.passwordVisible = true;
    state.theme = 'dark';
    state.live.busy = 'sign-in';
    const element = renderGate(state);
    expect(element.querySelector('#signin-password')?.getAttribute('type')).toBe('text');
    expect(element.querySelector('[data-act="password-visibility"]')?.getAttribute('aria-pressed')).toBe('true');
    const submit = element.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('جارٍ الدخول');
    expect(element.querySelector('[data-act="lang"]')?.getAttribute('data-arg')).toBe('en');
  });
});

describe('when the check itself failed', () => {
  it('offers a retry instead of a form, for an unreachable server and a broken one', () => {
    const state = gate();
    state.live.session = { status: 'signed_out', error: null, probeError: failure(null, 'network', null) };
    const offline = renderGate(state);
    expect(offline.querySelector('form')).toBeNull();
    expect(offline.textContent).toContain('Can’t reach the server');
    expect(offline.querySelector('[data-act="live-session-retry"]')).not.toBeNull();
    expectNothingProtected(offline);

    state.live.session = { status: 'signed_out', error: null, probeError: failure(500) };
    state.live.busy = 'session-retry';
    const broken = renderGate(state);
    expect(broken.textContent).toContain('temporarily unavailable');
    expect(broken.textContent).toContain('req-1');
    expect((broken.querySelector('[data-act="live-session-retry"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('signed in with nowhere to go', () => {
  it('says there is no workspace and offers only a sign-out', () => {
    const state = gate();
    state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    const element = renderGate(state);
    expect(element.textContent).toContain('No active workspace');
    expect(element.querySelector('[data-act="live-signout"]')).not.toBeNull();
    expectNothingProtected(element);
    state.live.busy = 'sign-out';
    expect((renderGate(state).querySelector('[data-act="live-signout"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('public invitation and recovery flows', () => {
  const token = 'a'.repeat(43);

  it('renders invitation validation, credential fields and completion without workspace chrome', () => {
    const state = gate();
    state.route = { screen: 'accept-invitation', conversationId: null, params: {} };
    expect(renderPublicAuth(state).textContent).toContain('This link is invalid');
    state.route = { ...state.route, params: { token } };
    state.formErrors = { authPassword: 'Use at least 12 characters.' };
    state.dialogForm = { authPassword: 'secret' };
    state.live.busy = 'live-accept-invitation';
    const form = renderPublicAuth(state);
    expect(form.querySelector('form')?.getAttribute('data-submit')).toBe('live-accept-invitation');
    expect((form.querySelector('#authPassword') as HTMLInputElement).value).toBe('secret');
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expectNothingProtected(form);
    state.authFlowComplete = 'invitation';
    expect(renderPublicAuth(state).textContent).toContain('Invitation accepted');
  });

  it('renders request, token, errors and both recovery success states', () => {
    const state = gate('ar');
    state.route = { screen: 'reset-password', conversationId: null, params: {} };
    state.live.error = failure(500);
    state.formErrors = { recoveryEmail: 'bad' };
    state.dialogForm = { recoveryEmail: 'x' };
    let page = renderPublicAuth(state);
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
    expect(page.querySelector('form')?.getAttribute('data-submit')).toBe('live-request-recovery');
    expect((page.querySelector('#recovery-email') as HTMLInputElement).value).toBe('x');

    state.route = { ...state.route, params: { token } };
    state.live.error = { code: 'bad', message: 'bad', requestId: 'req-x', status: 400, details: [{ code: 'invalid_or_expired', message: 'bad', field: 'token' }] };
    page = renderPublicAuth(state);
    expect(page.textContent).toContain('انتهت صلاحية الرابط');
    expect(page.textContent).toContain('req-x');
    for (const error of [
      { code: 'bad', message: 'bad', requestId: null, status: 429, details: [] },
      { code: 'network', message: 'bad', requestId: null, status: null, details: [] },
      { code: 'bad', message: 'bad', requestId: null, status: 500, details: [] },
    ]) {
      state.live.error = error;
      expect(renderPublicAuth(state).querySelector('[role="alert"]')).not.toBeNull();
    }
    state.live.error = null;
    state.authFlowComplete = 'recovery-request';
    expect(renderPublicAuth(state).textContent).toContain('تحقق من بريدك');
    state.authFlowComplete = 'recovery';
    expect(renderPublicAuth(state).textContent).toContain('تم تغيير كلمة المرور');
  });
});
