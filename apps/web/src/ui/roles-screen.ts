import type { Permission, Person, Role } from '../api/people.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber } from '../format.js';
import { icon } from '../icons.js';
import { hasPermission } from '../live/ability.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import {
  adminHead,
  matches,
  resourceView,
  rowMenu,
  routeTabs,
  screenLink,
  searchBox,
} from './admin-parts.js';
import { phrase, t } from './copy.js';
import { groupPermissions, PERMISSION_LABELS, SCOPE_OPTIONS } from './permission-catalog.js';
import type { PermissionGroup } from './permission-catalog.js';
import { badge, button, emptyState, inlineError, isolated, notice, page, selectControl, skeleton } from './parts.js';
import { usersTable } from './users-screen.js';

/**
 * Roles, and one role in detail.
 *
 * The list answers "which roles exist and how widely are they used"; the
 * detail is a permission console for one role, with who holds it on its own
 * tab. Built-in roles render the same matrix read-only. A custom role's edits
 * stay a local draft until Save, which sends the whole grant set to the
 * existing role endpoint — and the server re-checks delegability, the
 * operator's own grants and every scope before anything changes.
 */
export function renderRoles(state: AppState): HTMLElement {
  const roleId = state.route.params['role'];
  if (roleId !== undefined && roleId !== '') return roleDetail(state, roleId);
  return rolesList(state);
}

function userCount(live: LiveState, role: Role): number | null {
  return live.people.status === 'ready'
    ? live.people.value.filter((person) => person.role.id === role.id && person.status !== 'revoked').length
    : null;
}

function typeBadge(state: AppState, role: Role): HTMLElement {
  return role.is_builtin
    ? badge(t(state, 'مدمج', 'Built-in'), 'neutral', { icon: 'lock' })
    : badge(t(state, 'مخصص', 'Custom'), 'accent');
}

/* ------------------------------------------------------------------- list -- */

function rolesList(state: AppState): HTMLElement {
  const live = state.live;
  const draft = state.roleDraft;
  const draftRole = draft === null ? undefined : rowsOf(live.roles).find((role) => role.id === draft.roleId);
  return page('roles', null, [
    adminHead(state, {
      trail: [{ label: t(state, 'إدارة المستخدمين', 'User management') }, { label: t(state, 'الأدوار', 'Roles') }],
      title: t(state, 'الأدوار', 'Roles'),
      titleIcon: 'shieldUser',
      subtitle: t(state, 'حدّد ما يستطيع كل دور فعله في مساحة العمل.', 'Define what each role can do in this workspace.'),
      actions: [
        button({ icon: 'refresh', act: 'live-reload', small: true, variant: 'ghost', title: t(state, 'تحديث', 'Refresh'), busy: live.roles.status === 'loading' }),
        // The route opens this screen only with role.manage.
        button({ label: t(state, 'إنشاء دور', 'Create Role'), icon: 'plus', act: 'dialog', arg: 'role-create', small: true, variant: 'primary' }),
      ],
    }),
    state.dialog === null ? inlineError(state, live.error) : null,
    draftRole === undefined
      ? null
      : notice('warning', 'alert',
          h('p', {}, [
            t(state, 'لديك تغييرات غير محفوظة على الدور ', 'You have unsaved changes to '),
            h('strong', {}, [draftRole.name]),
            '. ',
            screenLink(state, 'roles', { role: draftRole.id }, [t(state, 'مراجعتها', 'Review them')]),
          ])),
    h('section', { class: 'admin-panel', 'aria-label': t(state, 'قائمة الأدوار', 'Role list') }, [
      resourceView(state, live.roles, {
        icon: 'shieldUser',
        title: t(state, 'لا توجد أدوار', 'No roles'),
        body: t(state, 'لم تُهيَّأ الأدوار المدمجة بعد.', 'Built-in roles have not been set up yet.'),
      }, (rows) => rolesTable(state, live, rows)),
    ]),
  ]);
}

function rolesTable(state: AppState, live: LiveState, rows: readonly Role[]): HTMLElement {
  const total = live.permissions.status === 'ready' ? live.permissions.value.length : null;
  // Built-in roles first, in the order the product defines them, then custom.
  const ordered = [...rows].sort((left, right) => Number(right.is_builtin) - Number(left.is_builtin));
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table admin-table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'الدور', 'Role name')]),
        h('th', { scope: 'col' }, [t(state, 'النوع', 'Type')]),
        h('th', { scope: 'col', class: 'num' }, [t(state, 'المستخدمون', 'Users')]),
        h('th', { scope: 'col', class: 'num' }, [t(state, 'الصلاحيات', 'Permissions')]),
        h('th', { scope: 'col', class: 'admin-table__actions' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراءات', 'Actions')])]),
      ])]),
      h('tbody', {}, ordered.map((role) => {
        const users = userCount(live, role);
        return h('tr', { 'data-role': role.key }, [
          h('td', { 'data-label': t(state, 'الدور', 'Role name') }, [
            screenLink(state, 'roles', { role: role.id }, [h('span', { class: 'table__primary' }, [isolated(role.name)])], 'admin-rowlink'),
            role.description === '' ? null : h('span', { class: 'table__sub' }, [isolated(role.description)]),
          ]),
          h('td', { 'data-label': t(state, 'النوع', 'Type') }, [typeBadge(state, role)]),
          h('td', { class: 'num', 'data-label': t(state, 'المستخدمون', 'Users') }, [users === null ? '—' : formatNumber(users, state.lang)]),
          h('td', { class: 'num', 'data-label': t(state, 'الصلاحيات', 'Permissions') }, [
            total === null ? formatNumber(role.grants.length, state.lang) : `${formatNumber(role.grants.length, state.lang)} / ${formatNumber(total, state.lang)}`,
          ]),
          h('td', { class: 'admin-table__actions' }, [roleMenu(state, live, role)]),
        ]);
      })),
    ]),
  ]);
}

function roleMenu(state: AppState, live: LiveState, role: Role): HTMLElement | null {
  const manage = hasPermission(live, 'role.manage');
  return rowMenu(state, `role:${role.id}`, t(state, `إجراءات الدور ${role.name}`, `Actions for ${role.name}`), [
    manage && !role.is_builtin ? { label: t(state, 'إعادة تسمية', 'Rename'), icon: 'edit', act: 'dialog', arg: `role-rename:${role.id}` } : null,
    manage && !role.is_builtin ? { label: t(state, 'حذف الدور…', 'Delete role…'), icon: 'trash', act: 'dialog', arg: `role-delete:${role.id}`, danger: true } : null,
  ]);
}

/* ----------------------------------------------------------------- detail -- */

function roleDetail(state: AppState, roleId: string): HTMLElement {
  const live = state.live;
  const trail = [
    { label: t(state, 'إدارة المستخدمين', 'User management') },
    { label: t(state, 'الأدوار', 'Roles'), screen: 'roles' as const },
  ];
  if (live.roles.status === 'idle' || live.roles.status === 'loading') {
    return page('roles', null, [adminHead(state, { trail: [...trail, { label: '…' }], title: '…' }), skeleton(state, 6)]);
  }
  const role = rowsOf(live.roles).find((entry) => entry.id === roleId);
  if (role === undefined) {
    return page('roles', null, [
      adminHead(state, { trail: [...trail, { label: t(state, 'غير موجود', 'Not found') }], title: t(state, 'الدور غير متاح', 'Role unavailable') }),
      live.roles.status === 'error'
        ? inlineError(state, live.roles.error)
        : emptyState({
            icon: 'shieldUser',
            title: t(state, 'هذا الدور غير موجود', 'This role does not exist'),
            body: t(state, 'ربما حُذف. ارجع إلى قائمة الأدوار.', 'It may have been deleted. Go back to the role list.'),
            action: { label: t(state, 'كل الأدوار', 'All roles'), act: 'nav', arg: 'roles' },
          }),
    ]);
  }
  const tab = state.route.params['tab'] === 'users' ? 'users' : 'permissions';
  const assigned = live.people.status === 'ready'
    ? live.people.value.filter((person) => person.role.id === role.id && person.status !== 'revoked')
    : null;
  const grants = currentGrants(state, role);
  const total = live.permissions.status === 'ready' ? live.permissions.value.length : null;
  return page('roles', null, [
    adminHead(state, {
      trail: [...trail, { label: role.name }],
      title: role.name,
      titleIcon: 'shieldUser',
      subtitle: role.description === '' ? undefined : role.description,
      badges: [typeBadge(state, role)],
      actions: [roleMenu(state, live, role)],
    }),
    state.dialog === null ? inlineError(state, live.error) : null,
    h('section', { class: 'role-summary', 'aria-label': t(state, 'ملخص الدور', 'Role summary') }, [
      summaryCard(t(state, 'المستخدمون المسندون', 'Assigned users'), assigned === null ? '—' : formatNumber(assigned.length, state.lang), 'users'),
      summaryCard(t(state, 'الصلاحيات', 'Permissions'), total === null ? formatNumber(Object.keys(grants).length, state.lang) : `${formatNumber(Object.keys(grants).length, state.lang)} / ${formatNumber(total, state.lang)}`, 'key'),
      summaryCard(t(state, 'نوع الدور', 'Role type'), role.is_builtin ? t(state, 'مدمج', 'Built-in') : t(state, 'مخصص', 'Custom'), role.is_builtin ? 'lock' : 'layers'),
      summaryCard(t(state, 'آخر تحديث', 'Last updated'), dateFormat(state.lang, { dateStyle: 'medium' }).format(new Date(role.updated_at)), 'clock'),
    ]),
    routeTabs(state, t(state, 'أقسام الدور', 'Role sections'), 'roles', [
      { id: 'permissions', label: t(state, 'الصلاحيات', 'Permissions'), params: { role: role.id } },
      { id: 'users', label: t(state, 'المستخدمون المسندون', 'Assigned Users'), count: assigned?.length, params: { role: role.id, tab: 'users' } },
    ], tab),
    h('section', { class: 'admin-panel', role: 'tabpanel', id: `tabpanel-${tab}`, 'aria-labelledby': `tab-${tab}` }, [
      tab === 'permissions' ? permissionsTab(state, live, role, grants) : assignedTab(state, live, role, assigned),
    ]),
  ]);
}

function summaryCard(label: string, value: string, iconName: 'users' | 'key' | 'lock' | 'layers' | 'clock'): HTMLElement {
  return h('div', { class: 'role-summary__card' }, [
    h('span', { class: 'role-summary__icon', 'aria-hidden': 'true' }, [icon(iconName, 16)]),
    h('span', { class: 'role-summary__label' }, [label]),
    h('strong', { class: 'role-summary__value' }, [value]),
  ]);
}

/** The grants on screen: the draft when one exists for this role, else the server's. */
export function currentGrants(state: AppState, role: Role): Readonly<Record<string, string>> {
  if (state.roleDraft !== null && state.roleDraft.roleId === role.id) return state.roleDraft.grants;
  return Object.fromEntries(role.grants.map((grant) => [grant.permission_key, grant.scope_level]));
}

/** Whether the draft differs from what the server holds. */
export function draftIsDirty(state: AppState, role: Role): boolean {
  if (state.roleDraft === null || state.roleDraft.roleId !== role.id) return false;
  const saved = Object.fromEntries(role.grants.map((grant) => [grant.permission_key, grant.scope_level]));
  const draft = state.roleDraft.grants;
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  return [...keys].some((key) => saved[key] !== draft[key]);
}

/**
 * Why a permission cannot be changed on this role, or `null` when it can.
 *
 * Mirrors the server's own refusals so the screen never pretends a checkbox
 * worked: a built-in role is immutable, a non-delegable key can never be put
 * on a custom role, and a key the operator does not hold cannot be granted by
 * them. Scope ceilings are left to the server, which knows the operator's
 * scopes; its refusal is shown beside the save bar.
 */
function lockReason(state: AppState, role: Role, permission: Permission): string | null {
  if (role.is_builtin) return t(state, 'دور مدمج', 'Built-in role');
  if (!hasPermission(state.live, 'role.manage')) return t(state, 'لا تملك إدارة الأدوار', 'You cannot manage roles');
  if (!permission.delegable) return t(state, 'غير قابلة للتفويض', 'Not delegable');
  if (!hasPermission(state.live, permission.key)) return t(state, 'لا تملكها', 'You don’t hold it');
  return null;
}

function permissionsTab(state: AppState, live: LiveState, role: Role, grants: Readonly<Record<string, string>>): HTMLElement {
  if (live.permissions.status !== 'ready') {
    return h('div', { class: 'admin-panel__body' }, [
      resourceView(state, live.permissions, { icon: 'key', title: '', body: '' }, () => null),
    ]);
  }
  const catalogue = live.permissions.value;
  const byKey = new Map(catalogue.map((permission) => [permission.key, permission]));
  const groups = groupPermissions(catalogue.map((permission) => permission.key));
  const enabled = catalogue.filter((permission) => grants[permission.key] !== undefined).length;
  const dirty = draftIsDirty(state, role);
  const query = state.permissionSearch;
  const visibleGroups = groups
    .map((group) => ({ group, keys: group.keys.filter((key) => matches(query, key, labelOf(state, key), (byKey.get(key) as Permission).description)) }))
    .filter((entry) => entry.keys.length > 0);
  return h('div', { class: 'admin-panel__body permissions' }, [
    h('div', { class: 'permissions__head' }, [
      h('div', {}, [
        h('h3', { class: 'permissions__title' }, [t(state, 'الصلاحيات', 'Permissions')]),
        h('p', { class: 'permissions__lede' }, [t(state, 'حدّد العمليات التي يستطيع هذا الدور الوصول إليها بدقة.', 'Define the exact operations this role may access.')]),
      ]),
      h('p', { class: 'permissions__count', 'aria-live': 'polite' }, [
        t(state, `${formatNumber(enabled, state.lang)} من ${formatNumber(catalogue.length, state.lang)} مفعّلة`, `${String(enabled)} of ${String(catalogue.length)} enabled`),
      ]),
    ]),
    role.is_builtin
      ? notice('info', 'lock',
          h('p', { class: 'notice__title' }, [t(state, 'دور مدمج', 'Built-in role')]),
          h('p', {}, [t(state, 'لا يمكن تعديل صلاحيات هذا الدور النظامي.', 'Permissions for this system role cannot be edited.')]))
      : null,
    searchBox(query, 'permission-search', t(state, 'ابحث في الصلاحيات أو العمليات…', 'Search permissions or actions...'), t(state, 'بحث في الصلاحيات', 'Search permissions')),
    visibleGroups.length === 0
      ? h('p', { class: 'admin-empty-search', role: 'status' }, [t(state, 'لا توجد صلاحية تطابق البحث.', 'No permission matches this search.')])
      : h('div', { class: 'permission-grid' }, visibleGroups.map(({ group, keys }) =>
          permissionCard(state, role, group, keys.map((key) => byKey.get(key) as Permission), grants, query !== ''))),
    dirty || live.busy === `save-role:${role.id}`
      ? h('div', { class: 'savebar', role: 'region', 'aria-label': t(state, 'تغييرات غير محفوظة', 'Unsaved changes') }, [
          h('p', { class: 'savebar__text' }, [icon('alert', 16), t(state, 'لديك تغييرات غير محفوظة على هذا الدور.', 'You have unsaved changes to this role.')]),
          button({ label: t(state, 'إلغاء', 'Cancel'), act: 'role-draft-discard', small: true, variant: 'ghost', disabled: live.busy !== null }),
          button({ label: t(state, 'حفظ التغييرات', 'Save Changes'), icon: 'check', act: 'live-save-role', arg: role.id, small: true, variant: 'primary', busy: live.busy === `save-role:${role.id}` }),
        ])
      : null,
  ]);
}

function labelOf(state: AppState, key: string): string {
  return PERMISSION_LABELS[key] === undefined ? key : phrase(state, PERMISSION_LABELS, key);
}

function permissionCard(
  state: AppState,
  role: Role,
  group: PermissionGroup,
  permissions: readonly Permission[],
  grants: Readonly<Record<string, string>>,
  searching: boolean,
): HTMLElement {
  const enabled = permissions.filter((permission) => grants[permission.key] !== undefined).length;
  // A search opens every module it matched, whatever was folded before.
  const collapsed = !searching && state.collapsedGroups.includes(group.id);
  const bodyId = `permission-group-${group.id}`;
  return h('section', { class: 'permission-card', 'data-group': group.id }, [
    h('h3', { class: 'permission-card__heading' }, [
      h('button', {
        type: 'button',
        class: 'permission-card__toggle',
        'data-act': 'permission-group',
        'data-arg': group.id,
        'aria-expanded': String(!collapsed),
        'aria-controls': bodyId,
      }, [
        h('span', { class: 'permission-card__icon', 'aria-hidden': 'true' }, [icon(group.icon, 16)]),
        h('span', { class: 'permission-card__name' }, [phrase(state, { [group.id]: group.name }, group.id)]),
        h('span', { class: 'permission-card__count' }, [`${String(enabled)}/${String(permissions.length)}`]),
        icon('chevronDown', 16, { class: 'permission-card__chevron' }),
      ]),
    ]),
    collapsed ? null : h('ul', { class: 'permission-card__list', id: bodyId }, permissions.map((permission) => permissionRow(state, role, permission, grants[permission.key]))),
  ]);
}

function permissionRow(state: AppState, role: Role, permission: Permission, scope: string | undefined): HTMLElement {
  const locked = lockReason(state, role, permission);
  const label = labelOf(state, permission.key);
  const inputId = `perm-${permission.key.replace(/[^a-z0-9]/gi, '-')}`;
  const disabled = locked !== null || state.live.busy !== null;
  return h('li', { class: `permission-row${scope === undefined ? '' : ' permission-row--on'}`, 'data-permission': permission.key }, [
    h('input', {
      type: 'checkbox',
      class: 'permission-row__check',
      id: inputId,
      checked: scope !== undefined,
      disabled,
      // A checkbox reports its value on change, not its data-arg.
      value: permission.key,
      'data-act': 'role-grant-toggle',
      'aria-describedby': `${inputId}-key`,
    }),
    h('label', { class: 'permission-row__text', for: inputId, title: permission.description }, [
      h('span', { class: 'permission-row__label' }, [label]),
      h('code', { class: 'permission-row__key', id: `${inputId}-key`, dir: 'ltr' }, [permission.key]),
    ]),
    locked === null || role.is_builtin ? null : h('span', { class: 'permission-row__lock', title: locked }, [icon('lock', 14), locked]),
    scope === undefined
      ? null
      : selectControl({
          value: scope,
          act: 'role-grant-scope',
          form: permission.key,
          ariaLabel: t(state, `نطاق ${label}`, `Scope for ${label}`),
          disabled,
          options: SCOPE_OPTIONS.map((option) => ({ value: option.value, label: t(state, option.label.ar, option.label.en) })),
        }),
  ]);
}

/* --------------------------------------------------------- assigned users -- */

function assignedTab(state: AppState, live: LiveState, role: Role, assigned: readonly Person[] | null): HTMLElement {
  const canAssign = hasPermission(live, 'member.manage') && live.people.status === 'ready';
  return h('div', { class: 'admin-panel__body' }, [
    h('div', { class: 'permissions__head' }, [
      h('div', {}, [
        h('h3', { class: 'permissions__title' }, [t(state, 'المستخدمون المسندون', 'Assigned Users')]),
        h('p', { class: 'permissions__lede' }, [t(state, 'المستخدمون الذين يحملون هذا الدور حاليًا.', 'Users who currently have this role.')]),
      ]),
      canAssign ? button({ label: t(state, 'إسناد مستخدمين', 'Assign Users'), icon: 'userCheck', act: 'dialog', arg: `role-assign:${role.id}`, small: true, variant: 'primary' }) : null,
    ]),
    assigned === null
      ? resourceView(state, live.people, { icon: 'users', title: '', body: '' }, () => null)
      : assigned.length === 0
        ? emptyState({
            icon: 'users',
            title: t(state, 'لا أحد يحمل هذا الدور', 'Nobody has this role'),
            body: t(state, 'أسند الدور لأعضاء من مساحة العمل.', 'Assign it to members of this workspace.'),
          })
        : usersTable(state, live, assigned, { withRole: false }),
    assigned === null || assigned.length === 0 ? null : h('p', { class: 'field__hint' }, [
      icon('info', 14),
      t(state, 'لإزالة شخص من هذا الدور اختر له دورًا آخر من «تغيير الدور»: لكل عضو دور واحد دائمًا.', 'To remove someone from this role, give them another one with “Change role”: every member always holds exactly one role.'),
    ]),
  ]);
}
