import { h } from '../dom.js';
import { icon } from '../icons.js';
import { roleNameField, teamNameField } from '../live/dispatch.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { matches, teamsOf } from './admin-parts.js';
import { t } from './copy.js';
import { button, dialogShell, field, inlineError, notice, selectControl, textInput } from './parts.js';

/**
 * Dialogs for the user-management screens. Each confirms one existing API
 * operation; nothing here decides authority, and every refusal the server
 * returns is shown in the dialog that caused it.
 */

function cancel(state: AppState): HTMLElement {
  return button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' });
}

function gone(state: AppState, title: string): HTMLElement {
  return dialogShell(state, title, [notice('warning', 'alert', t(state, 'لم يعد هذا العنصر موجودًا. حدّث القائمة.', 'This item no longer exists. Refresh the list.'))], [cancel(state)]);
}

export function renderAdminDialog(state: AppState, kind: string, arg: string): HTMLElement | null {
  if (kind === 'member-role') return memberRole(state, arg);
  if (kind === 'member-revoke') return memberRevoke(state, arg);
  if (kind === 'member-teams') return memberTeams(state, arg);
  if (kind === 'role-create') return roleCreate(state);
  if (kind === 'role-rename') return roleRename(state, arg);
  if (kind === 'role-delete') return roleDelete(state, arg);
  if (kind === 'role-assign') return roleAssign(state, arg);
  if (kind === 'team-create') return teamCreate(state);
  if (kind === 'team-rename') return teamRename(state, arg);
  return null;
}

/* ---------------------------------------------------------------- members -- */

function memberRole(state: AppState, membershipId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'تغيير الدور', 'Change role');
  const person = rowsOf(live.people).find((entry) => entry.membership_id === membershipId);
  if (person === undefined) return gone(state, title);
  const chosen = state.dialogForm['memberRole'] ?? person.role.id;
  return dialogShell(state, title, [
    h('p', { class: 'dialog__lead' }, [t(state, 'الدور الجديد لـ ', 'New role for '), h('bdi', { class: 'dialog__subject' }, [person.email])]),
    field(t(state, 'الدور', 'Role'), selectControl({
      value: chosen,
      act: 'form-toggle',
      form: 'memberRole',
      id: 'member-role',
      options: rowsOf(live.roles).map((role) => ({ value: role.id, label: role.name })),
    }), t(state, 'لكل عضو دور واحد. لا يمكنك منح صلاحيات أوسع مما تملك.', 'Every member holds exactly one role. You cannot grant more than you hold.')),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({
      label: t(state, 'حفظ الدور', 'Save role'),
      act: 'live-member-role',
      arg: membershipId,
      variant: 'primary',
      disabled: chosen === person.role.id,
      busy: live.busy === `role:${membershipId}`,
    }),
  ]);
}

function memberRevoke(state: AppState, membershipId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'إلغاء العضوية', 'Revoke access');
  const person = rowsOf(live.people).find((entry) => entry.membership_id === membershipId);
  if (person === undefined) return gone(state, title);
  return dialogShell(state, title, [
    notice('danger', 'alert', h('span', {}, [
      h('bdi', {}, [person.email]),
      t(state, ' سيفقد الوصول إلى مساحة العمل فورًا وتنتهي جلساته. يبقى سجل عمله محفوظًا.', ' will lose access to this workspace immediately and their sessions will end. Their history is kept.'),
    ])),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'إلغاء العضوية', 'Revoke access'), icon: 'trash', act: 'live-member-revoke', arg: membershipId, variant: 'danger', busy: live.busy === `status:${membershipId}` }),
  ]);
}

function memberTeams(state: AppState, membershipId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'إدارة الفرق', 'Manage teams');
  const person = rowsOf(live.people).find((entry) => entry.membership_id === membershipId);
  if (person === undefined) return gone(state, title);
  const member = new Set(teamsOf(live, membershipId).map((team) => team.id));
  const teams = rowsOf(live.teams).filter((team) => !team.archived || member.has(team.id));
  return dialogShell(state, title, [
    h('p', { class: 'dialog__lead' }, [t(state, 'فرق ', 'Teams for '), h('bdi', { class: 'dialog__subject' }, [person.email])]),
    teams.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا توجد فرق بعد. أنشئ فريقًا من صفحة الفرق.', 'There are no teams yet. Create one on the Teams page.')])
      : h('ul', { class: 'pick-list' }, teams.map((team) => {
          const inTeam = member.has(team.id);
          return h('li', { class: 'pick-list__item' }, [
            h('span', { class: 'pick-list__name' }, [icon('team', 16), team.name]),
            button({
              label: inTeam ? t(state, 'إزالة', 'Remove') : t(state, 'إضافة', 'Add'),
              act: 'live-member-team',
              arg: `${team.id}:${membershipId}:${inTeam ? 'remove' : 'add'}`,
              small: true,
              variant: inTeam ? 'ghost' : 'default',
              disabled: !inTeam && team.archived,
              busy: live.busy === `team-add:${team.id}` || live.busy === `team-remove:${team.id}:${membershipId}`,
            }),
          ]);
        })),
    inlineError(state, live.error),
  ], [button({ label: t(state, 'تم', 'Done'), act: 'close-dialog', variant: 'primary' })]);
}

/* ------------------------------------------------------------------ roles -- */

function roleCreate(state: AppState): HTMLElement {
  const live = state.live;
  const name = state.dialogForm['roleName'] ?? '';
  return dialogShell(state, t(state, 'إنشاء دور', 'Create role'), [
    field(t(state, 'اسم الدور', 'Role name'), textInput('roleName', name, t(state, 'مثال: منسق القبول', 'e.g. Enrollment coordinator'), { act: 'form-toggle', id: 'role-name', required: true })),
    field(t(state, 'الوصف', 'Description'), h('textarea', {
      class: 'input textarea', id: 'role-description', 'data-act': 'form', 'data-form': 'roleDescription', rows: '3', maxlength: '500',
      placeholder: t(state, 'لمن هذا الدور وماذا يفعل', 'Who this role is for and what it does'),
    }, [state.dialogForm['roleDescription'] ?? '']), t(state, 'بعد الإنشاء تحدد الصلاحيات من صفحة الدور.', 'After creating it you choose its permissions on the role page.')),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'إنشاء الدور', 'Create role'), icon: 'plus', act: 'live-create-role', variant: 'primary', disabled: name.trim() === '', busy: live.busy === 'create-role' }),
  ]);
}

function roleRename(state: AppState, roleId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'تعديل بيانات الدور', 'Edit role details');
  const role = rowsOf(live.roles).find((entry) => entry.id === roleId);
  if (role === undefined) return gone(state, title);
  const key = roleNameField(role.id);
  const name = state.dialogForm[key] ?? role.name;
  return dialogShell(state, title, [
    field(t(state, 'اسم الدور', 'Role name'), textInput(key, name, role.name, { act: 'form-toggle', id: 'role-rename', required: true })),
    field(t(state, 'الوصف', 'Description'), h('textarea', {
      class: 'input textarea', id: 'role-rename-description', 'data-act': 'form', 'data-form': `${key}_description`, rows: '3', maxlength: '500',
    }, [state.dialogForm[`${key}_description`] ?? role.description])),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'حفظ', 'Save'), act: 'live-rename-role', arg: role.id, variant: 'primary', disabled: name.trim() === '', busy: live.busy === `rename-role:${role.id}` }),
  ]);
}

function roleDelete(state: AppState, roleId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'حذف الدور', 'Delete role');
  const role = rowsOf(live.roles).find((entry) => entry.id === roleId);
  if (role === undefined) return gone(state, title);
  const holders = rowsOf(live.people).filter((person) => person.role.id === role.id && person.status !== 'revoked').length;
  return dialogShell(state, title, [
    holders > 0
      ? notice('warning', 'users', t(
          state,
          `يحمل ${String(holders)} عضو هذا الدور. انقلهم إلى دور آخر أولًا؛ لا يُحذف دور يحمله أحد.`,
          `${String(holders)} member(s) hold this role. Move them to another role first; a role somebody holds cannot be deleted.`,
        ))
      : notice('danger', 'trash', h('span', {}, [
          t(state, 'سيُحذف الدور ', 'The role '),
          h('strong', {}, [role.name]),
          t(state, ' نهائيًا. لا يمكن التراجع.', ' will be deleted permanently. This cannot be undone.'),
        ])),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'حذف الدور', 'Delete role'), icon: 'trash', act: 'live-delete-role', arg: role.id, variant: 'danger', disabled: holders > 0, busy: live.busy === `delete-role:${role.id}` }),
  ]);
}

function roleAssign(state: AppState, roleId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'إسناد مستخدمين', 'Assign users');
  const role = rowsOf(live.roles).find((entry) => entry.id === roleId);
  if (role === undefined) return gone(state, title);
  const search = state.dialogForm['assignSearch'] ?? '';
  const picked = new Set((state.dialogForm['assignPicked'] ?? '').split(',').filter((id) => id !== ''));
  const candidates = rowsOf(live.people)
    .filter((person) => person.role.id !== role.id && person.status !== 'revoked')
    .filter((person) => matches(search, person.email, person.role.name));
  return dialogShell(state, title, [
    h('p', { class: 'dialog__lead' }, [t(state, 'يصبح لكل من تختاره الدور ', 'Everyone you pick gets the role '), h('strong', {}, [role.name]), t(state, ' بدلًا من دوره الحالي.', ' instead of their current one.')]),
    h('label', { class: 'admin-search' }, [
      icon('search', 16),
      h('input', { class: 'admin-search__input', type: 'search', value: search, 'data-act': 'form-toggle', 'data-form': 'assignSearch', 'aria-label': t(state, 'بحث في الأعضاء', 'Search members'), placeholder: t(state, 'ابحث بالبريد أو الدور', 'Search email or role') }),
    ]),
    candidates.length === 0
      ? h('p', { class: 'field__hint', role: 'status' }, [t(state, 'لا يوجد أعضاء آخرون يمكن إسنادهم.', 'There are no other members to assign.')])
      : h('ul', { class: 'pick-list' }, candidates.map((person) => {
          const id = `assign-${person.membership_id}`;
          return h('li', { class: 'pick-list__item' }, [
            h('input', { type: 'checkbox', id, value: person.membership_id, checked: picked.has(person.membership_id), 'data-act': 'assign-pick', class: 'permission-row__check' }),
            h('label', { for: id, class: 'pick-list__name' }, [h('bdi', {}, [person.email]), h('span', { class: 'table__sub' }, [person.role.name])]),
          ]);
        })),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({
      label: picked.size === 0 ? t(state, 'إسناد', 'Assign') : t(state, `إسناد (${String(picked.size)})`, `Assign (${String(picked.size)})`),
      icon: 'userCheck',
      act: 'live-role-assign',
      arg: role.id,
      variant: 'primary',
      disabled: picked.size === 0,
      busy: live.busy === `assign-role:${role.id}`,
    }),
  ]);
}

/* ------------------------------------------------------------------ teams -- */

function teamCreate(state: AppState): HTMLElement {
  const live = state.live;
  const name = state.dialogForm['teamName'] ?? '';
  return dialogShell(state, t(state, 'إنشاء فريق', 'Create team'), [
    field(t(state, 'اسم الفريق', 'Team name'), textInput('teamName', name, t(state, 'مثال: القبول', 'e.g. Admissions'), { act: 'form-toggle', id: 'team-name', required: true })),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'إنشاء الفريق', 'Create team'), icon: 'plus', act: 'live-create-team', variant: 'primary', disabled: name.trim() === '', busy: live.busy === 'create-team' }),
  ]);
}

function teamRename(state: AppState, teamId: string): HTMLElement {
  const live = state.live;
  const title = t(state, 'إعادة تسمية الفريق', 'Rename team');
  const team = rowsOf(live.teams).find((entry) => entry.id === teamId);
  if (team === undefined) return gone(state, title);
  const key = teamNameField(team.id);
  const name = state.dialogForm[key] ?? team.name;
  return dialogShell(state, title, [
    field(t(state, 'اسم الفريق', 'Team name'), textInput(key, name, team.name, { act: 'form-toggle', id: 'team-rename', required: true })),
    inlineError(state, live.error),
  ], [
    cancel(state),
    button({ label: t(state, 'حفظ', 'Save'), act: 'live-rename-team', arg: team.id, variant: 'primary', disabled: name.trim() === '' || name.trim() === team.name, busy: live.busy === `rename-team:${team.id}` }),
  ]);
}
