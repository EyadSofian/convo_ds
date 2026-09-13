/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../api/client';
import { createState } from '../state';
import type { AppState } from '../state';
import { loadingScreen, renderGate } from './auth';

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
  expect(element.querySelector('nav, .nav, .header, .app, .inbox, .page')).toBeNull();
  expect(element.textContent).not.toContain('Digital School');
}

describe('while the session is being checked', () => {
  it('shows only a branded wait', () => {
    const state = gate();
    const element = renderGate(state);
    expect(element.className).toBe('gate gate--loading');
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Checking your session');
    expect(element.querySelector('.brand')?.textContent).toBe('CONVO');
    expectNothingProtected(element);
    expect(loadingScreen(gate('ar')).textContent).toContain('جارٍ التحقق من الجلسة');
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
    expectNothingProtected(element);
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
