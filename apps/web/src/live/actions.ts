import type { ConnectChannelInput } from '../api/channels.js';
import type { ApiResult } from '../api/client.js';
import type { Role, ScopeRef } from '../api/people.js';
import type { AppState } from '../state.js';
import { pushToast } from '../state.js';
import type { LiveState } from './store.js';
import { currentTenantId, failed, fromResult, LOADING } from './store.js';

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
    live.session = { status: 'signed_out', error: session.error.status === 401 ? null : session.error };
    context.refresh();
    return;
  }
  const memberships = await live.api.memberships();
  live.session = {
    status: 'signed_in',
    email: session.data.user.email,
    memberships: memberships.ok ? memberships.data : [],
    tenantId: memberships.ok ? (memberships.data[0]?.tenant.id ?? null) : null,
  };
  context.refresh();
}

export async function signIn(context: LiveContext, email: string, password: string): Promise<void> {
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
    return;
  }
  await loadSession(context);
  // Signing in lands on the screen the operator was already looking at, so the
  // lists are fetched here rather than leaving it on a skeleton until it is
  // reloaded by hand.
  await loadPeopleScreen(context);
}

export async function signOut(context: LiveContext): Promise<void> {
  const { live } = context;
  live.busy = 'sign-out';
  context.refresh();
  await live.api.logout();
  live.busy = null;
  live.session = { status: 'signed_out', error: null };
  resetResources(live);
  context.refresh();
}

/* ----------------------------------------------------------------- loads -- */

/** Loads everything the People screen shows, in parallel. */
export async function loadPeopleScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return;
  }
  live.people = LOADING;
  live.roles = LOADING;
  live.teams = LOADING;
  live.invitations = LOADING;
  live.permissions = LOADING;
  live.transfers = LOADING;
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
export async function loadChannelsScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null) {
    return;
  }
  live.connections = LOADING;
  live.catalogue = LOADING;
  context.refresh();

  const [connections, catalogue] = await Promise.all([
    live.channels.connections(tenantId),
    live.channels.catalogue(tenantId),
  ]);
  const now = context.now();
  live.connections = fromResult(connections, now);
  live.catalogue = fromResult(catalogue, now);
  context.refresh();
}

export function connectChannel(
  context: LiveContext,
  input: ConnectChannelInput,
): Promise<boolean> {
  const key = context.newKey();
  return mutateChannels(
    context,
    'connect-channel',
    (tenantId) => context.live.channels.connect(tenantId, input, key),
    (connection) =>
      t(
        context.state,
        `أُضيفت القناة ${connection.display_name} — لم تُثبت جاهزيتها بعد`,
        `Added ${connection.display_name} — it is not working yet`,
      ),
  );
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
            `رفض المزوّد: ${connection.last_error_code}`,
            `The provider refused: ${connection.last_error_code}`,
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
  await loadPeopleScreen(context);
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
  await loadChannelsScreen(context);
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

export function changeStatus(
  context: LiveContext,
  membershipId: string,
  status: string,
): Promise<boolean> {
  return mutate(
    context,
    `status:${membershipId}`,
    (tenantId) => context.live.api.updateMembership(tenantId, membershipId, { status }),
    (person) => t(context.state, `الحالة الآن ${person.status}`, `Status is now ${person.status}`),
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

function resetResources(live: LiveState): void {
  const gone = failed<never>({
    code: 'signed_out',
    message: 'Sign in to see this.',
    requestId: null,
    status: 401,
    details: [],
  });
  live.people = gone;
  live.roles = gone;
  live.teams = gone;
  live.invitations = gone;
  live.permissions = gone;
  live.transfers = gone;
  live.connections = gone;
  live.catalogue = gone;
}
