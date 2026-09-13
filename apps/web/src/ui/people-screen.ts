import type { Invitation, OwnershipTransfer, Person, Role, Team } from '../api/people.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber, initials } from '../format.js';
import { hasPermission } from '../live/ability.js';
import { roleNameField, teamMemberField } from '../live/dispatch.js';
import { openSession, rowsOf } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import type { Phrase } from './copy.js';
import {
  avatar,
  badge,
  button,
  emptyState,
  errorState,
  inlineError,
  isolated,
  kpi,
  notice,
  page,
  panel,
  selectControl,
  skeleton,
  textInput,
  toolbar,
} from './parts.js';
import type { Tone } from './parts.js';

/**
 * People, roles and teams, backed entirely by the API.
 *
 * Every list is a `Resource`, so not-asked, waiting, refused and present each
 * get their own rendering. Every change is disabled while in flight and shows
 * the server's refusal beside the page; no success is drawn before the
 * response commits. Authority is the server's: a control is offered when the
 * membership holds the key, and refused by the endpoint either way.
 */

const STATUS: Readonly<Record<string, { readonly label: Phrase; readonly tone: Tone }>> = {
  active: { label: { ar: 'نشط', en: 'Active' }, tone: 'success' },
  suspended: { label: { ar: 'موقوف', en: 'Suspended' }, tone: 'warning' },
  revoked: { label: { ar: 'ملغى', en: 'Revoked' }, tone: 'neutral' },
  pending: { label: { ar: 'بانتظار القبول', en: 'Pending' }, tone: 'accent' },
  accepted: { label: { ar: 'مقبولة', en: 'Accepted' }, tone: 'success' },
  declined: { label: { ar: 'مرفوضة', en: 'Declined' }, tone: 'neutral' },
  cancelled: { label: { ar: 'ملغاة', en: 'Cancelled' }, tone: 'neutral' },
};

const SCOPE_TYPES: Readonly<Record<string, Phrase>> = {
  tenant: { ar: 'مساحة العمل كلها', en: 'Whole workspace' },
  team: { ar: 'فريق', en: 'Team' },
  inbox: { ar: 'صندوق وارد', en: 'Inbox' },
};

function scopeLabel(state: AppState, type: string): string {
  const view = SCOPE_TYPES[type];
  return view === undefined ? type : t(state, view.ar, view.en);
}

function statusBadge(state: AppState, value: string): HTMLElement {
  const view = STATUS[value];
  return view === undefined ? badge(value, 'neutral') : badge(t(state, view.label.ar, view.label.en), view.tone, { dot: true });
}

export function renderPeople(state: AppState): HTMLElement {
  const live = state.live;
  const manageMembers = hasPermission(live, 'member.manage');
  return page('people', toolbar(
    t(state, 'أدِر أعضاء مساحة العمل وأدوارهم وفرقهم.', 'Manage workspace members, their roles and teams.'),
    [
      button({ label: t(state, 'تحديث', 'Refresh'), icon: 'refresh', act: 'live-reload', small: true, busy: live.people.status === 'loading' }),
      manageMembers ? button({ label: t(state, 'دعوة عضو', 'Invite member'), icon: 'plus', act: 'dialog', arg: 'invite', small: true, variant: 'primary' }) : null,
    ],
  ), [
    summary(state, live),
    state.dialog === null ? inlineError(state, live.error) : null,
    panel(t(state, 'الأعضاء', 'Members'), [resourceView(state, live.people, {
      title: t(state, 'لا يوجد أعضاء', 'No members yet'),
      body: t(state, 'ادعُ زميلًا للبدء.', 'Invite a colleague to get started.'),
    }, (rows) => peopleTable(state, live, rows))], { flush: live.people.status === 'ready' && live.people.value.length > 0 }),
    panel(t(state, 'الدعوات', 'Invitations'), [resourceView(state, live.invitations, {
      title: t(state, 'لا توجد دعوات', 'No invitations'),
      body: t(state, 'تظهر هنا الدعوات المرسلة وحالتها.', 'Sent invitations and their status appear here.'),
    }, (rows) => invitationTable(state, live, rows))], { flush: live.invitations.status === 'ready' && live.invitations.value.length > 0 }),
    h('div', { class: 'report-grid' }, [
      teamsPanel(state, live),
      rolesPanel(state, live),
    ]),
    ownershipPanel(state, live),
  ]);
}

function summary(state: AppState, live: LiveState): HTMLElement {
  const count = (resource: Resource<readonly unknown[]>): string =>
    resource.status === 'ready' ? formatNumber(resource.value.length, state.lang) : '—';
  const pending = rowsOf(live.invitations).filter((invitation) => invitation.status === 'pending').length;
  return h('section', { class: 'kpis kpis--4', 'aria-label': t(state, 'ملخص الفريق', 'Team summary') }, [
    kpi(t(state, 'الأعضاء', 'Members'), count(live.people)),
    kpi(t(state, 'دعوات معلّقة', 'Pending invitations'), live.invitations.status === 'ready' ? formatNumber(pending, state.lang) : '—'),
    kpi(t(state, 'الفرق', 'Teams'), count(live.teams)),
    kpi(t(state, 'الأدوار', 'Roles'), count(live.roles)),
  ]);
}

/**
 * One place that turns a resource into something on screen, so every list
 * behaves the same way when the server is slow, says no, or has nothing.
 */
function resourceView<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: { title: string; body: string },
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') {
    return skeleton(state, 3);
  }
  if (resource.status === 'error') {
    return errorState(state, resource.error, 'live-reload');
  }
  if (resource.value.length === 0) {
    return emptyState({ icon: 'users', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

/* ---------------------------------------------------------------- members -- */

function roleOptions(live: LiveState): readonly { value: string; label: string }[] {
  return rowsOf(live.roles).map((role) => ({ value: role.id, label: role.name }));
}

function peopleTable(state: AppState, live: LiveState, rows: readonly Person[]): HTMLElement {
  const me = openSession(live).email;
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'العضو', 'Member')]),
        h('th', { scope: 'col' }, [t(state, 'الدور', 'Role')]),
        h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
        h('th', { scope: 'col' }, [t(state, 'النطاق', 'Scope')]),
        h('th', { scope: 'col' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراءات', 'Actions')])]),
      ])]),
      h('tbody', {}, rows.map((person) => personRow(state, live, person, person.email === me))),
    ]),
  ]);
}

function personRow(state: AppState, live: LiveState, person: Person, self: boolean): HTMLElement {
  const roleBusy = live.busy === `role:${person.membership_id}`;
  const statusBusy = live.busy === `status:${person.membership_id}`;
  return h('tr', { 'data-membership': person.membership_id }, [
    h('td', {}, [
      h('div', { class: 'member' }, [
        avatar({ initials: initials(person.email.split('@')[0] as string), size: 'sm' }),
        h('div', {}, [
          h('span', { class: 'table__primary' }, [isolated(person.email)]),
          self ? h('span', { class: 'table__sub' }, [t(state, 'أنت', 'You')]) : null,
        ]),
      ]),
    ]),
    h('td', {}, [
      selectControl({
        value: person.role.id,
        act: 'live-role',
        form: person.membership_id,
        ariaLabel: t(state, `دور ${person.email}`, `Role for ${person.email}`),
        disabled: roleBusy || live.roles.status !== 'ready',
        options: roleOptions(live),
      }),
    ]),
    h('td', {}, [
      selectControl({
        value: person.status,
        act: 'live-status',
        form: person.membership_id,
        ariaLabel: t(state, `حالة ${person.email}`, `Status for ${person.email}`),
        disabled: statusBusy,
        options: [
          { value: 'active', label: t(state, 'نشط', 'Active') },
          { value: 'suspended', label: t(state, 'موقوف', 'Suspended') },
          { value: 'revoked', label: t(state, 'ملغى', 'Revoked') },
        ],
      }),
    ]),
    h('td', {}, [
      person.scopes.length === 0
        ? badge(t(state, 'بلا نطاق', 'No scope'), 'warning')
        : h('span', { class: 'badge-row' }, person.scopes.map((scope) => badge(scopeLabel(state, scope.type), 'neutral'))),
    ]),
    h('td', {}, [
      h('div', { class: 'row-actions' }, [
        person.scopes.some((scope) => scope.type === 'tenant')
          ? null
          : button({
              label: t(state, 'منح نطاق مساحة العمل', 'Grant workspace scope'),
              act: 'live-scope-tenant',
              arg: person.membership_id,
              small: true,
              variant: 'ghost',
              busy: live.busy === `scopes:${person.membership_id}`,
            }),
        self || person.status !== 'active'
          ? null
          : button({
              label: t(state, 'نقل الملكية…', 'Transfer ownership…'),
              act: 'dialog',
              arg: `ownership-offer:${person.membership_id}`,
              small: true,
              variant: 'ghost',
            }),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ invitations -- */

function invitationTable(state: AppState, live: LiveState, rows: readonly Invitation[]): HTMLElement {
  const format = dateFormat(state.lang, { dateStyle: 'medium' });
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'البريد', 'Email')]),
        h('th', { scope: 'col' }, [t(state, 'الدور', 'Role')]),
        h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
        h('th', { scope: 'col' }, [t(state, 'تنتهي', 'Expires')]),
        h('th', { scope: 'col' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراء', 'Action')])]),
      ])]),
      h('tbody', {}, rows.map((invitation) => h('tr', {}, [
        h('td', {}, [isolated(invitation.email)]),
        h('td', {}, [invitation.role.name]),
        h('td', {}, [statusBadge(state, invitation.status)]),
        h('td', {}, [invitation.status === 'pending' ? format.format(new Date(invitation.expires_at)) : '—']),
        h('td', {}, [
          invitation.status === 'pending'
            ? button({
                label: t(state, 'إلغاء الدعوة', 'Revoke'),
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

/* ------------------------------------------------------------------ teams -- */

function teamsPanel(state: AppState, live: LiveState): HTMLElement {
  const creating = live.busy === 'create-team';
  const members = rowsOf(live.people).map((person) => ({ value: person.membership_id, label: person.email }));
  return panel(t(state, 'الفرق', 'Teams'), [
    h('form', { class: 'inline-form', 'data-submit': 'live-create-team' }, [
      textInput('teamName', state.dialogForm['teamName'] ?? '', t(state, 'اسم فريق جديد', 'New team name'), { ariaLabel: t(state, 'اسم الفريق', 'Team name') }),
      button({ label: t(state, 'إنشاء', 'Create'), icon: 'plus', act: 'live-create-team', small: true, busy: creating }),
    ]),
    resourceView(state, live.teams, {
      title: t(state, 'لا توجد فرق', 'No teams'),
      body: t(state, 'أنشئ فريقًا لتوجيه المحادثات إليه.', 'Create a team to route conversations to.'),
    }, (rows) => h('ul', { class: 'card-list' }, rows.map((team) => teamCard(state, live, team, members)))),
  ]);
}

function teamCard(state: AppState, live: LiveState, team: Team, candidates: readonly { value: string; label: string }[]): HTMLElement {
  // Somebody already in the team is not a candidate to add to it.
  const inTeam = new Set(team.members.map((member) => member.membership_id));
  const addable = candidates.filter((candidate) => !inTeam.has(candidate.value));
  const settling = live.busy === `archive-team:${team.id}`;
  return h('li', { class: 'mini-card', 'data-team': team.id }, [
    h('div', { class: 'mini-card__head' }, [
      h('h3', { class: 'mini-card__title' }, [team.name]),
      team.archived ? badge(t(state, 'مؤرشف', 'Archived'), 'warning') : null,
      badge(t(state, `${String(team.member_count)} عضو`, `${String(team.member_count)} members`), 'neutral'),
    ]),
    team.members.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا يوجد أعضاء بعد.', 'No members yet.')])
      : h('ul', { class: 'memberlist' }, team.members.map((member) =>
          h('li', { class: 'memberlist__item' }, [
            isolated(member.email),
            button({
              icon: 'close',
              act: 'live-remove-member',
              arg: `${team.id}:${member.membership_id}`,
              small: true,
              variant: 'ghost',
              title: t(state, `إزالة ${member.email} من ${team.name}`, `Remove ${member.email} from ${team.name}`),
              busy: live.busy === `team-remove:${team.id}:${member.membership_id}`,
            }),
          ]),
        )),
    h('div', { class: 'inline-form' }, [
      selectControl({
        value: state.dialogForm[teamMemberField(team.id)] ?? '',
        form: teamMemberField(team.id),
        ariaLabel: t(state, `إضافة عضو إلى ${team.name}`, `Add a member to ${team.name}`),
        // An archived team takes no new members; the server refuses it too.
        disabled: addable.length === 0 || team.archived,
        options: [{ value: '', label: t(state, 'اختر عضوًا', 'Choose a member') }, ...addable],
      }),
      button({ label: t(state, 'إضافة', 'Add'), act: 'live-team-add', arg: team.id, small: true, disabled: team.archived, busy: live.busy === `team-add:${team.id}` }),
      button({
        label: team.archived ? t(state, 'استعادة', 'Restore') : t(state, 'أرشفة', 'Archive'),
        act: 'live-archive-team',
        arg: `${team.id}:${team.archived ? 'restore' : 'archive'}`,
        small: true,
        variant: 'ghost',
        busy: settling,
      }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ roles -- */

/**
 * The keys a custom role may be given, as the server lists them. Only delegable
 * keys appear: offering the rest would be offering a choice that always fails.
 */
function grantOptions(live: LiveState): readonly { value: string; label: string }[] {
  return rowsOf(live.permissions)
    .filter((permission) => permission.delegable)
    .map((permission) => ({ value: permission.key, label: permission.key }));
}

function rolesPanel(state: AppState, live: LiveState): HTMLElement {
  const creating = live.busy === 'create-role';
  const grants = grantOptions(live);
  const chosenGrant = state.dialogForm['roleGrant'] ?? '';
  const chosenScope = state.dialogForm['roleScope'] ?? '';
  return panel(t(state, 'الأدوار', 'Roles'), [
    h('div', { class: 'role-form' }, [
      textInput('roleName', state.dialogForm['roleName'] ?? '', t(state, 'اسم دور مخصّص', 'Custom role name'), { ariaLabel: t(state, 'اسم الدور', 'Role name') }),
      selectControl({
        value: chosenGrant,
        act: 'form-toggle',
        form: 'roleGrant',
        ariaLabel: t(state, 'الصلاحية الأولى', 'First permission'),
        disabled: grants.length === 0,
        options: [{ value: '', label: t(state, 'اختر صلاحية', 'Choose a permission') }, ...grants],
      }),
      selectControl({
        value: chosenScope,
        act: 'form-toggle',
        form: 'roleScope',
        ariaLabel: t(state, 'نطاق الصلاحية', 'Permission scope'),
        options: [
          { value: '', label: t(state, 'اختر نطاقًا', 'Choose a scope') },
          { value: 'tenant', label: t(state, 'مساحة العمل كلها', 'Whole workspace') },
          { value: 'scoped', label: t(state, 'نطاق محدد', 'Scoped') },
          { value: 'own', label: t(state, 'الخاص به فقط', 'Own only') },
        ],
      }),
      button({
        label: t(state, 'إنشاء دور', 'Create role'),
        icon: 'plus',
        act: 'live-create-role',
        small: true,
        busy: creating,
        // A role with no grant can do nothing, and the server rejects an empty
        // grant list anyway. Requiring both is a convenience, not the control.
        disabled: chosenGrant === '' || chosenScope === '',
      }),
    ]),
    h('p', { class: 'field__hint' }, [
      t(state, 'الأدوار المدمجة لا تُعدَّل. الدور المخصص يحمل فقط صلاحيات قابلة للتفويض تملكها أنت.', 'Built-in roles cannot be edited. A custom role can only carry delegable permissions you hold.'),
    ]),
    live.permissions.status === 'error' ? errorState(state, live.permissions.error) : null,
    resourceView(state, live.roles, {
      title: t(state, 'لا توجد أدوار', 'No roles'),
      body: t(state, 'لم تُهيَّأ الأدوار المدمجة بعد.', 'Built-in roles have not been set up yet.'),
    }, (rows) => h('ul', { class: 'card-list' }, rows.map((role) => roleCard(state, live, role)))),
  ]);
}

function roleCard(state: AppState, live: LiveState, role: Role): HTMLElement {
  const nameField = roleNameField(role.id);
  return h('li', { class: 'mini-card', 'data-role': role.key }, [
    h('div', { class: 'mini-card__head' }, [
      h('h3', { class: 'mini-card__title' }, [role.name]),
      role.is_builtin ? badge(t(state, 'مدمج', 'Built-in'), 'neutral', { icon: 'lock' }) : badge(t(state, 'مخصص', 'Custom'), 'accent'),
      badge(t(state, `${String(role.grants.length)} صلاحية`, `${String(role.grants.length)} permissions`), 'neutral'),
    ]),
    role.grants.length === 0
      ? null
      : h('p', { class: 'mini-card__grants' }, [role.grants.slice(0, 6).map((grant) => `${grant.permission_key} (${grant.scope_level})`).join(' · ')]),
    // Renaming is offered only where it is possible: a built-in role's name is
    // refused by the database.
    role.is_builtin
      ? null
      : h('div', { class: 'inline-form' }, [
          textInput(nameField, state.dialogForm[nameField] ?? '', role.name, { act: 'form-toggle', ariaLabel: t(state, `اسم جديد للدور ${role.name}`, `New name for ${role.name}`) }),
          button({ label: t(state, 'إعادة تسمية', 'Rename'), act: 'live-rename-role', arg: role.id, small: true, busy: live.busy === `rename-role:${role.id}`, disabled: (state.dialogForm[nameField] ?? '') === '' }),
          button({ label: t(state, 'حذف', 'Delete'), act: 'live-delete-role', arg: role.id, small: true, variant: 'danger', busy: live.busy === `delete-role:${role.id}` }),
        ]),
  ]);
}

/* -------------------------------------------------------------- ownership -- */

function ownershipPanel(state: AppState, live: LiveState): HTMLElement {
  return panel(t(state, 'نقل الملكية', 'Ownership transfer'), [
    notice('info', 'shield', t(
      state,
      'نقل الملكية عرض لا يكتمل إلا بقبول المستلم. المستلم وحده يقبل أو يرفض، ومن أرسل العرض وحده يلغيه.',
      'Ownership transfer is an offer that completes only when the recipient accepts. Only the recipient can accept or decline, and only the sender can cancel.',
    )),
    resourceView(state, live.transfers, {
      title: t(state, 'لا توجد عروض ملكية', 'No ownership offers'),
      body: t(state, 'ابدأ النقل من صف العضو في جدول الأعضاء.', 'Start a transfer from the member’s row in the Members table.'),
    }, (rows) => h('ul', { class: 'transfer-list' }, rows.map((row) => transferRow(state, live, row)))),
  ]);
}

function transferRow(state: AppState, live: LiveState, transfer: OwnershipTransfer): HTMLElement {
  const busy = live.busy === `ownership:${transfer.id}`;
  const recipient = rowsOf(live.people).find((person) => person.membership_id === transfer.to_membership);
  return h('li', { class: 'transfer' }, [
    h('div', { class: 'transfer__text' }, [
      h('p', { class: 'transfer__title' }, [
        t(state, 'عرض ملكية إلى ', 'Offer to '),
        isolated(recipient?.email ?? transfer.to_membership, recipient === undefined),
      ]),
      h('p', { class: 'transfer__meta' }, [
        statusBadge(state, transfer.status),
        ` ${t(state, 'ينتهي', 'Expires')} ${dateFormat(state.lang, { dateStyle: 'medium' }).format(new Date(transfer.expires_at))}`,
      ]),
    ]),
    transfer.status !== 'pending'
      ? null
      : h('div', { class: 'row-actions' }, [
          button({ label: t(state, 'قبول', 'Accept'), act: 'live-ownership', arg: `${transfer.id}:accept`, small: true, variant: 'primary', disabled: busy }),
          button({ label: t(state, 'رفض', 'Decline'), act: 'live-ownership', arg: `${transfer.id}:decline`, small: true, disabled: busy }),
          button({ label: t(state, 'إلغاء العرض', 'Cancel offer'), act: 'live-ownership', arg: `${transfer.id}:cancel`, small: true, variant: 'ghost', disabled: busy }),
        ]),
  ]);
}
