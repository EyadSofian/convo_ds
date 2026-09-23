import type { MembershipSummary, SessionSummary } from '../api/people.js';
import { h } from '../dom.js';
import { dateFormat, relativeTime } from '../format.js';
import { activeMembership } from '../live/ability.js';
import { hasPermission } from '../live/ability.js';
import { openSession, rowsOf } from '../live/store.js';
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
    h('div', { class: 'settings-sections' }, [
      settingsSection(t(state, 'الحساب', 'Account'), t(state, 'هويتك في DS Omnichannel ومساحة العمل الحالية.', 'Your DS Omnichannel identity and current workspace.'), [
        settingRow(t(state, 'البريد الإلكتروني', 'Email'), t(state, 'يُدار بواسطة مسؤول الحساب ولا يمكن تغييره هنا.', 'Managed by the account administrator and read-only here.'), isolated(email)),
        settingRow(t(state, 'الدور', 'Role'), t(state, 'صلاحياتك الحالية في مساحة العمل.', 'Your current workspace access.'), badge(membership.role.name, 'neutral')),
        settingRow(t(state, 'مساحة العمل', 'Workspace'), t(state, 'المساحة النشطة الآن.', 'Currently active workspace.'), h('span', {}, [membership.tenant.name])),
        settingRow(t(state, 'الجلسة', 'Session'), t(state, 'إنهاء الجلسة على هذا المتصفح.', 'End the session on this browser.'), button({ label: t(state, 'تسجيل الخروج', 'Sign out'), icon: 'logout', act: 'live-signout', small: true, busy: live.busy === 'sign-out' })),
      ]),
      settingsSection(t(state, 'الأمان', 'Security'), t(state, 'كلمة المرور والجلسات المحمية.', 'Password and protected sessions.'), [
        settingRow(t(state, 'كلمة المرور', 'Password'), t(state, 'تغييرها ينهي كل الجلسات الأخرى.', 'Changing it signs out every other session.'), button({ label: t(state, 'تغيير كلمة المرور', 'Change password'), icon: 'lock', act: 'dialog', arg: 'change-password', small: true })),
      ]),
      settingsSection(t(state, 'المظهر', 'Appearance'), t(state, 'تفضيلات محفوظة على هذا المتصفح.', 'Preferences saved on this browser.'), [
        settingRow(t(state, 'اللغة', 'Language'), t(state, 'لغة واجهة التشغيل.', 'Operator interface language.'), selectControl({ value: state.lang, act: 'lang', ariaLabel: t(state, 'اللغة', 'Language'), options: [{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }] })),
        settingRow(t(state, 'السمة', 'Theme'), t(state, 'اختر فاتحًا أو داكنًا.', 'Choose light or dark.'), segmented([{ value: 'light', label: t(state, 'فاتح', 'Light') }, { value: 'dark', label: t(state, 'داكن', 'Dark') }], state.theme, 'theme-set', t(state, 'المظهر', 'Theme'))),
        settingRow(t(state, 'القائمة الجانبية', 'Navigation'), t(state, 'مطوية تعرض الأيقونات فقط.', 'Collapsed shows icons only.'), segmented([{ value: 'collapsed', label: t(state, 'مطوية', 'Collapsed') }, { value: 'expanded', label: t(state, 'موسّعة', 'Expanded') }], state.navCollapsed ? 'collapsed' : 'expanded', 'nav-set', t(state, 'القائمة الجانبية', 'Navigation'))),
      ]),
    ]),
    sessionsPanel(state),
    hasPermission(live, 'catalog.manage') ? labelsPanel(state) : null,
    settingsSection(t(state, 'إعدادات مساحة العمل', 'Workspace settings'), t(state, 'تظهر الإمكانات غير المتصلة بالخادم كمعلومات فقط.', 'Capabilities without a server endpoint are shown as information only.'), [
      ...[t(state, 'اسم مساحة العمل والمنطقة الزمنية', 'Workspace name and time zone'), t(state, 'ساعات العمل والرد الآلي', 'Business hours and away replies'), t(state, 'مدة الاحتفاظ بالبيانات', 'Data retention')]
        .map((label) => settingRow(label, t(state, 'لا توجد واجهة حفظ لهذا الإعداد بعد.', 'No save endpoint exists for this setting yet.'), badge(t(state, 'غير متاح', 'Unavailable'), 'neutral'))),
    ]),
  ]);
}

function labelsPanel(state: AppState): HTMLElement {
  const resource = state.live.workspaceLabels;
  const labels = rowsOf(resource);
  const active = labels.filter((label) => label.state === 'active');
  const retired = labels.filter((label) => label.state === 'retired');
  const list = (items: readonly typeof labels[number][]): HTMLElement => h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
    h('thead', {}, [h('tr', {}, [h('th', { scope: 'col' }, [t(state, 'اللون', 'Color')]), h('th', { scope: 'col' }, [t(state, 'الاسم', 'Name')]), h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]), h('th', { scope: 'col' }, [t(state, 'إجراءات', 'Actions')])])]),
    h('tbody', {}, items.map((label) => h('tr', {}, [
      h('td', {}, [h('span', { class: 'badge', style: `--label-color:${label.color};border-color:${label.color}` }, [label.color])]),
      h('td', {}, [label.name]),
      h('td', {}, [badge(label.state === 'active' ? t(state, 'نشط', 'Active') : t(state, 'متوقف', 'Retired'), label.state === 'active' ? 'success' : 'neutral')]),
      h('td', {}, [label.state === 'active' ? h('div', { class: 'button-row' }, [button({ label: t(state, 'تعديل', 'Edit'), act: 'dialog', arg: `workspace-label:${label.id}`, small: true, variant: 'ghost' }), button({ label: t(state, 'إيقاف', 'Retire'), act: 'dialog', arg: `retire-label:${label.id}`, small: true, variant: 'danger', busy: state.live.busy === `metadata:retire-label:${label.id}` })]) : h('span', { class: 'muted' }, [t(state, 'محفوظ للتاريخ', 'Kept for history')])]),
    ]))),
  ])]);
  return panel(t(state, 'تصنيفات مساحة العمل', 'Workspace labels'), [
    resource.status === 'idle' || resource.status === 'loading' ? skeleton(state, 2) : resource.status === 'error' ? errorState(state, resource.error, 'live-settings-reload') : active.length === 0 ? emptyState({ icon: 'tag', title: t(state, 'لا توجد تصنيفات نشطة', 'No active labels'), body: t(state, 'أنشئ تصنيفًا لتنظيم المحادثات وجهات الاتصال.', 'Create a label to organize conversations and contacts.') }) : list(active),
    retired.length === 0 ? null : h('div', { class: 'stack stack--sm' }, [h('h3', { class: 'panel__subtitle' }, [t(state, 'متوقفة', 'Retired')]), list(retired)]),
  ], { actions: [button({ label: t(state, 'تصنيف جديد', 'New label'), icon: 'plus', act: 'dialog', arg: 'workspace-label', small: true, variant: 'primary' })], description: t(state, 'إيقاف التصنيف يحفظ السجل ولا يزيله من المحادثات القديمة.', 'Retiring a label preserves historical records and removes it from future selection.') });
}

function settingsSection(title: string, description: string, rows: readonly HTMLElement[]): HTMLElement {
  return h('section', { class: 'settings-section', 'aria-label': title }, [
    h('header', { class: 'settings-section__header' }, [
      h('h2', { class: 'settings-section__title' }, [title]),
      h('p', { class: 'settings-section__description' }, [description]),
    ]),
    h('div', { class: 'settings-section__rows' }, rows),
  ]);
}

function settingRow(label: string, hint: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'setting-row' }, [
    h('div', { class: 'setting-row__text' }, [
      h('p', { class: 'setting-row__title' }, [label]),
      h('p', { class: 'setting-row__hint' }, [hint]),
    ]),
    h('div', { class: 'setting-row__control' }, [control]),
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
