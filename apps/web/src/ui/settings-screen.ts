import type { MembershipSummary, SessionSummary } from '../api/people.js';
import { h } from '../dom.js';
import { dateFormat, relativeTime } from '../format.js';
import { activeMembership } from '../live/ability.js';
import { openSession } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import {
  badge,
  button,
  emptyState,
  errorState,
  inlineError,
  isolated,
  page,
  panel,
  segmented,
  selectControl,
  skeleton,
} from './parts.js';

/**
 * Settings: this person's account, their view preferences and their sessions.
 *
 * Every control here does something real. The preferences are local by nature;
 * the sessions are read from and revoked on the server. Workspace-wide settings
 * this build has no endpoint for are listed as unavailable rather than drawn as
 * switches that change nothing.
 */
export function renderSettings(state: AppState): HTMLElement {
  const live = state.live;
  // Settings is only drawn inside an open workspace, which has both.
  const membership = activeMembership(live) as MembershipSummary;
  const email = openSession(live).email;
  return page('settings', null, [
    h('div', { class: 'settings-grid' }, [
      panel(t(state, 'حسابك', 'Your account'), [
        h('dl', { class: 'attrgrid' }, [
          h('dt', {}, [t(state, 'البريد الإلكتروني', 'Email')]),
          h('dd', {}, [isolated(email)]),
          h('dt', {}, [t(state, 'الدور', 'Role')]),
          h('dd', {}, [membership.role.name]),
          h('dt', {}, [t(state, 'مساحة العمل', 'Workspace')]),
          h('dd', {}, [membership.tenant.name]),
        ]),
        button({ label: t(state, 'تسجيل الخروج', 'Sign out'), icon: 'logout', act: 'live-signout', small: true, busy: live.busy === 'sign-out' }),
      ]),
      panel(t(state, 'تفضيلات العرض', 'Display preferences'), [
        h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__text' }, [
            h('p', { class: 'setting-row__title', id: 'pref-language' }, [t(state, 'اللغة', 'Language')]),
            h('p', { class: 'setting-row__hint' }, [t(state, 'تنطبق على هذا المتصفح.', 'Applies to this browser.')]),
          ]),
          selectControl({
            value: state.lang,
            act: 'lang',
            ariaLabel: t(state, 'اللغة', 'Language'),
            options: [
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ],
          }),
        ]),
        h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__text' }, [
            h('p', { class: 'setting-row__title' }, [t(state, 'المظهر', 'Theme')]),
            h('p', { class: 'setting-row__hint' }, [t(state, 'يُحفظ على هذا الجهاز فقط.', 'Saved on this device only.')]),
          ]),
          segmented(
            [
              { value: 'light', label: t(state, 'فاتح', 'Light') },
              { value: 'dark', label: t(state, 'داكن', 'Dark') },
            ],
            state.theme,
            'theme-set',
            t(state, 'المظهر', 'Theme'),
          ),
        ]),
        h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__text' }, [
            h('p', { class: 'setting-row__title' }, [t(state, 'القائمة الجانبية', 'Navigation')]),
            h('p', { class: 'setting-row__hint' }, [t(state, 'مطوية تعرض الأيقونات فقط.', 'Collapsed shows icons only.')]),
          ]),
          segmented(
            [
              { value: 'collapsed', label: t(state, 'مطوية', 'Collapsed') },
              { value: 'expanded', label: t(state, 'موسّعة', 'Expanded') },
            ],
            state.navCollapsed ? 'collapsed' : 'expanded',
            'nav-set',
            t(state, 'القائمة الجانبية', 'Navigation'),
          ),
        ]),
      ]),
    ]),
    sessionsPanel(state),
    panel(t(state, 'إعدادات مساحة العمل', 'Workspace settings'), [
      h('ul', { class: 'unavailable-list' }, [
        t(state, 'اسم مساحة العمل والمنطقة الزمنية', 'Workspace name and time zone'),
        t(state, 'ساعات العمل والرد الآلي', 'Business hours and away replies'),
        t(state, 'مدة الاحتفاظ بالبيانات', 'Data retention'),
      ].map((label) => h('li', { class: 'unavailable-list__item' }, [
        h('span', {}, [label]),
        badge(t(state, 'غير متاح في هذا الإصدار', 'Not available in this version'), 'neutral'),
      ]))),
    ], { description: t(state, 'لا تتوفر لهذه الإعدادات واجهة حفظ على الخادم بعد، لذلك لا تُعرض كعناصر تحكم.', 'These settings have no server endpoint yet, so they are not shown as controls.') }),
  ]);
}

function sessionsPanel(state: AppState): HTMLElement {
  const live = state.live;
  const resource = live.sessions;
  return panel(
    t(state, 'الجلسات النشطة', 'Active sessions'),
    [
      inlineError(state, live.error),
      resource.status === 'idle' || resource.status === 'loading'
        ? skeleton(state, 2)
        : resource.status === 'error'
          ? errorState(state, resource.error, 'live-sessions-reload')
          : resource.value.length === 0
            ? emptyState({ icon: 'device', title: t(state, 'لا توجد جلسات', 'No sessions'), body: t(state, 'لا توجد جلسات نشطة أخرى.', 'There are no other active sessions.') })
            : h('ul', { class: 'session-list' }, resource.value.map((session) => sessionRow(state, session))),
    ],
    {
      flush: resource.status === 'ready' && resource.value.length > 0,
      description: t(state, 'إنهاء جلسة يسجّل خروج ذلك المتصفح فورًا.', 'Ending a session signs that browser out immediately.'),
    },
  );
}

function sessionRow(state: AppState, session: SessionSummary): HTMLElement {
  const live = state.live;
  const format = dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' });
  return h('li', { class: 'session', 'data-session': session.id }, [
    h('div', { class: 'session__text' }, [
      h('p', { class: 'session__title' }, [
        session.current ? t(state, 'هذا المتصفح', 'This browser') : t(state, 'متصفح آخر', 'Another browser'),
        session.current ? badge(t(state, 'الحالية', 'Current'), 'accent') : null,
      ]),
      h('p', { class: 'session__meta' }, [
        t(state, `آخر نشاط ${relativeTime(session.last_seen_at, state.clock, state.lang)} · بدأت ${format.format(new Date(session.created_at))} · تنتهي ${format.format(new Date(session.expires_at))}`,
          `Active ${relativeTime(session.last_seen_at, state.clock, state.lang)} · started ${format.format(new Date(session.created_at))} · expires ${format.format(new Date(session.expires_at))}`),
      ]),
    ]),
    session.current
      ? null
      : button({
          label: t(state, 'إنهاء الجلسة', 'End session'),
          act: 'live-revoke-session',
          arg: session.id,
          small: true,
          variant: 'danger',
          busy: live.busy === `revoke-session:${session.id}`,
        }),
  ]);
}
