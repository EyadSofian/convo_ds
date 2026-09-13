import type { ChannelTestRecipient, ConnectChannelInput } from '../api/channels.js';
import type { ApiError, ApiResult } from '../api/client.js';
import type { Role, ScopeRef } from '../api/people.js';
import type { AppState } from '../state.js';
import type { LiveState } from './store.js';
import { pushToast } from '../state.js';
import { ERROR_CODES, phrase } from '../ui/copy.js';
import { currentTenantId, fromResult, LOADING, reloading } from './store.js';

/**
 * Server-backed actions for the People, Roles and Teams screens.
 *
 * The shape every mutation follows, and the reason for it:
 *
 * 1. mark the specific control busy and clear the last error, then re-render —
 *    the operator sees the click land immediately;
 * 2. await the server;
 * 3. **only then** record success or the server's error, and re-render.
 *
 * Nothing is written to local state optimistically and no toast appears before
 * the response commits, because a toast that fires on click is a claim the
 * server has not made yet. The screens read the returned record, so what is on
 * screen after a change is what the server stored, not what the browser hoped.
 */

export interface LiveContext {
  readonly state: AppState;
  readonly live: LiveState;
  refresh(): void;
  /** Injected so tests get deterministic idempotency keys and timestamps. */
  now(): number;
  newKey(): string;
  /**
   * Closes the workspace after a sign-out.
   *
   * The composition root owns it because it owns what has to go with the
   * session: the live stream, pending timers and every protected list.
   */
  endSession(): void;
  /**
   * Reopens the workspace on another of this user's companies, with nothing
   * from the previous one carried over.
   */
  switchWorkspace(tenantId: string): void;
}

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

/* --------------------------------------------------------------- session -- */

/**
 * Resolves the session and, if there is one, the tenant to work in.
 *
 * A signed-in user with no active membership is signed in but has nowhere to
 * go; that is reported as such rather than as an empty People list.
 */
export async function loadSession(context: LiveContext): Promise<void> {
  const { live } = context;
  const session = await live.api.session();
  if (!session.ok) {
    // A 401 is the ordinary answer for a visitor. Anything else means the
    // question could not be asked, which the gate says instead of a form.
    live.session = session.error.status === 401
      ? { status: 'signed_out', error: null }
      : { status: 'signed_out', error: null, probeError: session.error };
    context.refresh();
    return;
  }
  const memberships = await live.api.memberships();
  if (!memberships.ok) {
    // Without the memberships there is no telling which workspace, if any, this
    // person may open, so the gate says the question could not be answered
    // rather than claiming they belong to none.
    live.session = memberships.error.status === 401
      ? { status: 'signed_out', error: null }
      : { status: 'signed_out', error: null, probeError: memberships.error };
    context.refresh();
    return;
  }
  live.session = {
    status: 'signed_in',
    email: session.data.user.email,
    memberships: memberships.data,
    tenantId: memberships.data[0]?.tenant.id ?? null,
  };
  context.refresh();
}

/**
 * Submits credentials.
 *
 * Success re-reads the session rather than trusting the login response, so the
 * workspace opens on exactly the principal and memberships the server resolves
 * for the new cookie. The screen the operator asked for loads from there.
 */
export async function signIn(context: LiveContext, email: string, password: string): Promise<boolean> {
  const { live } = context;
  live.busy = 'sign-in';
  live.error = null;
  context.refresh();

  const result = await live.api.login(email, password);
  live.busy = null;
  if (!result.ok) {
    // The API answers a bad email and a bad password identically; the screen
    // repeats that answer rather than guessing which one it was.
    live.session = { status: 'signed_out', error: result.error };
    context.refresh();
    return false;
  }
  await loadSession(context);
  return live.session.status === 'signed_in';
}

/**
 * Ends this session on the server, then closes the workspace.
 *
 * The workspace closes whatever the server answered: an operator who pressed
 * Sign out must not be left looking at protected data because the network
 * dropped, and a session the server could not find is already gone.
 */
export async function signOut(context: LiveContext): Promise<void> {
  const { live } = context;
  live.busy = 'sign-out';
  context.refresh();
  await live.api.logout();
  live.busy = null;
  context.endSession();
}

/**
 * Works in another company this user belongs to.
 *
 * Only a membership the server listed can be chosen, and the server re-checks
 * it on every request anyway. The lists of the previous company are dropped so
 * nothing from it is drawn under the new name.
 */
export function switchTenant(context: LiveContext, tenantId: string): boolean {
  const { live } = context;
  if (live.session.status !== 'signed_in' || live.session.tenantId === tenantId) {
    return false;
  }
  if (!live.session.memberships.some((membership) => membership.tenant.id === tenantId)) {
    return false;
  }
  context.switchWorkspace(tenantId);
  return true;
}

/* -------------------------------------------------------------- settings -- */

/** The sessions this user holds, newest activity first as the server orders them. */
export async function loadSettingsScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  if (live.session.status !== 'signed_in') {
    return;
  }
  live.sessions = LOADING;
  context.refresh();
  const result = await live.api.sessions();
  live.sessions = fromResult(result, context.now());
  context.refresh();
}

/** Revokes one of this user's other sessions. The current one signs out instead. */
export async function revokeSession(context: LiveContext, sessionId: string): Promise<boolean> {
  const { live, state } = context;
  live.busy = `revoke-session:${sessionId}`;
  live.error = null;
  context.refresh();
  const result = await live.api.revokeSession(sessionId);
  live.busy = null;
  if (!result.ok) {
    live.error = result.error;
    context.refresh();
    return false;
  }
  pushToast(state, t(state, 'أُنهيت الجلسة', 'Session ended'));
  await loadSettingsScreen(context);
  return true;
}

/* ----------------------------------------------------------------- loads -- */

/** Loads everything the People screen shows, in parallel. */
export async function loadPeopleScreen(context: LiveContext, keep = false): Promise<void> {
  const { live } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return;
  }
  live.people = reloading(live.people, keep);
  live.roles = reloading(live.roles, keep);
  live.teams = reloading(live.teams, keep);
  live.invitations = reloading(live.invitations, keep);
  live.permissions = reloading(live.permissions, keep);
  live.transfers = reloading(live.transfers, keep);
  context.refresh();

  const [people, roles, teams, invitations, permissions, transfers] = await Promise.all([
    live.api.people(tenantId),
    live.api.roles(tenantId),
    live.api.teams(tenantId),
    live.api.invitations(tenantId),
    // The permission catalogue is what the role editor offers as grants. It is
    // fetched with the rest rather than on demand because a select that fills
    // in a moment after the form appears is a select people click through.
    live.api.permissions(tenantId),
    live.api.ownershipTransfers(tenantId),
  ]);
  const now = context.now();
  live.people = fromResult(people, now);
  live.roles = fromResult(roles, now);
  live.teams = fromResult(teams, now);
  live.invitations = fromResult(invitations, now);
  live.permissions = fromResult(permissions, now);
  live.transfers = fromResult(transfers, now);
  context.refresh();
}

/* -------------------------------------------------------------- channels -- */

/**
 * Loads the Channels screen.
 *
 * The catalogue and the connections are separate reads because they answer
 * separate questions: what this build can serve at all, and what this company
 * has actually connected. A screen that showed only the second would make an
 * unimplemented channel look like a missing one.
 */
export async function loadChannelsScreen(context: LiveContext, keep = false): Promise<void> {
  const { live } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return;
  }
  live.connections = reloading(live.connections, keep);
  live.catalogue = reloading(live.catalogue, keep);
  live.testRecipients = reloading(live.testRecipients, keep);
  context.refresh();

  const [connections, catalogue] = await Promise.all([
    live.channels.connections(tenantId),
    live.channels.catalogue(tenantId),
  ]);
  const now = context.now();
  live.connections = fromResult(connections, now);
  live.catalogue = fromResult(catalogue, now);
  if (!connections.ok) {
    live.testRecipients = { status: 'error', error: connections.error };
  } else {
    const results = await Promise.all(connections.data.map((connection) => live.channels.testRecipients(tenantId, connection.id)));
    // One allowlist that could not be read makes the whole list unknown: a
    // partial list would read as "nobody is authorized" on that connection.
    const rows: ChannelTestRecipient[] = [];
    let refusal: ApiError | null = null;
    for (const result of results) {
      if (result.ok) rows.push(...result.data);
      else refusal = result.error;
    }
    live.testRecipients = refusal === null ? { status: 'ready', value: rows, loadedAt: now } : { status: 'error', error: refusal };
  }
  context.refresh();
}

/**
 * Connects an asset and answers with the new connection's id, or `null`.
 *
 * The id is what lets the screen open the connection it just created, which
 * starts unverified; the toast says so rather than implying it works.
 */
export async function connectChannel(
  context: LiveContext,
  input: ConnectChannelInput,
): Promise<string | null> {
  const key = context.newKey();
  let created: string | null = null;
  await mutateChannels(
    context,
    'connect-channel',
    (tenantId) => context.live.channels.connect(tenantId, input, key),
    (connection) => {
      created = connection.id;
      return t(
        context.state,
        `أُضيفت ${connection.display_name}. تحقّق من الاتصال لإكمال الإعداد.`,
        `${connection.display_name} added. Verify the connection to finish setup.`,
      );
    },
  );
  return created;
}

export function testChannel(context: LiveContext, connectionId: string): Promise<boolean> {
  return mutateChannels(
    context,
    `test-channel:${connectionId}`,
    (tenantId) => context.live.channels.test(tenantId, connectionId),
    (connection) =>
      connection.last_error_code === null
        ? t(context.state, 'قبل المزوّد بيانات الاعتماد', 'The provider accepted the credential')
        : t(
            context.state,
            `رفض المزوّد: ${phrase(context.state, ERROR_CODES, connection.last_error_code)}`,
            `The provider refused: ${phrase(context.state, ERROR_CODES, connection.last_error_code)}`,
          ),
  );
}

export function rotateChannelCredential(
  context: LiveContext,
  connectionId: string,
  accessToken: string,
): Promise<boolean> {
  return mutateChannels(
    context,
    `rotate-channel:${connectionId}`,
    (tenantId) => context.live.channels.rotate(tenantId, connectionId, accessToken),
    () =>
      t(
        context.state,
        'حُفظ الاعتماد الجديد — يحتاج اختبارًا ليُثبت أنه يعمل',
        'The new credential is stored — test it to prove it works',
      ),
  );
}

export function disconnectChannel(context: LiveContext, connectionId: string): Promise<boolean> {
  return mutateChannels(
    context,
    `disconnect-channel:${connectionId}`,
    (tenantId) => context.live.channels.disconnect(tenantId, connectionId),
    () => t(context.state, 'فُصلت القناة وأُلغيت اعتماداتها', 'Disconnected, and its credentials revoked'),
  );
}

export function authorizeTestRecipient(
  context: LiveContext,
  connectionId: string,
  peerIdentity: string,
  label: string,
): Promise<boolean> {
  return mutateChannels(
    context,
    `authorize-test-recipient:${connectionId}`,
    (tenantId) => context.live.channels.authorizeTestRecipient(tenantId, connectionId, peerIdentity, label),
    (recipient) => t(context.state, `اعتُمد ${recipient.label} كمستلم اختبار`, `${recipient.label} authorized for test sends`),
  );
}

export function revokeTestRecipient(context: LiveContext, connectionId: string, id: string): Promise<boolean> {
  return mutateChannels(
    context,
    `revoke-test-recipient:${id}`,
    (tenantId) => context.live.channels.revokeTestRecipient(tenantId, connectionId, id),
    () => t(context.state, 'أُلغي تصريح مستلم الاختبار', 'Test recipient authorization revoked'),
  );
}

/* ------------------------------------------------------------- mutations -- */

/**
 * Runs one mutation with the pending/settle discipline above.
 *
 * `onOk` gets the server's own response, so callers refresh from what was
 * stored rather than patching local state to what they asked for.
 */
async function mutate<T>(
  context: LiveContext,
  busyKey: string,
  run: (tenantId: string) => Promise<ApiResult<T>>,
  onOk: (value: T) => string,
): Promise<boolean> {
  const { live, state } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return false;
  }
  live.busy = busyKey;
  live.error = null;
  context.refresh();

  const result = await run(tenantId);
  live.busy = null;
  live.revision += 1;

  if (!result.ok) {
    live.error = result.error;
    context.refresh();
    return false;
  }
  // The toast is here, after the server committed — never on the click.
  pushToast(state, onOk(result.data));
  await loadPeopleScreen(context, true);
  return true;
}

/** The same discipline as `mutate`, reloading the Channels screen instead. */
async function mutateChannels<T>(
  context: LiveContext,
  busyKey: string,
  run: (tenantId: string) => Promise<ApiResult<T>>,
  onOk: (value: T) => string,
): Promise<boolean> {
  const { live, state } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return false;
  }
  live.busy = busyKey;
  live.error = null;
  context.refresh();

  const result = await run(tenantId);
  live.busy = null;
  live.revision += 1;

  if (!result.ok) {
    live.error = result.error;
    context.refresh();
    return false;
  }
  pushToast(state, onOk(result.data));
  await loadChannelsScreen(context, true);
  return true;
}

export function invitePerson(
  context: LiveContext,
  email: string,
  roleId: string,
  scopes: readonly ScopeRef[],
): Promise<boolean> {
  // The key is minted once per attempt, so a retry of the *same* attempt
  // replays and a genuinely new invitation gets a new key.
  const key = context.newKey();
  return mutate(
    context,
    'invite',
    (tenantId) => context.live.api.invite(tenantId, { email, roleId, scopes }, key),
    (invitation) =>
      t(
        context.state,
        `أُرسلت دعوة إلى ${invitation.email}`,
        `Invitation sent to ${invitation.email}`,
      ),
  );
}

export function revokeInvitation(context: LiveContext, invitationId: string): Promise<boolean> {
  return mutate(
    context,
    `revoke-invite:${invitationId}`,
    (tenantId) => context.live.api.revokeInvitation(tenantId, invitationId),
    () => t(context.state, 'أُلغيت الدعوة', 'Invitation revoked'),
  );
}

export function changeRole(
  context: LiveContext,
  membershipId: string,
  roleId: string,
): Promise<boolean> {
  return mutate(
    context,
    `role:${membershipId}`,
    (tenantId) => context.live.api.updateMembership(tenantId, membershipId, { roleId }),
    (person) =>
      t(context.state, `الدور الآن ${person.role.name}`, `Role is now ${person.role.name}`),
  );
}

const MEMBER_STATUS_WORDS: Readonly<Record<string, { readonly ar: string; readonly en: string }>> = {
  active: { ar: 'نشط', en: 'Active' },
  suspended: { ar: 'موقوف', en: 'Suspended' },
  revoked: { ar: 'ملغى', en: 'Revoked' },
};

export function changeStatus(
  context: LiveContext,
  membershipId: string,
  status: string,
): Promise<boolean> {
  return mutate(
    context,
    `status:${membershipId}`,
    (tenantId) => context.live.api.updateMembership(tenantId, membershipId, { status }),
    (person) => {
      const word = MEMBER_STATUS_WORDS[person.status];
      return word === undefined
        ? t(context.state, `الحالة الآن ${person.status}`, `Status is now ${person.status}`)
        : t(context.state, `الحالة الآن: ${word.ar}`, `Status is now ${word.en}`);
    },
  );
}

export function changeScopes(
  context: LiveContext,
  membershipId: string,
  scopes: readonly ScopeRef[],
): Promise<boolean> {
  return mutate(
    context,
    `scopes:${membershipId}`,
    (tenantId) => context.live.api.updateMembership(tenantId, membershipId, { scopes }),
    () => t(context.state, 'تم تحديث النطاقات', 'Scopes updated'),
  );
}

export function createRole(
  context: LiveContext,
  name: string,
  description: string,
  grants: readonly { permission: string; scope: string }[],
): Promise<boolean> {
  return mutate(
    context,
    'create-role',
    (tenantId) => context.live.api.createRole(tenantId, { name, description, grants }),
    (role) => t(context.state, `أُنشئ الدور ${role.name}`, `Created the role ${role.name}`),
  );
}

/**
 * Renames a custom role, keeping the grants it already has.
 *
 * The grants come from the role the server returned, not from a local copy of
 * what the browser thinks they are, so a rename cannot silently widen or narrow
 * what the role can do.
 */
export function renameRole(context: LiveContext, role: Role, name: string): Promise<boolean> {
  return mutate(
    context,
    `rename-role:${role.id}`,
    (tenantId) =>
      context.live.api.updateRole(tenantId, role.id, {
        name,
        description: '',
        grants: role.grants.map((grant) => ({
          permission: grant.permission_key,
          scope: grant.scope_level,
        })),
      }),
    (updated) => t(context.state, `أُعيدت تسمية الدور ${updated.name}`, `Renamed to ${updated.name}`),
  );
}

export function deleteRole(context: LiveContext, roleId: string): Promise<boolean> {
  return mutate(
    context,
    `delete-role:${roleId}`,
    (tenantId) => context.live.api.deleteRole(tenantId, roleId),
    () => t(context.state, 'حُذف الدور', 'Role deleted'),
  );
}

export function createTeam(context: LiveContext, name: string): Promise<boolean> {
  return mutate(
    context,
    'create-team',
    (tenantId) => context.live.api.createTeam(tenantId, name),
    (team) => t(context.state, `أُنشئ الفريق ${team.name}`, `Created the team ${team.name}`),
  );
}

export function archiveTeam(context: LiveContext, teamId: string, archived: boolean): Promise<boolean> {
  return mutate(
    context,
    `archive-team:${teamId}`,
    (tenantId) => context.live.api.updateTeam(tenantId, teamId, { archived }),
    () =>
      archived
        ? t(context.state, 'أُرشف الفريق', 'Team archived')
        : t(context.state, 'أُعيد الفريق', 'Team restored'),
  );
}

export function addTeamMember(
  context: LiveContext,
  teamId: string,
  membershipId: string,
): Promise<boolean> {
  return mutate(
    context,
    `team-add:${teamId}`,
    (tenantId) => context.live.api.addTeamMember(tenantId, teamId, membershipId),
    () => t(context.state, 'أُضيف العضو للفريق', 'Added to the team'),
  );
}

export function removeTeamMember(
  context: LiveContext,
  teamId: string,
  membershipId: string,
): Promise<boolean> {
  return mutate(
    context,
    `team-remove:${teamId}:${membershipId}`,
    (tenantId) => context.live.api.removeTeamMember(tenantId, teamId, membershipId),
    () => t(context.state, 'أُزيل العضو من الفريق', 'Removed from the team'),
  );
}

export function offerOwnership(context: LiveContext, membershipId: string): Promise<boolean> {
  return mutate(
    context,
    'offer-ownership',
    (tenantId) => context.live.api.offerOwnership(tenantId, membershipId),
    () =>
      t(
        context.state,
        'أُرسل عرض نقل الملكية، وينتظر قبول المستلم',
        'Ownership offered; it is waiting for the recipient to accept',
      ),
  );
}

export function settleOwnership(
  context: LiveContext,
  transferId: string,
  decision: 'accept' | 'decline' | 'cancel',
): Promise<boolean> {
  const api = context.live.api;
  return mutate(
    context,
    `ownership:${transferId}`,
    (tenantId) =>
      decision === 'accept'
        ? api.acceptOwnership(tenantId, transferId)
        : decision === 'decline'
          ? api.declineOwnership(tenantId, transferId)
          : api.cancelOwnership(tenantId, transferId),
    () =>
      decision === 'accept'
        ? t(context.state, 'تم نقل الملكية', 'Ownership transferred')
        : decision === 'decline'
          ? t(context.state, 'رُفض عرض الملكية', 'Ownership offer declined')
          : t(context.state, 'أُلغي عرض الملكية', 'Ownership offer cancelled'),
  );
}

