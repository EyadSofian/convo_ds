import type { Team } from '../api/people.js';
import { h } from '../dom.js';
import { formatNumber } from '../format.js';
import { hasPermission } from '../live/ability.js';
import { teamMemberField } from '../live/dispatch.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { adminHead, memberCell, resourceView, rowMenu, screenLink, statusBadge } from './admin-parts.js';
import { t } from './copy.js';
import { badge, button, emptyState, inlineError, isolated, page, refreshButton, selectControl, skeleton, toolbar } from './parts.js';

/**
 * Teams, and one team in detail: its members, and the settings the API lets
 * an administrator change — the name, and whether it is archived. Archiving
 * keeps the team and its history; an archived team takes no new members, and
 * the server refuses that too.
 */
export function renderTeams(state: AppState): HTMLElement {
  const teamId = state.route.params['team'];
  if (teamId !== undefined && teamId !== '') return teamDetail(state, teamId);
  return teamsList(state);
}

function teamStatus(state: AppState, team: Team): HTMLElement {
  return team.archived ? badge(t(state, 'مؤرشف', 'Archived'), 'warning', { icon: 'archive' }) : badge(t(state, 'نشط', 'Active'), 'success', { dot: true });
}

function teamMenu(state: AppState, live: LiveState, team: Team): HTMLElement | null {
  const manage = hasPermission(live, 'member.manage');
  return rowMenu(state, `team:${team.id}`, t(state, `إجراءات الفريق ${team.name}`, `Actions for ${team.name}`), [
    manage ? { label: t(state, 'إعادة تسمية', 'Rename'), icon: 'edit', act: 'dialog', arg: `team-rename:${team.id}` } : null,
    manage
      ? team.archived
        ? { label: t(state, 'استعادة', 'Restore'), icon: 'restore', act: 'live-archive-team', arg: `${team.id}:restore`, disabled: live.busy !== null }
        : { label: t(state, 'أرشفة', 'Archive'), icon: 'archive', act: 'live-archive-team', arg: `${team.id}:archive`, disabled: live.busy !== null }
      : null,
  ]);
}

/* ------------------------------------------------------------------- list -- */

function teamsList(state: AppState): HTMLElement {
  const live = state.live;
  const manage = hasPermission(live, 'member.manage');
  return page('teams', toolbar(t(state, 'اجمع الأعضاء في فرق لتوجيه المحادثات وتحديد النطاق.', 'Group members into teams for routing and scope.'), [
    refreshButton(state, 'live-reload', live.teams.status === 'loading'),
    manage ? button({ label: t(state, 'إنشاء فريق', 'Create Team'), icon: 'plus', act: 'dialog', arg: 'team-create', small: true, variant: 'primary' }) : null,
  ]), [
    state.dialog === null ? inlineError(state, live.error) : null,
    h('section', { class: 'admin-panel', 'aria-label': t(state, 'قائمة الفرق', 'Team list') }, [
      resourceView(state, live.teams, {
        icon: 'team',
        title: t(state, 'لا توجد فرق', 'No teams'),
        body: t(state, 'أنشئ فريقًا لتوجيه المحادثات إليه.', 'Create a team to route conversations to.'),
        action: manage ? { label: t(state, 'إنشاء فريق', 'Create Team'), act: 'dialog', arg: 'team-create', primary: true } : undefined,
      }, (rows) => h('div', { class: 'tablewrap' }, [
        h('table', { class: 'table admin-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { scope: 'col' }, [t(state, 'الفريق', 'Team name')]),
            h('th', { scope: 'col', class: 'num' }, [t(state, 'الأعضاء', 'Members')]),
            h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
            h('th', { scope: 'col', class: 'admin-table__actions' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراءات', 'Actions')])]),
          ])]),
          h('tbody', {}, rows.map((team) => h('tr', { 'data-team': team.id }, [
            h('td', { 'data-label': t(state, 'الفريق', 'Team name') }, [
              screenLink(state, 'teams', { team: team.id }, [h('span', { class: 'table__primary' }, [isolated(team.name)])], 'admin-rowlink'),
            ]),
            h('td', { class: 'num', 'data-label': t(state, 'الأعضاء', 'Members') }, [formatNumber(team.member_count, state.lang)]),
            h('td', { 'data-label': t(state, 'الحالة', 'Status') }, [teamStatus(state, team)]),
            h('td', { class: 'admin-table__actions' }, [teamMenu(state, live, team)]),
          ]))),
        ]),
      ])),
    ]),
  ]);
}

/* ----------------------------------------------------------------- detail -- */

function teamDetail(state: AppState, teamId: string): HTMLElement {
  const live = state.live;
  const trail = [{ label: t(state, 'الفرق', 'Teams'), screen: 'teams' as const }];
  if (live.teams.status === 'idle' || live.teams.status === 'loading') {
    return page('teams', null, [adminHead(state, { trail: [...trail, { label: '…' }], title: '…' }), skeleton(state, 4)]);
  }
  const team = rowsOf(live.teams).find((entry) => entry.id === teamId);
  if (team === undefined) {
    return page('teams', null, [
      adminHead(state, { trail: [...trail, { label: t(state, 'غير موجود', 'Not found') }], title: t(state, 'الفريق غير متاح', 'Team unavailable') }),
      live.teams.status === 'error'
        ? inlineError(state, live.teams.error)
        : emptyState({
            icon: 'team',
            title: t(state, 'هذا الفريق غير موجود', 'This team does not exist'),
            body: t(state, 'ارجع إلى قائمة الفرق.', 'Go back to the team list.'),
            action: { label: t(state, 'كل الفرق', 'All teams'), act: 'nav', arg: 'teams' },
          }),
    ]);
  }
  const manage = hasPermission(live, 'member.manage');
  const inTeam = new Set(team.members.map((member) => member.membership_id));
  const people = rowsOf(live.people);
  const addable = people.filter((person) => !inTeam.has(person.membership_id) && person.status !== 'revoked');
  const members = team.members.map((member) => people.find((person) => person.membership_id === member.membership_id) ?? {
    membership_id: member.membership_id, email: member.email, status: '—', role: { id: '', key: '', name: '—' }, scopes: [],
  });
  return page('teams', null, [
    adminHead(state, {
      trail: [...trail, { label: team.name }],
      title: team.name,
      subtitle: t(state, `عدد الأعضاء: ${formatNumber(team.member_count, state.lang)}`, `Members: ${String(team.member_count)}`),
      badges: [teamStatus(state, team)],
      actions: [teamMenu(state, live, team)],
    }),
    state.dialog === null ? inlineError(state, live.error) : null,
    h('section', { class: 'admin-panel', 'aria-label': t(state, 'أعضاء الفريق', 'Team members') }, [
      h('div', { class: 'admin-panel__body' }, [
        h('div', { class: 'permissions__head' }, [
          h('div', {}, [
            h('h3', { class: 'permissions__title' }, [t(state, 'الأعضاء', 'Members')]),
            h('p', { class: 'permissions__lede' }, [
              team.archived
                ? t(state, 'الفريق مؤرشف: لا يقبل أعضاء جددًا حتى تستعيده.', 'This team is archived: it takes no new members until it is restored.')
                : t(state, 'من ينتمي إلى هذا الفريق.', 'Who belongs to this team.'),
            ]),
          ]),
          manage && !team.archived
            ? h('div', { class: 'inline-form team-add' }, [
                selectControl({
                  value: state.dialogForm[teamMemberField(team.id)] ?? '',
                  act: 'form-toggle',
                  form: teamMemberField(team.id),
                  ariaLabel: t(state, `إضافة عضو إلى ${team.name}`, `Add a member to ${team.name}`),
                  disabled: addable.length === 0,
                  options: [
                    { value: '', label: addable.length === 0 ? t(state, 'لا يوجد من يُضاف', 'Nobody to add') : t(state, 'اختر عضوًا', 'Choose a member') },
                    ...addable.map((person) => ({ value: person.membership_id, label: person.email })),
                  ],
                }),
                button({
                  label: t(state, 'إضافة عضو', 'Add Member'),
                  icon: 'userPlus',
                  act: 'live-team-add',
                  arg: team.id,
                  small: true,
                  variant: 'primary',
                  disabled: (state.dialogForm[teamMemberField(team.id)] ?? '') === '',
                  busy: live.busy === `team-add:${team.id}`,
                }),
              ])
            : null,
        ]),
        members.length === 0
          ? emptyState({ icon: 'users', title: t(state, 'لا يوجد أعضاء بعد', 'No members yet'), body: t(state, 'أضف أعضاء من مساحة العمل إلى هذا الفريق.', 'Add workspace members to this team.') })
          : h('div', { class: 'tablewrap' }, [
              h('table', { class: 'table admin-table' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', { scope: 'col' }, [t(state, 'العضو', 'Member')]),
                  h('th', { scope: 'col' }, [t(state, 'الدور', 'Role')]),
                  h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
                  h('th', { scope: 'col', class: 'admin-table__actions' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراء', 'Action')])]),
                ])]),
                h('tbody', {}, members.map((person) => h('tr', { 'data-team-member': person.membership_id }, [
                  h('td', { 'data-label': t(state, 'العضو', 'Member') }, [memberCell(state, person)]),
                  h('td', { 'data-label': t(state, 'الدور', 'Role') }, [person.role.name]),
                  h('td', { 'data-label': t(state, 'الحالة', 'Status') }, [statusBadge(state, person.status)]),
                  h('td', { class: 'admin-table__actions' }, [
                    manage
                      ? button({
                          label: t(state, 'إزالة', 'Remove'),
                          icon: 'close',
                          act: 'live-remove-member',
                          arg: `${team.id}:${person.membership_id}`,
                          small: true,
                          variant: 'ghost',
                          title: t(state, `إزالة ${person.email} من ${team.name}`, `Remove ${person.email} from ${team.name}`),
                          busy: live.busy === `team-remove:${team.id}:${person.membership_id}`,
                        })
                      : null,
                  ]),
                ]))),
              ]),
            ]),
      ]),
    ]),
  ]);
}
