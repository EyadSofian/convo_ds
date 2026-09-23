/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { MembershipSummary } from '../api/people';
import type { Conversation } from '../api/conversations';
import { createState, pushToast } from '../state';
import type { AppState } from '../state';
import { renderShell, renderToasts } from './shell';

const NOW = new Date('2026-09-09T09:30:00.000Z');

const EVERYTHING = ['conversation.read', 'contact.read', 'channel.manage', 'member.manage', 'campaign.read', 'report.read'];

function membership(id: string, tenant: string, permissions: readonly string[], role = 'Admin'): MembershipSummary {
  return { id, tenant: { id: `t-${id}`, name: tenant, slug: tenant.toLowerCase().replace(/\s/g, '-') }, role: { id: 'r', key: 'admin', name: role }, permissions };
}

function signedIn(permissions: readonly string[] = EVERYTHING, extra: readonly MembershipSummary[] = []): AppState {
  const state = createState(NOW);
  state.lang = 'en';
  const own = membership('m-1', 'Digital School', permissions);
  state.live.session = { status: 'signed_in', email: 'hana@digital-school.example', memberships: [own, ...extra], tenantId: own.tenant.id };
  return state;
}

function screen(): HTMLElement {
  const element = document.createElement('div');
  element.textContent = 'screen';
  return element;
}

describe('navigation', () => {
  it('offers only the screens this membership can open, with Settings always last', () => {
    const shell = renderShell(signedIn(['report.read']), screen());
    const items = Array.from(shell.querySelectorAll('.nav__item')).map((item) => item.getAttribute('data-arg'));
    expect(items).toEqual(['analytics', 'settings']);
  });

  it('names every item when collapsed and marks the current one', () => {
    const state = signedIn();
    state.route = { screen: 'channels', conversationId: null, params: {} };
    const shell = renderShell(state, screen());
    expect(shell.getAttribute('data-nav')).toBe('collapsed');
    const current = shell.querySelector('.nav__item[aria-current="page"]');
    expect(current?.getAttribute('data-arg')).toBe('channels');
    expect(current?.getAttribute('aria-label')).toBe('Channels');
    expect(current?.getAttribute('href')).toBe('#/channels?lang=en');
    expect(shell.querySelector('.nav__toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(shell.querySelector('.nav__toggle')?.getAttribute('aria-label')).toBe('Expand navigation');
  });

  it('shows labels instead of accessible-name overrides when expanded', () => {
    const state = signedIn();
    state.navCollapsed = false;
    const shell = renderShell(state, screen());
    expect(shell.getAttribute('data-nav')).toBe('expanded');
    expect(shell.querySelector('.nav__item')?.getAttribute('aria-label')).toBeNull();
    expect(shell.querySelector('.nav__toggle')?.getAttribute('aria-label')).toBe('Collapse navigation');
  });

  it('becomes a modal drawer with its own close control and scrim', () => {
    const state = signedIn();
    const closed = renderShell(state, screen());
    expect(closed.querySelector('.nav')?.hasAttribute('data-trap')).toBe(false);
    expect(closed.querySelector('.nav-scrim')).toBeNull();
    state.navOpen = true;
    const open = renderShell(state, screen());
    expect(open.getAttribute('data-drawer')).toBe('open');
    expect(open.querySelector('.nav')?.getAttribute('data-trap')).toBe('nav');
    expect(open.querySelector('.nav__close')).not.toBeNull();
    expect(open.querySelector('.nav-scrim')?.getAttribute('data-act')).toBe('nav-drawer-close');
    // Labels are always shown in the drawer, even when the rail is collapsed.
    expect(open.querySelector('.nav__item')?.getAttribute('aria-label')).toBeNull();
    expect(open.querySelector('.header__menu')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('counts unread conversations on the Inbox item', () => {
    const state = signedIn();
    const conversations = [{ unread: true }, { unread: false }, { unread: true }] as unknown as readonly Conversation[];
    state.live.conversations = { status: 'ready', loadedAt: 1, value: conversations };
    const shell = renderShell(state, screen());
    expect(shell.querySelector('.nav__badge')?.textContent).toBe('2');
    state.live.conversations = { status: 'ready', loadedAt: 1, value: [] };
    expect(renderShell(state, screen()).querySelector('.nav__badge')).toBeNull();
  });
});

describe('header', () => {
  it('shows the page title and the company name, never its slug', () => {
    const shell = renderShell(signedIn(), screen());
    expect(shell.querySelector('h1.header__title')?.textContent).toBe('Inbox');
    expect(shell.querySelector('.header__tenant')?.textContent).toBe('Digital School');
    expect(shell.textContent).not.toContain('digital-school');
    expect(shell.textContent).not.toContain('workspace.');
    expect(shell.querySelector('main#main')?.textContent).toBe('screen');
  });

  it('has no role selector of any kind', () => {
    const shell = renderShell(signedIn(), screen());
    expect(shell.querySelector('[data-act="role"]')).toBeNull();
    expect(shell.textContent).not.toContain('View as');
    expect(shell.textContent).not.toContain('اعرض كـ');
  });

  it('offers a real switcher only when there is another company to switch to', () => {
    const state = signedIn(EVERYTHING, [membership('m-2', 'Noor Retail', ['report.read'], 'Analyst')]);
    const closed = renderShell(state, screen());
    const trigger = closed.querySelector('.header__tenant--switch');
    expect(trigger?.getAttribute('data-arg')).toBe('tenant');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    state.openMenu = 'tenant';
    const open = renderShell(state, screen());
    const options = Array.from(open.querySelectorAll('[role="menuitemradio"]'));
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(options[1]?.getAttribute('data-act')).toBe('live-tenant-switch');
    expect(options[1]?.textContent).toContain('Analyst');
  });

  it('opens a user menu with the account, Settings and a real sign-out', () => {
    const state = signedIn();
    const closed = renderShell(state, screen());
    expect(closed.querySelector('.user-button')?.getAttribute('aria-expanded')).toBe('false');
    expect(closed.querySelector('#user-menu')).toBeNull();
    state.openMenu = 'user';
    state.lang = 'ar';
    state.theme = 'dark';
    const open = renderShell(state, screen());
    const menu = open.querySelector('#user-menu');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.textContent).toContain('hana@digital-school.example');
    expect(menu?.textContent).toContain('Admin');
    expect(menu?.querySelector('[data-act="nav"][data-arg="settings"]')).not.toBeNull();
    expect(menu?.querySelector('[data-act="live-signout"]')).not.toBeNull();
    expect(open.querySelector('.lang-toggle')?.getAttribute('data-arg')).toBe('en');
    expect(open.querySelector('.theme-toggle')?.getAttribute('title')).toBe('الوضع الفاتح');
    state.live.busy = 'sign-out';
    expect((renderShell(state, screen()).querySelector('[data-act="live-signout"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws without a membership line when the tenant has none on record', () => {
    const state = signedIn();
    state.live.session = { status: 'signed_in', email: 'x@y.z', memberships: [], tenantId: 't-missing' };
    const shell = renderShell(state, screen());
    expect(shell.querySelector('.header__tenant')).toBeNull();
    state.openMenu = 'user';
    expect(renderShell(state, screen()).querySelector('.menu__role')).toBeNull();
  });
});

describe('toasts', () => {
  it('draws nothing without toasts, and a dismissible toast per tone', () => {
    const state = signedIn();
    expect(renderToasts(state)).toBeNull();
    pushToast(state, 'Saved');
    pushToast(state, 'Careful', 'warning');
    const toasts = renderToasts(state);
    expect(toasts?.getAttribute('aria-live')).toBe('polite');
    expect(toasts?.querySelectorAll('.toast')).toHaveLength(2);
    expect(toasts?.querySelector('.toast--warning [data-act="toast"]')?.getAttribute('aria-label')).toBe('Dismiss');
  });
});
