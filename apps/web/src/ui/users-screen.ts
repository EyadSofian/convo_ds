import type { Invitation, OwnershipTransfer, Person } from '../api/people.js';
import { h } from '../dom.js';
import { dateFormat } from '../format.js';
import { openSession, rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import {
  adminHead,
  matches,
  memberCell,
  resourceView,
  rowMenu,
  routeTabs,
  scopeSummary,
  searchBox,
  statusBadge,
  teamList,
  teamsOf,
} from './admin-parts.js';
import { t } from './copy.js';
import { button, inlineError, isolated, notice, page } from './parts.js';

/**
 * Users: the workspace's members, and — on its own tab — the invitations that
 * will become members. Roles and teams have their own screens now; this one
 * answers "who is in this workspace, and what can each of them reach".
 *
 * Every action is one the API already offers, reached from the row's menu, and
 * every one is still decided by the server.
 */
export function renderUsers(state: AppState): HTMLElement {
  const live = state.live;
  const tab = state.route.params['tab'] === 'invitations' ? 'invitations' : 'users';
  const pending = rowsOf(live.invitations).filter((invitation) => invitation.status === 'pending').length;
  return page('people', null, [
    adminHead(state, {
      trail: [{ label: t(state, 'إدارة المستخدمين', 'User management') }, { label: t(state, 'المستخدمون', 'Users') }],
      title: t(state, 'المستخدمون', 'Users'),
      titleIcon: 'users',
      subtitle: t(state, 'أدِر أعضاء مساحة العمل وصلاحيات وصولهم.', 'Manage workspace members and access.'),
      actions: [
        button({ icon: 'refresh', act: 'live-reload', small: true, variant: 'ghost', title: t(state, 'تحديث', 'Refresh'), busy: live.people.status === 'loading' }),
        // The route opens this screen only with member.manage.
        button({ label: t(state, 'دعوة مستخدم', 'Invite User'), icon: 'userPlus', act: 'dialog', arg: 'invite', small: true, variant: 'primary' }),
      ],
    }),
    state.dialog === null ? inlineError(state, live.error) : null,
    ownershipOffers(state, live),
    routeTabs(state, t(state, 'أقسام المستخدمين', 'User sections'), 'people', [
      { id: 'users', label: t(state, 'المستخدمون', 'Users'), count: live.people.status === 'ready' ? live.people.value.length : undefined, params: {} },
      { id: 'invitations', label: t(state, 'الدعوات', 'Invitations'), count: live.invitations.status === 'ready' ? pending : undefined, params: { tab: 'invitations' } },
    ], tab),
    h('section', { class: 'admin-panel', role: 'tabpanel', id: `tabpanel-${tab}`, 'aria-labelledby': `tab-${tab}` }, [
      tab === 'users' ? usersPanel(state, live) : invitationsPanel(state, live),
    ]),
  ]);
}

/* ------------------------------------------------------------------ users -- */

function usersPanel(state: AppState, live: LiveState): HTMLElement {
  return h('div', { class: 'admin-panel__body' }, [
    h('div', { class: 'admin-toolbar' }, [
      searchBox(state.userSearch, 'user-search', t(state, 'ابحث بالبريد أو الدور أو الفريق', 'Search email, role or team'), t(state, 'بحث في المستخدمين', 'Search users')),
    ]),
    resourceView(state, live.people, {
      icon: 'users',
      title: t(state, 'لا يوجد مستخدمون', 'No users yet'),
      body: t(state, 'ادعُ زميلًا للبدء.', 'Invite a colleague to get started.'),
    }, (rows) => {
      const visible = rows.filter((person) => matches(state.userSearch, person.email, person.role.name, ...teamsOf(live, person.membership_id).map((team) => team.name)));
      return visible.length === 0
        ? h('p', { class: 'admin-empty-search', role: 'status' }, [t(state, 'لا يوجد مستخدم يطابق البحث.', 'No user matches this search.')])
        : usersTable(state, live, visible);
    }),
  ]);
}

export function usersTable(state: AppState, live: LiveState, rows: readonly Person[], options: { readonly withRole?: boolean } = {}): HTMLElement {
  const withRole = options.withRole ?? true;
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table admin-table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'المستخدم', 'User')]),
        withRole ? h('th', { scope: 'col' }, [t(state, 'الدور', 'Role')]) : null,
        h('th', { scope: 'col' }, [t(state, 'الفرق', 'Teams')]),
        h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
        h('th', { scope: 'col' }, [t(state, 'النطاق', 'Scope')]),
        h('th', { scope: 'col', class: 'admin-table__actions' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراءات', 'Actions')])]),
      ])]),
      h('tbody', {}, rows.map((person) => h('tr', { 'data-membership': person.membership_id }, [
        h('td', { 'data-label': t(state, 'المستخدم', 'User') }, [memberCell(state, person)]),
        withRole ? h('td', { 'data-label': t(state, 'الدور', 'Role') }, [person.role.name]) : null,
        h('td', { 'data-label': t(state, 'الفرق', 'Teams') }, [teamList(state, teamsOf(live, person.membership_id))]),
        h('td', { 'data-label': t(state, 'الحالة', 'Status') }, [statusBadge(state, person.status)]),
        h('td', { 'data-label': t(state, 'النطاق', 'Scope') }, [scopeSummary(state, person.scopes)]),
        h('td', { class: 'admin-table__actions' }, [memberMenu(state, live, person)]),
      ]))),
    ]),
  ]);
}

/**
 * What can be done to one membership. Offered only where the API has the
 * operation; the change-role and ownership options need the lists they depend
 * on, and revoking asks for confirmation first.
 */
export function memberMenu(state: AppState, live: LiveState, person: Person): HTMLElement | null {
  const self = person.email === openSession(live).email;
  const id = person.membership_id;
  const busy = live.busy !== null && live.busy.endsWith(id);
  return rowMenu(state, `member:${id}`, t(state, `إجراءات ${person.email}`, `Actions for ${person.email}`), [
    live.roles.status === 'ready' ? { label: t(state, 'تغيير الدور', 'Change role'), icon: 'shieldUser', act: 'dialog', arg: `member-role:${id}` } : null,
    live.teams.status === 'ready' ? { label: t(state, 'إدارة الفرق', 'Manage teams'), icon: 'team', act: 'dialog', arg: `member-teams:${id}` } : null,
    person.scopes.some((scope) => scope.type === 'tenant')
      ? null
      : { label: t(state, 'منح نطاق مساحة العمل', 'Grant workspace scope'), icon: 'target', act: 'live-scope-tenant', arg: id, disabled: busy },
    person.status === 'active'
      ? { label: t(state, 'إيقاف مؤقت', 'Suspend'), icon: 'pause', act: 'live-status', arg: `${id}:suspended`, disabled: busy || self }
      : person.status === 'suspended'
        ? { label: t(state, 'إعادة التفعيل', 'Reactivate'), icon: 'play', act: 'live-status', arg: `${id}:active`, disabled: busy }
        : null,
    self || person.status !== 'active'
      ? null
      : { label: t(state, 'نقل الملكية…', 'Transfer ownership…'), icon: 'key', act: 'dialog', arg: `ownership-offer:${id}` },
    person.status === 'revoked' || self
      ? null
      : { label: t(state, 'إلغاء العضوية…', 'Revoke access…'), icon: 'trash', act: 'dialog', arg: `member-revoke:${id}`, danger: true },
  ]);
}

/* ------------------------------------------------------------ invitations -- */

function invitationsPanel(state: AppState, live: LiveState): HTMLElement {
  return h('div', { class: 'admin-panel__body' }, [
    resourceView(state, live.invitations, {
      icon: 'mail',
      title: t(state, 'لا توجد دعوات', 'No invitations'),
      body: t(state, 'تظهر هنا الدعوات المرسلة وحالتها.', 'Sent invitations and their status appear here.'),
      action: { label: t(state, 'دعوة مستخدم', 'Invite User'), act: 'dialog', arg: 'invite', primary: true },
    }, (rows) => invitationTable(state, live, rows)),
  ]);
}

function invitationTable(state: AppState, live: LiveState, rows: readonly Invitation[]): HTMLElement {
  const format = dateFormat(state.lang, { dateStyle: 'medium' });
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table admin-table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'البريد', 'Email')]),
        h('th', { scope: 'col' }, [t(state, 'الدور', 'Role')]),
        h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
        h('th', { scope: 'col' }, [t(state, 'أُنشئت', 'Created')]),
        h('th', { scope: 'col' }, [t(state, 'تنتهي', 'Expires')]),
        h('th', { scope: 'col', class: 'admin-table__actions' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراء', 'Action')])]),
      ])]),
      h('tbody', {}, rows.map((invitation) => h('tr', { 'data-invitation': invitation.id }, [
        h('td', { 'data-label': t(state, 'البريد', 'Email') }, [isolated(invitation.email)]),
        h('td', { 'data-label': t(state, 'الدور', 'Role') }, [invitation.role.name]),
        h('td', { 'data-label': t(state, 'الحالة', 'Status') }, [statusBadge(state, invitation.status)]),
        h('td', { 'data-label': t(state, 'أُنشئت', 'Created') }, [format.format(new Date(invitation.created_at))]),
        h('td', { 'data-label': t(state, 'تنتهي', 'Expires') }, [invitation.status === 'pending' ? format.format(new Date(invitation.expires_at)) : '—']),
        h('td', { class: 'admin-table__actions' }, [
          invitation.status === 'pending'
            ? button({
                label: t(state, 'إلغاء الدعوة', 'Revoke'),
                icon: 'close',
                act: 'live-revoke-invite',
                arg: invitation.id,
                small: true,
                variant: 'ghost',
                busy: live.busy === `revoke-invite:${invitation.id}`,
              })
            : null,
        ]),
      ]))),
    ]),
  ]);
}

/* -------------------------------------------------------------- ownership -- */

/**
 * Ownership offers awaiting a decision, where the people they concern will see
 * them. Starting one is a row action; only pending offers are shown here.
 */
function ownershipOffers(state: AppState, live: LiveState): HTMLElement | null {
  const pending = rowsOf(live.transfers).filter((transfer) => transfer.status === 'pending');
  if (pending.length === 0) return null;
  return notice('info', 'key',
    h('p', { class: 'notice__title' }, [t(state, 'نقل ملكية بانتظار القرار', 'Ownership transfer awaiting a decision')]),
    h('p', {}, [t(state, 'يكتمل النقل بقبول المستلم فقط. المستلم يقبل أو يرفض، ومن أرسل العرض يلغيه.', 'It completes only when the recipient accepts. The recipient accepts or declines; the sender can cancel.')]),
    h('ul', { class: 'transfer-list' }, pending.map((transfer) => transferRow(state, live, transfer))),
  );
}

function transferRow(state: AppState, live: LiveState, transfer: OwnershipTransfer): HTMLElement {
  const busy = live.busy === `ownership:${transfer.id}`;
  const recipient = rowsOf(live.people).find((person) => person.membership_id === transfer.to_membership);
  return h('li', { class: 'transfer', 'data-transfer': transfer.id }, [
    h('div', { class: 'transfer__text' }, [
      h('p', { class: 'transfer__title' }, [
        t(state, 'عرض ملكية إلى ', 'Offer to '),
        isolated(recipient?.email ?? transfer.to_membership, recipient === undefined),
      ]),
      h('p', { class: 'transfer__meta' }, [
        `${t(state, 'ينتهي', 'Expires')} ${dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(transfer.expires_at))}`,
      ]),
    ]),
    h('div', { class: 'row-actions' }, [
      button({ label: t(state, 'قبول', 'Accept'), act: 'live-ownership', arg: `${transfer.id}:accept`, small: true, variant: 'primary', disabled: busy }),
      button({ label: t(state, 'رفض', 'Decline'), act: 'live-ownership', arg: `${transfer.id}:decline`, small: true, disabled: busy }),
      button({ label: t(state, 'إلغاء العرض', 'Cancel offer'), act: 'live-ownership', arg: `${transfer.id}:cancel`, small: true, variant: 'ghost', disabled: busy }),
    ]),
  ]);
}
