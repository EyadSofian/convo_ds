import { h } from '../dom.js';
import { initials, relativeTime, toneOf } from '../format.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import { activeMembership, allowedScreens } from '../live/ability.js';
import { openSession, rowsOf } from '../live/store.js';
import type { ScreenId } from '../router.js';
import { formatHash } from '../router.js';
import { routeParamsWithLanguage } from '../state.js';
import type { AppState } from '../state.js';
import { screenTitle } from '../state.js';
import { dsMark } from './brand.js';
import { t } from './copy.js';
import { button } from './parts.js';
import type { Notification } from '../api/notifications.js';

/**
 * The application frame: navigation, header and the screen area.
 *
 * Only ever drawn for a signed-in member of an active company — `app.ts`
 * renders the gate otherwise — so everything here may assume a session and a
 * tenant, and nothing here is visible to a visitor.
 */

const NAV_ICONS: Readonly<Record<ScreenId, IconName>> = {
  'accept-invitation': 'mail',
  'reset-password': 'lock',
  inbox: 'inbox',
  contacts: 'contacts',
  channels: 'plug',
  people: 'users',
  roles: 'shieldUser',
  teams: 'team',
  broadcasts: 'broadcasts',
  automations: 'workflow',
  analytics: 'analytics',
  settings: 'settings',
};

/** Screens under the "User management" heading in the navigation. */
const USER_MANAGEMENT: readonly ScreenId[] = ['people', 'roles', 'teams'];

export function renderShell(state: AppState, screen: HTMLElement): HTMLElement {
  return h(
    'div',
    {
      class: 'app',
      'data-nav': state.navCollapsed ? 'collapsed' : 'expanded',
      'data-drawer': state.navOpen ? 'open' : 'closed',
      // Phone layout: an open conversation takes the whole screen, so the
      // bottom navigation steps aside for the composer.
      'data-thread': state.route.screen === 'inbox' && state.live.openConversationId !== null ? 'open' : 'none',
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
      renderBottomNav(state),
    ],
  );
}

/**
 * The phone's bottom bar: the two destinations an operator lives in, the bell,
 * and everything else behind More (the same drawer the header menu opens).
 * Only screens this membership may open are offered. Hidden above 760px.
 */
function renderBottomNav(state: AppState): HTMLElement {
  const allowed = allowedScreens(state.live);
  const count = state.live.notificationUnreadCount.status === 'ready' ? state.live.notificationUnreadCount.value : 0;
  const destination = (screen: ScreenId): HTMLElement | null => allowed.includes(screen)
    ? h('a', {
        class: 'bottom-nav__item',
        href: formatHash({ screen, conversationId: null, params: routeParamsWithLanguage(state, {}) }),
        'data-act': 'nav',
        'data-arg': screen,
        'aria-current': state.route.screen === screen ? 'page' : undefined,
      }, [icon(NAV_ICONS[screen], 20), h('span', {}, [screenTitle(screen, state.lang)])])
    : null;
  return h('nav', { class: 'bottom-nav', 'aria-label': t(state, 'التنقل السريع', 'Quick navigation') }, [
    destination('inbox'),
    destination('contacts'),
    h('button', {
      type: 'button',
      class: 'bottom-nav__item',
      'data-act': 'notification-toggle',
      'aria-expanded': String(state.openMenu === 'notifications'),
      'aria-controls': 'notification-menu',
    }, [
      h('span', { class: 'bottom-nav__icon' }, [
        icon('bell', 20),
        count > 0 ? h('span', { class: 'bottom-nav__badge', 'aria-hidden': 'true' }, [count > 99 ? '99+' : String(count)]) : null,
      ]),
      h('span', {}, [count > 0
        ? t(state, `الإشعارات (${String(count)})`, `Alerts (${String(count)})`)
        : t(state, 'الإشعارات', 'Alerts')]),
    ]),
    h('button', {
      type: 'button',
      class: 'bottom-nav__item',
      'data-act': 'nav-drawer',
      'aria-expanded': String(state.navOpen),
      'aria-controls': 'primary-nav',
    }, [icon('menu', 20), h('span', {}, [t(state, 'المزيد', 'More')])]),
  ]);
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
        dsMark('sm'),
        h('span', { class: 'nav__wordmark' }, ['DS Omnichannel']),
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
        allowedScreens(live).flatMap((screen, index, screens) => {
          const title = screenTitle(screen, state.lang);
          const current = state.route.screen === screen;
          // The heading goes above the first user-management screen this
          // membership can open, and nowhere if it can open none.
          const heading = USER_MANAGEMENT.includes(screen) && !USER_MANAGEMENT.includes(screens[index - 1] as ScreenId)
            ? h('li', { class: 'nav__group' }, [
                h('span', { class: 'nav__group-label' }, [t(state, 'إدارة المستخدمين', 'User management')]),
              ])
            : null;
          return [heading, h('li', {}, [
            h(
              'a',
              {
                class: 'nav__item',
                href: formatHash({ screen, conversationId: null, params: routeParamsWithLanguage(state, {}) }),
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
          ])].filter((item): item is HTMLLIElement => item !== null);
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
      state.updateAvailable ? button({
        label: t(state, 'تحديث متاح', 'Update available'),
        icon: 'download',
        act: 'app-update',
        variant: 'default',
        small: true,
        title: t(state, 'تحديث التطبيق الآن', 'Reload the latest app'),
        extraClass: 'header__update',
      }) : null,
      statusPill(state),
      renderNotifications(state),
      button({
        label: state.lang === 'ar' ? 'EN' : 'AR',
        icon: 'globe',
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
            h('span', { class: `avatar avatar--sm avatar--tone-${String(toneOf(email))}`, 'aria-hidden': 'true' }, [initials(email.split('@')[0] as string)]),
            icon('chevronDown', 14),
          ],
        ),
        state.openMenu === 'user' ? userMenu(state, email, membership?.role.name ?? null) : null,
      ]),
    ]),
  ]);
}

/**
 * Operational state, in one small pill that never moves the page: the network,
 * then the live stream. It sits in the header rather than above the list, so
 * a reconnect changes a word instead of pushing every row down.
 *
 * It reports; it never gates. Nothing on screen is hidden or reloaded because
 * of what it says.
 */
function statusPill(state: AppState): HTMLElement {
  const words = {
    live: t(state, 'مباشر', 'Live'),
    stale: t(state, 'جارٍ إعادة الاتصال…', 'Reconnecting…'),
    offline: t(state, 'غير متصل', 'Offline'),
    unsupported: t(state, 'بدون تحديث مباشر', 'No live updates'),
    stopped: t(state, 'توقف التحديث', 'Updates stopped'),
  };
  const pill = (status: string, label: string, detail: string | null): HTMLElement => h('p', {
    class: `status-pill status-pill--${status}`,
    'data-realtime': status,
    role: status === 'live' ? undefined : 'status',
    title: detail ?? label,
  }, [
    h('span', { class: 'status-pill__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'status-pill__label' }, [label]),
    detail === null ? null : h('span', { class: 'visually-hidden' }, [detail]),
  ]);
  const realtime = state.live.realtime;
  let current: HTMLElement | null = null;
  if (state.offline) {
    current = pill('offline', words.offline,
      t(state, 'لا يوجد اتصال بالشبكة. ما تراه آخر ما وصل، وسيُستأنف التحديث عند عودة الاتصال.', 'No network. What you see is the last update; live updates resume when you are back online.'));
  } else if (realtime.status === 'live') {
    current = pill('live', words.live, null);
  } else if (realtime.status === 'stale') {
    current = pill('stale', words.stale,
      t(state, 'انقطع التحديث المباشر مؤقتًا. ما تراه آخر ما وصل.', 'Live updates paused. What you see is the last update.'));
  } else if (realtime.status === 'stopped') {
    current = realtime.reason === 'unsupported_browser'
      ? pill('stopped', words.unsupported,
        t(state, 'هذا المتصفح لا يدعم التحديث المباشر. حدّث الصفحة لرؤية الجديد.', 'This browser cannot receive live updates. Refresh to see new activity.'))
      : pill('stopped', words.stopped,
        t(state, 'توقف التحديث المباشر لتغيّر صلاحياتك. حدّث الصفحة.', 'Live updates stopped because your access changed. Refresh.'));
  }
  // The slot is as wide as the widest word it can ever show, whether or not a
  // pill is in it yet, so a state change repaints one word and moves nothing.
  return h('div', { class: 'status-slot' }, [
    ...Object.values(words).map((word) => h('span', { class: 'status-ghost', 'aria-hidden': 'true' }, [
      h('span', { class: 'status-pill__dot' }),
      h('span', { class: 'status-pill__label' }, [word]),
    ])),
    current,
  ]);
}

function notificationTitle(state: AppState, entry: Notification): string {
  switch (entry.kind) {
    case 'new_message': return t(state, 'رسالة عميل جديدة', 'New customer message');
    case 'assignment': return t(state, 'محادثة أُسندت إليك', 'New conversation assigned to you');
    case 'handoff': return t(state, 'طلب تسليم محادثة', 'Handoff request');
    case 'campaign': return t(state, 'تحديث حملة', 'Campaign update');
    case 'automation_failure': return t(state, 'فشل في التشغيل الآلي', 'Automation failure');
  }
}

function renderNotifications(state: AppState): HTMLElement {
  const open = state.openMenu === 'notifications';
  const count = state.live.notificationUnreadCount.status === 'ready'
    ? state.live.notificationUnreadCount.value : 0;
  const resource = state.live.notifications;
  return h('div', { class: 'menu-anchor' }, [
    h('button', {
      type: 'button', class: 'notification-bell', 'data-act': 'notification-toggle',
      'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': 'notification-menu',
      'aria-label': count > 0
        ? t(state, `الإشعارات، ${String(count)} غير مقروءة`, `Notifications, ${String(count)} unread`)
        : t(state, 'الإشعارات', 'Notifications'),
    }, [icon('bell', 19), count > 0 ? h('span', { class: 'notification-bell__badge' }, [count > 99 ? '99+' : String(count)]) : null]),
    open ? h('div', { class: 'menu notification-menu', id: 'notification-menu', role: 'menu', 'data-overlay': 'menu',
      'aria-label': t(state, 'الإشعارات', 'Notifications') }, [
      h('div', { class: 'notification-menu__head' }, [
        h('strong', {}, [t(state, 'الإشعارات', 'Notifications')]),
        h('button', { type: 'button', class: 'notification-menu__all', role: 'menuitem',
          'data-act': 'notification-read-all', disabled: count === 0 }, [t(state, 'تحديد الكل كمقروء', 'Mark all read')]),
      ]),
      resource.status === 'loading' || resource.status === 'idle'
        ? h('p', { class: 'notification-menu__status', role: 'status' }, [t(state, 'جارٍ تحميل الإشعارات…', 'Loading notifications…')])
        : resource.status === 'error'
          ? h('p', { class: 'notification-menu__status', role: 'alert' }, [t(state, 'تعذّر تحميل الإشعارات.', 'Could not load notifications.')])
          : resource.value.length === 0
            ? h('p', { class: 'notification-menu__status' }, [t(state, 'لا توجد إشعارات بعد.', 'No notifications yet.')])
            : h('div', { class: 'notification-menu__list' }, resource.value.map((entry) =>
              h('button', { type: 'button', role: 'menuitem', class: entry.readAt === null ? 'notification-row notification-row--unread' : 'notification-row',
                'data-act': 'notification-open', 'data-arg': entry.id,
                'aria-label': notificationTitle(state, entry),
              }, [
                h('span', { class: 'notification-row__dot', 'aria-hidden': 'true' }),
                h('span', { class: 'notification-row__content' }, [
                  h('span', { class: 'notification-row__title' }, [notificationTitle(state, entry)]),
                  entry.senderName == null ? null : h('span', { class: 'notification-row__sender', dir: 'auto' }, [entry.senderName]),
                  entry.messagePreview == null && (entry.kind !== 'new_message' || entry.senderName == null)
                    ? null
                    : h('span', { class: 'notification-row__preview', dir: 'auto' }, [
                      entry.messagePreview ?? t(state, 'صورة أو مرفق', 'Image or attachment'),
                    ]),
                  h('time', {
                    datetime: entry.createdAt,
                    title: new Date(entry.createdAt).toLocaleString(state.lang === 'ar' ? 'ar-EG' : 'en-US'),
                  }, [relativeTime(entry.createdAt, state.clock, state.lang)]),
                ]),
              ]))),
      state.live.notificationNextCursor === null ? null : h('button', { type: 'button', role: 'menuitem', class: 'notification-menu__more',
        'data-act': 'notification-more', disabled: state.live.busy === 'notification-more' }, [t(state, 'تحميل المزيد', 'Load more')]),
      h('div', { class: 'notification-menu__push' }, [
        state.live.pushStatus === 'enabled'
          ? h('span', {}, [t(state, 'تنبيهات هذا الجهاز مفعّلة', 'Device alerts enabled')])
          : state.live.pushStatus === 'checking'
            ? h('span', {}, [t(state, 'جارٍ فحص تنبيهات الجهاز…', 'Checking device alerts…')])
          : h('button', { type: 'button', role: 'menuitem', class: 'notification-menu__more',
              'data-act': 'notification-enable-push', disabled: state.live.pushStatus === 'enabling' || state.live.pushPublicKey === null,
              'aria-busy': state.live.pushStatus === 'enabling' ? 'true' : undefined },
              [state.live.pushStatus === 'enabling'
                ? t(state, 'جارٍ التفعيل…', 'Enabling…')
                : t(state, 'تفعيل تنبيهات الجهاز', 'Enable device alerts')]),
        state.live.pushStatus === 'denied'
          ? h('span', { class: 'notification-menu__hint' }, [t(state, 'رفض المتصفح الإذن. غيّره من إعدادات الموقع.', 'Browser permission was denied. Change it in site settings.')])
          : state.live.pushStatus === 'unavailable'
            ? h('span', { class: 'notification-menu__hint' }, [t(state, 'التنبيهات غير متاحة على هذا الجهاز أو لم تُضبط بعد.', 'Device alerts are unavailable or not configured.')])
            : state.live.pushStatus === 'error'
              ? h('span', { class: 'notification-menu__hint' }, [t(state, 'تعذّر تسجيل هذا الجهاز.', 'Could not register this device.')]) : null,
      ]),
    ]) : null,
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
      [icon('building', 14), h('span', {}, [name]), icon('chevronDown', 14)],
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
