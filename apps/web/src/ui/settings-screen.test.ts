/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../api/people';
import { createState } from '../state';
import type { AppState } from '../state';
import { renderSettings } from './settings-screen';

/**
 * Settings: every control here does something real, and the workspace settings
 * this build cannot save are listed as unavailable instead of drawn as switches.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

function screen(lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = {
    status: 'signed_in', email: 'hana@school.example', tenantId: 't',
    memberships: [{ id: 'm', tenant: { id: 't', name: 'Digital School', slug: 'digital-school' }, role: { id: 'r', key: 'agent', name: 'Agent' }, permissions: [] }],
  };
  return state;
}

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return { id: 's-1', created_at: '2026-09-08T08:00:00.000Z', last_seen_at: '2026-09-09T09:20:00.000Z', expires_at: '2026-09-22T08:00:00.000Z', current: false, ...overrides };
}

describe('settings', () => {
  it('shows the account from the session, with a real sign-out', () => {
    const root = renderSettings(screen());
    expect(root.textContent).toContain('hana@school.example');
    expect(root.textContent).toContain('Agent');
    expect(root.textContent).toContain('Digital School');
    expect(root.textContent).not.toContain('digital-school');
    expect(root.querySelector('[data-act="live-signout"]')).not.toBeNull();
  });

  it('offers language, theme and navigation as preferences that take effect', () => {
    const state = screen();
    state.theme = 'dark';
    state.navCollapsed = false;
    const root = renderSettings(state);
    expect((root.querySelector('select[data-act="lang"]') as HTMLSelectElement).value).toBe('en');
    expect(root.querySelector('[data-act="theme-set"][aria-pressed="true"]')?.getAttribute('data-arg')).toBe('dark');
    expect(root.querySelector('[data-act="nav-set"][aria-pressed="true"]')?.getAttribute('data-arg')).toBe('expanded');
    state.navCollapsed = true;
    expect(renderSettings(state).querySelector('[data-act="nav-set"][aria-pressed="true"]')?.getAttribute('data-arg')).toBe('collapsed');
  });

  it('lists workspace settings without a server endpoint as unavailable, not as controls', () => {
    const root = renderSettings(screen());
    const unavailable = root.querySelector('.unavailable-list') as HTMLElement;
    expect(unavailable.querySelectorAll('li')).toHaveLength(3);
    expect(unavailable.querySelector('input, select, [role="switch"]')).toBeNull();
    expect(root.textContent).not.toContain('demo');
  });

  it('shows sessions loading, refused, empty and listed, with an end control for other sessions only', () => {
    const state = screen();
    state.live.sessions = { status: 'loading' };
    expect(renderSettings(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.sessions = { status: 'idle' };
    expect(renderSettings(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.sessions = { status: 'error', error: { code: 'x', message: 'x', requestId: 'r-1', status: 500, details: [] } };
    expect(renderSettings(state).querySelector('[data-act="live-sessions-reload"]')).not.toBeNull();
    state.live.sessions = { status: 'ready', loadedAt: 1, value: [] };
    expect(renderSettings(state).textContent).toContain('There are no other active sessions.');

    state.live.sessions = { status: 'ready', loadedAt: 1, value: [session({ id: 's-now', current: true }), session({ id: 's-old' })] };
    state.live.busy = 'revoke-session:s-old';
    state.live.error = { code: 'x', message: 'Gone.', requestId: 'r-2', status: 404, details: [] };
    const root = renderSettings(state);
    expect(root.querySelector('[data-session="s-now"]')?.textContent).toContain('This browser');
    expect(root.querySelector('[data-session="s-now"] [data-act="live-revoke-session"]')).toBeNull();
    const end = root.querySelector('[data-session="s-old"] [data-act="live-revoke-session"]') as HTMLButtonElement;
    expect(end.getAttribute('data-arg')).toBe('s-old');
    expect(end.disabled).toBe(true);
    expect(root.textContent).toContain('r-2');
  });

  it('speaks Arabic by default', () => {
    expect(renderSettings(screen('ar')).textContent).toContain('الجلسات النشطة');
  });
});
