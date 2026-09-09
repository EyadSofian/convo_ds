import type { ApiError } from '../api/client.js';
import type { Invitation, OwnershipTransfer, Person, Role, Team } from '../api/people.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { roleNameField, teamMemberField } from '../live/dispatch.js';
import { isDenial, isUnauthenticated, rowsOf, type LiveState, type Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { button, isolated, pill, selectControl, stateBox } from './parts.js';

/**
 * People, Roles and Teams — the first screen backed entirely by the API.
 *
 * Nothing here reads the demo dataset. Every list is a `Resource`, so the four
 * answers the server can give — not asked yet, waiting, refused, here it is —
 * each get their own rendering instead of collapsing into a blank table.
 *
 * Every control that starts a mutation is disabled while that mutation is in
 * flight, and the server's rejection is shown beside the form that caused it.
 * No success is drawn before the response commits.
 */

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

export function renderPeople(state: AppState): HTMLElement {
  const live = state.live;

  if (live.session.status === 'unknown') {
    return frame(state, null, [busyNotice(state)]);
  }
  if (live.session.status === 'signed_out') {
    // The session is narrowed once, here, and what the branches need is passed
    // down. Re-asking `status === 'signed_out'` inside the form would be a
    // question with only one possible answer and a second, unreachable arm.
    return frame(state, null, [signInForm(state, live, live.session.error)]);
  }
  if (live.session.tenantId === null) {
    return frame(state, live.session.email, [
      stateBox({
        kind: 'info',
        iconName: 'users',
        title: t(state, 'لا توجد عضوية نشطة', 'No active membership'),
        body: t(
          state,
          'حسابك مسجّل دخوله لكنه لا ينتمي إلى شركة نشطة، فلا توجد صفحة أفراد لعرضها.',
          'You are signed in, but your account does not belong to an active company, so there is no People page to show.',
        ),
        actionLabel: t(state, 'تسجيل الخروج', 'Sign out'),
        act: 'live-signout',
      }),
    ]);
  }

  return frame(state, live.session.email, [
    section(state, t(state, 'الأفراد', 'People'), peopleSection(state, live)),
    section(state, t(state, 'الدعوات', 'Invitations'), invitationsSection(state, live)),
    section(state, t(state, 'الأدوار', 'Roles'), rolesSection(state, live)),
    section(state, t(state, 'الفرق', 'Teams'), teamsSection(state, live)),
    section(state, t(state, 'نقل الملكية', 'Ownership'), ownershipSection(state, live)),
  ]);
}

/* ------------------------------------------------------------------ shell -- */

function frame(state: AppState, email: string | null, children: readonly Child[]): HTMLElement {
  const live = state.live;
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    h('div', { class: 'workspace__intro' }, [
      h('div', { class: 'workspace__introtext' }, [
        h('h1', { class: 'workspace__heading' }, [t(state, 'الأفراد والأدوار', 'People & roles')]),
        h('p', { class: 'workspace__lede' }, [
          t(
            state,
            'هذه الشاشة متصلة بالخادم فعليًا. كل تغيير هنا يستدعي نقطة نهاية موثّقة، ولا يظهر نجاح قبل أن يؤكّده الخادم.',
            'This screen talks to the server. Every change here calls a documented endpoint, and no success is shown before the server confirms it.',
          ),
        ]),
      ]),
      email === null
        ? null
        : h('div', { class: 'workspace__actions' }, [
            h('span', { class: 'pill' }, [isolated(email)]),
            button({
              label: t(state, 'تحديث', 'Reload'),
              icon: 'refresh',
              act: 'live-reload',
              small: true,
              disabled: live.busy !== null,
            }),
            button({
              label: t(state, 'تسجيل الخروج', 'Sign out'),
              act: 'live-signout',
              small: true,
              variant: 'ghost',
              disabled: live.busy === 'sign-out',
            }),
          ]),
    ]),
    ...children,
  ]);
}

function section(state: AppState, title: string, body: Child): HTMLElement {
  return h('section', { class: 'card', 'aria-label': title }, [
    h('div', { class: 'card__header' }, [h('h2', { class: 'card__title' }, [title])]),
    body,
  ]);
}

function busyNotice(state: AppState): HTMLElement {
  return h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    h('span', { class: 'visually-hidden' }, [t(state, 'جارٍ التحميل', 'Loading')]),
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
    return busyNotice(state);
  }
  if (resource.status === 'error') {
    return errorView(state, resource.error);
  }
  if (resource.value.length === 0) {
    return stateBox({ kind: 'empty', iconName: 'users', title: empty.title, body: empty.body });
  }
  return render(resource.value);
}

/**
 * The server's refusal, in the operator's terms.
 *
 * A denial is a state, not an error: the action exists and the endpoint
 * enforces it, so the screen says so rather than hiding the section and
 * pretending it was never there.
 */
function errorView(state: AppState, error: ApiError): Child {
  if (isUnauthenticated(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'انتهت الجلسة', 'Your session ended'),
      body: t(state, 'سجّل الدخول من جديد للمتابعة.', 'Sign in again to continue.'),
      actionLabel: t(state, 'تسجيل الخروج', 'Sign out'),
      act: 'live-signout',
    });
  }
  if (isDenial(error)) {
    return stateBox({
      kind: 'denied',
      iconName: 'lock',
      title: t(state, 'لا تملك صلاحية هذا العرض', 'You do not have permission for this'),
      body: t(
        state,
        'الخادم رفض الطلب بالمفتاح المطلوب. إخفاء الزر ليس ضابط تفويض — الرفض يحدث على الخادم.',
        'The server refused this by permission key. Hiding the control is not an authorization control; the refusal happens on the server.',
      ),
    });
  }
  return stateBox({
    kind: 'offline',
    iconName: error.code === 'network' ? 'wifiOff' : 'alert',
    title:
      error.code === 'network'
        ? t(state, 'تعذّر الوصول إلى الخادم', 'Could not reach the server')
        : t(state, 'رفض الخادم الطلب', 'The server rejected the request'),
    body: `${error.message}${error.requestId === null ? '' : ` · ${error.requestId}`}`,
    actionLabel: t(state, 'إعادة المحاولة', 'Try again'),
    act: 'live-reload',
  });
}

/** The last mutation's rejection, shown beside the form that caused it. */
function mutationError(state: AppState, live: LiveState): Child {
  if (live.error === null) {
    return null;
  }
  const detail = live.error.details
    .map((entry) => `${entry.field}: ${entry.message}`)
    .join(' · ');
  return h('div', { class: 'banner banner--danger', role: 'alert' }, [
    h('span', {}, [live.error.message]),
    detail === '' ? null : h('span', { class: 'banner__spacer' }),
    detail === '' ? null : h('span', {}, [detail]),
  ]);
}

/* ---------------------------------------------------------------- sign in -- */

function signInForm(state: AppState, live: LiveState, error: ApiError | null): HTMLElement {
  return h('section', { class: 'card', 'aria-label': t(state, 'تسجيل الدخول', 'Sign in') }, [
    h('div', { class: 'card__header' }, [
      h('h2', { class: 'card__title' }, [t(state, 'تسجيل الدخول', 'Sign in')]),
    ]),
    h('div', { class: 'card__body' }, [
      h('p', {}, [
        t(
          state,
          'شاشة الأفراد تحتاج جلسة حقيقية. الخادم يرد بنفس الرسالة للبريد الخطأ وكلمة المرور الخطأ.',
          'The People screen needs a real session. The server answers a wrong address and a wrong password the same way.',
        ),
      ]),
      error === null
        ? null
        : h('div', { class: 'banner banner--danger', role: 'alert' }, [error.message]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'signin-email' }, [
          t(state, 'البريد الإلكتروني', 'Email'),
        ]),
        h('input', {
          id: 'signin-email',
          class: 'input',
          type: 'email',
          autocomplete: 'username',
          value: state.dialogForm['signinEmail'] ?? '',
          'data-act': 'form',
          'data-form': 'signinEmail',
        }),
      ]),
      h('div', { class: 'field' }, [
        h('label', { class: 'field__label', for: 'signin-password' }, [
          t(state, 'كلمة المرور', 'Password'),
        ]),
        h('input', {
          id: 'signin-password',
          class: 'input',
          type: 'password',
          autocomplete: 'current-password',
          value: state.dialogForm['signinPassword'] ?? '',
          'data-act': 'form',
          'data-form': 'signinPassword',
        }),
      ]),
      h('div', { class: 'workspace__actions' }, [
        button({
          label: live.busy === 'sign-in' ? t(state, 'جارٍ الدخول…', 'Signing in…') : t(state, 'دخول', 'Sign in'),
          act: 'live-signin',
          variant: 'primary',
          disabled: live.busy === 'sign-in',
        }),
      ]),
    ]),
  ]);
}

/* ----------------------------------------------------------------- people -- */

function roleOptions(live: LiveState): readonly { value: string; label: string }[] {
  return rowsOf(live.roles).map((role) => ({ value: role.id, label: role.name }));
}

function peopleSection(state: AppState, live: LiveState): Child {
  return h('div', { class: 'card__body' }, [
    mutationError(state, live),
    resourceView(
      state,
      live.people,
      {
        title: t(state, 'لا يوجد أفراد', 'Nobody here yet'),
        body: t(state, 'ادعُ زميلًا للبدء.', 'Invite a colleague to get started.'),
      },
      (rows) =>
        h('div', { class: 'tablewrap' }, [
          h('table', { class: 'table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', {}, [t(state, 'البريد', 'Email')]),
                h('th', {}, [t(state, 'الدور', 'Role')]),
                h('th', {}, [t(state, 'الحالة', 'Status')]),
                h('th', {}, [t(state, 'النطاق', 'Scope')]),
                h('th', {}, [t(state, 'إجراءات', 'Actions')]),
              ]),
            ]),
            h('tbody', {}, rows.map((person) => personRow(state, live, person))),
          ]),
        ]),
    ),
  ]);
}

function personRow(state: AppState, live: LiveState, person: Person): HTMLElement {
  const roleBusy = live.busy === `role:${person.membership_id}`;
  const statusBusy = live.busy === `status:${person.membership_id}`;
  return h('tr', { 'data-membership': person.membership_id }, [
    h('td', {}, [isolated(person.email, true)]),
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
        ? pill(t(state, 'بلا نطاق', 'No scope'), 'warning')
        : h(
            'span',
            { class: 'labelset' },
            person.scopes.map((scope) =>
              pill(scope.type === 'tenant' ? t(state, 'الشركة كلها', 'Whole company') : scope.type),
            ),
          ),
    ]),
    h('td', {}, [
      h('span', { class: 'workspace__actions' }, [
        button({
          label: t(state, 'نطاق الشركة', 'Whole company'),
          act: 'live-scope-tenant',
          arg: person.membership_id,
          small: true,
          disabled: live.busy === `scopes:${person.membership_id}`,
        }),
        button({
          label: t(state, 'عرض الملكية', 'Offer ownership'),
          act: 'live-offer-ownership',
          arg: person.membership_id,
          small: true,
          variant: 'ghost',
          disabled: live.busy === 'offer-ownership',
        }),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ invitations -- */

function invitationsSection(state: AppState, live: LiveState): Child {
  const inviting = live.busy === 'invite';
  return h('div', { class: 'card__body' }, [
    h('div', { class: 'filterbar' }, [
      h('span', { class: 'searchbox', style: 'flex:1 1 16rem' }, [
        h('input', {
          class: 'input',
          type: 'email',
          placeholder: t(state, 'بريد الزميل', 'Colleague’s email'),
          'aria-label': t(state, 'بريد الدعوة', 'Invitation email'),
          value: state.dialogForm['inviteEmail'] ?? '',
          'data-act': 'form',
          'data-form': 'inviteEmail',
        }),
      ]),
      selectControl({
        value: state.dialogForm['inviteRole'] ?? '',
        act: 'form',
        form: 'inviteRole',
        ariaLabel: t(state, 'دور الدعوة', 'Invitation role'),
        disabled: live.roles.status !== 'ready',
        options: [
          { value: '', label: t(state, 'اختر دورًا', 'Choose a role') },
          ...roleOptions(live),
        ],
      }),
      button({
        label: inviting ? t(state, 'جارٍ الإرسال…', 'Sending…') : t(state, 'دعوة', 'Invite'),
        icon: 'plus',
        act: 'live-invite',
        variant: 'primary',
        small: true,
        disabled: inviting,
      }),
    ]),
    mutationError(state, live),
    resourceView(
      state,
      live.invitations,
      {
        title: t(state, 'لا دعوات', 'No invitations'),
        body: t(state, 'كل من دُعي انضم بالفعل.', 'Everyone invited has already joined.'),
      },
      (rows) =>
        h('div', { class: 'tablewrap' }, [
          h('table', { class: 'table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', {}, [t(state, 'البريد', 'Email')]),
                h('th', {}, [t(state, 'الدور', 'Role')]),
                h('th', {}, [t(state, 'الحالة', 'Status')]),
                h('th', {}, [t(state, 'إجراء', 'Action')]),
              ]),
            ]),
            h('tbody', {}, rows.map((invitation) => invitationRow(state, live, invitation))),
          ]),
        ]),
    ),
  ]);
}

function invitationRow(state: AppState, live: LiveState, invitation: Invitation): HTMLElement {
  const tone = invitation.status === 'pending' ? 'accent' : invitation.status === 'accepted' ? 'success' : 'neutral';
  return h('tr', {}, [
    h('td', {}, [isolated(invitation.email, true)]),
    h('td', {}, [invitation.role.name]),
    h('td', {}, [pill(invitation.status, tone)]),
    h('td', {}, [
      invitation.status === 'pending'
        ? button({
            label: t(state, 'إلغاء', 'Revoke'),
            act: 'live-revoke-invite',
            arg: invitation.id,
            small: true,
            variant: 'danger',
            disabled: live.busy === `revoke-invite:${invitation.id}`,
          })
        : h('span', { class: 'field__hint' }, ['—']),
    ]),
  ]);
}

/* ------------------------------------------------------------------ roles -- */

/**
 * The keys a custom role may be given, as the server lists them.
 *
 * Only delegable keys appear: `canAuthorRole` refuses the rest, so offering
 * them would be offering a choice that is always rejected.
 */
function grantOptions(live: LiveState): readonly { value: string; label: string }[] {
  return rowsOf(live.permissions)
    .filter((permission) => permission.delegable)
    .map((permission) => ({ value: permission.key, label: permission.key }));
}

function rolesSection(state: AppState, live: LiveState): Child {
  const creating = live.busy === 'create-role';
  const grants = grantOptions(live);
  const chosenGrant = state.dialogForm['roleGrant'] ?? '';
  const chosenScope = state.dialogForm['roleScope'] ?? '';
  return h('div', { class: 'card__body' }, [
    h('p', { class: 'field__hint' }, [
      t(
        state,
        'الأدوار المدمجة غير قابلة للتعديل — تمنعها قاعدة البيانات نفسها. الدور المخصّص لا يحمل إلا مفاتيح قابلة للتفويض تملكها أنت.',
        'Built-in roles cannot be edited — the database refuses it. A custom role may only carry delegable keys you already hold.',
      ),
    ]),
    h('div', { class: 'filterbar' }, [
      h('span', { class: 'searchbox', style: 'flex:1 1 14rem' }, [
        h('input', {
          class: 'input',
          placeholder: t(state, 'اسم الدور الجديد', 'New role name'),
          'aria-label': t(state, 'اسم الدور', 'Role name'),
          value: state.dialogForm['roleName'] ?? '',
          'data-act': 'form',
          'data-form': 'roleName',
        }),
      ]),
      selectControl({
        value: chosenGrant,
        act: 'form',
        form: 'roleGrant',
        ariaLabel: t(state, 'أول منحة', 'First grant'),
        disabled: grants.length === 0,
        options: [{ value: '', label: t(state, 'اختر مفتاحًا', 'Choose a permission') }, ...grants],
      }),
      selectControl({
        value: chosenScope,
        act: 'form',
        form: 'roleScope',
        ariaLabel: t(state, 'نطاق المنحة', 'Grant scope'),
        options: [
          { value: '', label: t(state, 'اختر نطاقًا', 'Choose a scope') },
          { value: 'tenant', label: t(state, 'الشركة كلها', 'Whole company') },
          { value: 'scoped', label: t(state, 'نطاق محدّد', 'Scoped') },
          { value: 'own', label: t(state, 'الخاص به', 'Own') },
        ],
      }),
      button({
        label: creating ? t(state, 'جارٍ الإنشاء…', 'Creating…') : t(state, 'إنشاء دور', 'Create role'),
        icon: 'plus',
        act: 'live-create-role',
        variant: 'primary',
        small: true,
        // A role with no grant is a role that can do nothing, and the server
        // rejects an empty grant list anyway. Requiring both choices here is a
        // convenience, not the control: the refusal still happens on the server.
        disabled: creating || chosenGrant === '' || chosenScope === '',
      }),
    ]),
    mutationError(state, live),
    // The catalogue is what the editor above offers, so its own failure is
    // reported rather than silently leaving an empty select.
    live.permissions.status === 'error' ? errorView(state, live.permissions.error) : null,
    resourceView(
      state,
      live.roles,
      {
        title: t(state, 'لا أدوار', 'No roles'),
        body: t(state, 'لم تُزرع الأدوار المدمجة بعد.', 'The built-in roles have not been seeded.'),
      },
      (rows) => h('div', { class: 'rolegrid' }, rows.map((role) => roleCard(state, live, role))),
    ),
  ]);
}

function roleCard(state: AppState, live: LiveState, role: Role): HTMLElement {
  const nameField = roleNameField(role.id);
  return h('div', { class: 'card', 'data-role': role.key }, [
    h('div', { class: 'card__header' }, [
      h('span', { class: 'card__title' }, [role.name]),
      h('span', { class: 'card__spacer' }),
      role.is_builtin
        ? pill(t(state, 'مدمج', 'Built-in'), 'neutral', 'shield')
        : button({
            label: t(state, 'حذف', 'Delete'),
            act: 'live-delete-role',
            arg: role.id,
            small: true,
            variant: 'danger',
            disabled: live.busy === `delete-role:${role.id}`,
          }),
    ]),
    h('div', { class: 'rolegrid__key' }, [
      `${String(role.grants.length)} ${t(state, 'منحة', 'grants')}`,
    ]),
    h(
      'div',
      { class: 'labelset' },
      role.grants
        .slice(0, 6)
        .map((grant) => pill(`${grant.permission_key} · ${grant.scope_level}`, 'neutral')),
    ),
    // Renaming is offered only where it is possible: a built-in role's name is
    // refused by the database, so the card does not pretend otherwise.
    role.is_builtin
      ? null
      : h('div', { class: 'filterbar' }, [
          h('span', { class: 'searchbox', style: 'flex:1 1 8rem' }, [
            h('input', {
              class: 'input',
              placeholder: role.name,
              'aria-label': t(state, `اسم جديد للدور ${role.name}`, `New name for ${role.name}`),
              value: state.dialogForm[nameField] ?? '',
              // `form-toggle`, because this value gates the Rename button.
              'data-act': 'form-toggle',
              'data-form': nameField,
            }),
          ]),
          button({
            label: t(state, 'إعادة تسمية', 'Rename'),
            act: 'live-rename-role',
            arg: role.id,
            small: true,
            disabled:
              live.busy === `rename-role:${role.id}` || (state.dialogForm[nameField] ?? '') === '',
          }),
        ]),
  ]);
}

/* ------------------------------------------------------------------ teams -- */

function teamsSection(state: AppState, live: LiveState): Child {
  const creating = live.busy === 'create-team';
  const members = rowsOf(live.people).map((person) => ({
    value: person.membership_id,
    label: person.email,
  }));
  return h('div', { class: 'card__body' }, [
    h('div', { class: 'filterbar' }, [
      h('span', { class: 'searchbox', style: 'flex:1 1 14rem' }, [
        h('input', {
          class: 'input',
          placeholder: t(state, 'اسم الفريق', 'Team name'),
          'aria-label': t(state, 'اسم الفريق', 'Team name'),
          value: state.dialogForm['teamName'] ?? '',
          'data-act': 'form',
          'data-form': 'teamName',
        }),
      ]),
      button({
        label: creating ? t(state, 'جارٍ الإنشاء…', 'Creating…') : t(state, 'إنشاء فريق', 'Create team'),
        icon: 'plus',
        act: 'live-create-team',
        variant: 'primary',
        small: true,
        disabled: creating,
      }),
    ]),
    mutationError(state, live),
    resourceView(
      state,
      live.teams,
      {
        title: t(state, 'لا فرق', 'No teams'),
        body: t(state, 'أنشئ فريقًا لتوجيه العمل إليه.', 'Create a team to route work to.'),
      },
      (rows) =>
        h('div', { class: 'grid2' }, rows.map((team) => teamCard(state, live, team, members))),
    ),
  ]);
}

function teamCard(
  state: AppState,
  live: LiveState,
  team: Team,
  candidates: readonly { value: string; label: string }[],
): HTMLElement {
  // Somebody already in the team is not a candidate to add to it.
  const inTeam = new Set(team.members.map((member) => member.membership_id));
  const addable = candidates.filter((candidate) => !inTeam.has(candidate.value));
  const settling = live.busy === `archive-team:${team.id}`;
  return h('div', { class: 'card', 'data-team': team.id }, [
    h('div', { class: 'card__header' }, [
      h('span', { class: 'card__title' }, [team.name]),
      h('span', { class: 'card__spacer' }),
      team.archived ? pill(t(state, 'مؤرشف', 'Archived'), 'warning', 'eyeOff') : null,
      pill(`${String(team.member_count)} ${t(state, 'عضو', 'members')}`, 'neutral'),
    ]),
    // The members themselves, not just how many there are: an administrator who
    // added the wrong person needs to see it and undo it.
    team.members.length === 0
      ? h('p', { class: 'field__hint' }, [t(state, 'لا أعضاء بعد.', 'No members yet.')])
      : h(
          'ul',
          { class: 'memberlist' },
          team.members.map((member) =>
            h('li', { class: 'memberlist__item' }, [
              isolated(member.email, true),
              button({
                label: t(state, 'إزالة', 'Remove'),
                act: 'live-remove-member',
                arg: `${team.id}:${member.membership_id}`,
                small: true,
                variant: 'ghost',
                disabled: live.busy === `team-remove:${team.id}:${member.membership_id}`,
              }),
            ]),
          ),
        ),
    h('div', { class: 'filterbar' }, [
      selectControl({
        value: state.dialogForm[teamMemberField(team.id)] ?? '',
        act: 'form',
        form: teamMemberField(team.id),
        ariaLabel: t(state, `إضافة عضو إلى ${team.name}`, `Add a member to ${team.name}`),
        // An archived team takes no new members; the server refuses it too.
        disabled: addable.length === 0 || team.archived,
        options: [{ value: '', label: t(state, 'اختر عضوًا', 'Choose a member') }, ...addable],
      }),
      button({
        label: t(state, 'إضافة', 'Add'),
        act: 'live-team-add',
        arg: team.id,
        small: true,
        disabled: live.busy === `team-add:${team.id}` || team.archived,
      }),
      team.archived
        ? button({
            label: t(state, 'إعادة', 'Restore'),
            act: 'live-archive-team',
            arg: `${team.id}:restore`,
            small: true,
            variant: 'ghost',
            disabled: settling,
          })
        : button({
            label: t(state, 'أرشفة', 'Archive'),
            act: 'live-archive-team',
            arg: `${team.id}:archive`,
            small: true,
            variant: 'ghost',
            disabled: settling,
          }),
    ]),
  ]);
}

/* -------------------------------------------------------------- ownership -- */

function ownershipSection(state: AppState, live: LiveState): Child {
  return h('div', { class: 'card__body' }, [
    h('p', { class: 'field__hint' }, [
      t(
        state,
        'نقل الملكية عرض يقبله المستلم، لا إجراء يفرضه المالك. المستلم وحده يقبل أو يرفض، والمالك وحده يلغي.',
        'Ownership transfer is an offer the recipient accepts, not something an Owner does to somebody. Only the recipient may accept or decline, and only the offerer may cancel.',
      ),
    ]),
    mutationError(state, live),
    resourceView(
      state,
      live.transfers,
      {
        title: t(state, 'لا عروض ملكية', 'No ownership offers'),
        body: t(state, 'لم يُعرض نقل الملكية على أحد.', 'Ownership has not been offered to anyone.'),
      },
      (rows) => h('div', { class: 'history' }, rows.map((row) => transferRow(state, live, row))),
    ),
  ]);
}

function transferRow(state: AppState, live: LiveState, transfer: OwnershipTransfer): HTMLElement {
  const busy = live.busy === `ownership:${transfer.id}`;
  return h('div', { class: 'history__item' }, [
    h('span', { class: 'history__title' }, [
      `${t(state, 'عرض ملكية', 'Ownership offer')} · ${transfer.status}`,
    ]),
    h('span', {}, [isolated(transfer.to_membership, true)]),
    transfer.status !== 'pending'
      ? null
      : h('span', { class: 'workspace__actions' }, [
          button({
            label: t(state, 'قبول', 'Accept'),
            act: 'live-ownership',
            arg: `${transfer.id}:accept`,
            small: true,
            variant: 'primary',
            disabled: busy,
          }),
          button({
            label: t(state, 'رفض', 'Decline'),
            act: 'live-ownership',
            arg: `${transfer.id}:decline`,
            small: true,
            disabled: busy,
          }),
          button({
            label: t(state, 'إلغاء العرض', 'Cancel offer'),
            act: 'live-ownership',
            arg: `${transfer.id}:cancel`,
            small: true,
            variant: 'ghost',
            disabled: busy,
          }),
        ]),
  ]);
}
