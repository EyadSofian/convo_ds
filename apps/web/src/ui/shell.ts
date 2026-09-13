import { h } from '../dom.js';
import { initials } from '../format.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import { activeMembership, allowedScreens } from '../live/ability.js';
import { openSession, rowsOf } from '../live/store.js';
import type { ScreenId } from '../router.js';
import { formatHash } from '../router.js';
import type { AppState } from '../state.js';
import { screenTitle } from '../state.js';
import { logomark } from './brand.js';
import { t } from './copy.js';
import { button } from './parts.js';

/**
 * The application frame: navigation, header and the screen area.
 *
 * Only ever drawn for a signed-in member of an active company — `app.ts`
 * renders the gate otherwise — so everything here may assume a session and a
 * tenant, and nothing here is visible to a visitor.
 */

const NAV_ICONS: Readonly<Record<ScreenId, IconName>> = {
  inbox: 'inbox',
  contacts: 'contacts',
  channels: 'channels',
  people: 'people',
  broadcasts: 'broadcasts',
  analytics: 'analytics',
  settings: 'settings',
};

export function renderShell(state: AppState, screen: HTMLElement): HTMLElement {
  return h(
    'div',
    {
      class: 'app',
      'data-nav': state.navCollapsed ? 'collapsed' : 'expanded',
      'data-drawer': state.navOpen ? 'open' : 'closed',
    },
    [
      h('button', { type: 'button', class: 'skip-link', 'data-act': 'skip-to-content' }, [
        t(state, 'تخطَّ إلى المحتوى', 'Skip to content'),
      ]),
      renderNav(state),
      state.navOpen
        ? h('button', {
            type: 'button',
            class: 'nav-scrim',
            'data-act': 'nav-drawer-close',
            'data-scrim': 'true',
            tabindex: '-1',
            'aria-label': t(state, 'إغلاق القائمة', 'Close navigation'),
          })
        : null,
      h('div', { class: 'app__main' }, [
        renderHeader(state),
        h('main', { class: 'app__screen', id: 'main', tabindex: '-1' }, [screen]),
      ]),
    ],
  );
}

/* ------------------------------------------------------------ navigation -- */

function renderNav(state: AppState): HTMLElement {
  const live = state.live;
  const unread = rowsOf(live.conversations).filter((conversation) => conversation.unread === true).length;
  // At narrow widths the drawer always shows labels: it opens because somebody
  // asked where to go, and a column of bare icons would not answer.
  const collapsed = state.navCollapsed && !state.navOpen;
  return h(
    'nav',
    {
      class: 'nav',
      id: 'primary-nav',
      'aria-label': t(state, 'التنقل الرئيسي', 'Primary navigation'),
      'data-trap': state.navOpen ? 'nav' : undefined,
    },
    [
      h('div', { class: 'nav__head' }, [
        logomark('sm'),
        h('span', { class: 'nav__wordmark' }, ['CONVO']),
        state.navOpen
          ? button({
              icon: 'close',
              act: 'nav-drawer-close',
              variant: 'ghost',
              small: true,
              title: t(state, 'إغلاق القائمة', 'Close navigation'),
              extraClass: 'nav__close',
            })
          : null,
      ]),
      h(
        'ul',
        { class: 'nav__list' },
        allowedScreens(live).map((screen) => {
          const title = screenTitle(screen, state.lang);
          const current = state.route.screen === screen;
          return h('li', {}, [
            h(
              'a',
              {
                class: 'nav__item',
                href: formatHash({ screen, conversationId: null, params: {} }),
                'data-act': 'nav',
                'data-arg': screen,
                'data-label': title,
                'aria-current': current ? 'page' : undefined,
                'aria-label': collapsed ? title : undefined,
              },
              [
                icon(NAV_ICONS[screen], 18),
                h('span', { class: 'nav__label' }, [title]),
                screen === 'inbox' && unread > 0
                  ? h('span', { class: 'nav__badge', 'aria-label': t(state, `${String(unread)} غير مقروءة`, `${String(unread)} unread`) }, [String(unread)])
                  : null,
              ],
            ),
          ]);
        }),
      ),
      h('div', { class: 'nav__foot' }, [
        h(
          'button',
          {
            type: 'button',
            class: 'nav__toggle',
            'data-act': 'nav-collapse',
            'aria-expanded': String(!state.navCollapsed),
            'aria-controls': 'primary-nav',
            'aria-label': state.navCollapsed
              ? t(state, 'توسيع القائمة', 'Expand navigation')
              : t(state, 'طي القائمة', 'Collapse navigation'),
            'data-label': state.navCollapsed ? t(state, 'توسيع', 'Expand') : t(state, 'طي', 'Collapse'),
          },
          [
            icon('sidebar', 18),
            h('span', { class: 'nav__label' }, [t(state, 'طي القائمة', 'Collapse')]),
          ],
        ),
      ]),
    ],
  );
}

/* ---------------------------------------------------------------- header -- */

function renderHeader(state: AppState): HTMLElement {
  const live = state.live;
  const membership = activeMembership(live);
  const email = openSession(live).email;
  return h('header', { class: 'header' }, [
    button({
      icon: 'menu',
      act: 'nav-drawer',
      variant: 'ghost',
      title: t(state, 'فتح القائمة', 'Open navigation'),
      expanded: state.navOpen,
      controls: 'primary-nav',
      extraClass: 'header__menu',
    }),
    h('div', { class: 'header__titles' }, [
      h('h1', { class: 'header__title' }, [screenTitle(state.route.screen, state.lang)]),
      membership === null ? null : tenantControl(state, membership.tenant.name),
    ]),
    h('div', { class: 'header__tools' }, [
      button({
        label: state.lang === 'ar' ? 'EN' : 'ع',
        act: 'lang',
        arg: state.lang === 'ar' ? 'en' : 'ar',
        variant: 'ghost',
        small: true,
        title: t(state, 'English', 'العربية'),
        extraClass: 'lang-toggle',
      }),
      button({
        icon: state.theme === 'light' ? 'moon' : 'sun',
        act: 'theme',
        variant: 'ghost',
        small: true,
        title: state.theme === 'light' ? t(state, 'الوضع الداكن', 'Dark theme') : t(state, 'الوضع الفاتح', 'Light theme'),
        extraClass: 'theme-toggle',
      }),
      h('div', { class: 'menu-anchor' }, [
        h(
          'button',
          {
            type: 'button',
            class: 'user-button',
            'data-act': 'menu',
            'data-arg': 'user',
            'aria-haspopup': 'menu',
            'aria-expanded': String(state.openMenu === 'user'),
            'aria-controls': 'user-menu',
            'aria-label': t(state, `حسابك: ${email}`, `Your account: ${email}`),
          },
          [
            h('span', { class: 'avatar avatar--sm', 'aria-hidden': 'true' }, [initials(email.split('@')[0] as string)]),
            icon('chevronDown', 14),
          ],
        ),
        state.openMenu === 'user' ? userMenu(state, email, membership?.role.name ?? null) : null,
      ]),
    ]),
  ]);
}

/**
 * The company name, and a real switcher only when there is something to switch.
 *
 * A single-company user sees the name as text. A switcher with one entry would
 * be a control that does nothing.
 */
function tenantControl(state: AppState, name: string): HTMLElement {
  const live = state.live;
  const { memberships, tenantId } = openSession(live);
  if (memberships.length < 2) {
    return h('span', { class: 'header__tenant' }, [icon('building', 14), h('span', {}, [name])]);
  }
  return h('div', { class: 'menu-anchor' }, [
    h(
      'button',
      {
        type: 'button',
        class: 'header__tenant header__tenant--switch',
        'data-act': 'menu',
        'data-arg': 'tenant',
        'aria-haspopup': 'menu',
        'aria-expanded': String(state.openMenu === 'tenant'),
        'aria-label': t(state, `مساحة العمل: ${name}. تبديل`, `Workspace: ${name}. Switch`),
      },
      [icon('building', 14), h('span', {}, [name]), icon('chevronDown', 12)],
    ),
    state.openMenu === 'tenant'
      ? h(
          'div',
          { class: 'menu menu--start', role: 'menu', 'data-overlay': 'menu', 'aria-label': t(state, 'مساحات العمل', 'Workspaces') },
          memberships.map((membership) =>
            h(
              'button',
              {
                type: 'button',
                class: 'menu__item',
                role: 'menuitemradio',
                'aria-checked': String(membership.tenant.id === tenantId),
                'data-act': 'live-tenant-switch',
                'data-arg': membership.tenant.id,
              },
              [
                h('span', { class: 'menu__check', 'aria-hidden': 'true' }, [icon('check', 14)]),
                h('span', { class: 'menu__label' }, [membership.tenant.name]),
                h('span', { class: 'menu__hint' }, [membership.role.name]),
              ],
            ),
          ),
        )
      : null,
  ]);
}

function userMenu(state: AppState, email: string, role: string | null): HTMLElement {
  return h('div', { class: 'menu', id: 'user-menu', role: 'menu', 'data-overlay': 'menu', 'aria-label': t(state, 'الحساب', 'Account') }, [
    h('div', { class: 'menu__header', role: 'presentation' }, [
      h('p', { class: 'menu__email' }, [h('bdi', {}, [email])]),
      role === null ? null : h('p', { class: 'menu__role' }, [role]),
    ]),
    h('div', { class: 'menu__separator', role: 'separator' }),
    h('button', { type: 'button', class: 'menu__item', role: 'menuitem', 'data-act': 'nav', 'data-arg': 'settings' }, [
      icon('settings', 16),
      h('span', { class: 'menu__label' }, [t(state, 'الإعدادات والجلسات', 'Settings & sessions')]),
    ]),
    h(
      'button',
      {
        type: 'button',
        class: 'menu__item menu__item--danger',
        role: 'menuitem',
        'data-act': 'live-signout',
        disabled: state.live.busy === 'sign-out',
      },
      [icon('logout', 16), h('span', { class: 'menu__label' }, [t(state, 'تسجيل الخروج', 'Sign out')])],
    ),
  ]);
}

/* ---------------------------------------------------------------- toasts -- */

export function renderToasts(state: AppState): HTMLElement | null {
  if (state.toasts.length === 0) return null;
  return h(
    'div',
    { class: 'toasts', role: 'status', 'aria-live': 'polite' },
    state.toasts.map((toast) =>
      h('div', { class: `toast toast--${toast.tone}` }, [
        icon(toast.tone === 'default' ? 'check' : 'alert', 16),
        h('span', { class: 'toast__text' }, [toast.text]),
        h(
          'button',
          {
            type: 'button',
            class: 'toast__close',
            'data-act': 'toast',
            'data-arg': toast.id,
            'aria-label': t(state, 'إغلاق التنبيه', 'Dismiss'),
          },
          [icon('close', 14)],
        ),
      ]),
    ),
  );
}
