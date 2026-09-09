import type { ScopeRef } from '../api/people.js';
import type { LiveContext } from './actions.js';
import { rowsOf } from './store.js';
import {
  addTeamMember,
  archiveTeam,
  changeRole,
  changeScopes,
  changeStatus,
  createRole,
  createTeam,
  deleteRole,
  invitePerson,
  loadPeopleScreen,
  loadSession,
  offerOwnership,
  removeTeamMember,
  renameRole,
  revokeInvitation,
  settleOwnership,
  signIn,
  signOut,
} from './actions.js';

/**
 * The `live-*` half of the action table.
 *
 * These are kept apart from the demo actions because they are asynchronous and
 * because it should be obvious, from the name of a control, whether clicking it
 * reaches the server. Every handler returns a promise; the caller re-renders
 * when it settles, and each handler has already re-rendered once to show its
 * own pending state.
 */
export type LiveHandler = (context: LiveContext, arg: string) => Promise<unknown>;

/**
 * Splits `"<id>:<value>"`, which is how a select carries both.
 *
 * Total by construction: an argument with no separator is all id and no value,
 * which is what a control rendered without a form key would produce. Returning
 * that rather than throwing keeps a malformed control from taking the screen
 * down, and the empty value is then rejected by the parser on the server.
 */
export function splitArg(arg: string): { readonly id: string; readonly value: string } {
  const separator = arg.indexOf(':');
  return separator === -1
    ? { id: arg, value: '' }
    : { id: arg.slice(0, separator), value: arg.slice(separator + 1) };
}

function form(context: LiveContext, key: string): string {
  return (context.state.dialogForm[key] ?? '').trim();
}

/** Clears the fields a form owns once the server has accepted it. */
function clearForm(context: LiveContext, keys: readonly string[]): void {
  const next = { ...context.state.dialogForm };
  for (const key of keys) {
    delete next[key];
  }
  context.state.dialogForm = next;
}

const TENANT_SCOPE: readonly ScopeRef[] = [{ type: 'tenant', id: null }];

/**
 * The form key for a team's "add a member" select.
 *
 * It is built in one place because the DOM carries a form value as
 * `"<key>:<value>"` and the generic collector splits on the first colon — so a
 * key containing one silently stores the wrong thing under the wrong name.
 */
export function teamMemberField(teamId: string): string {
  return `teamMember_${teamId}`;
}

/** The form key for a custom role's rename field, for the same reason. */
export function roleNameField(roleId: string): string {
  return `roleName_${roleId}`;
}

export const LIVE_ACTIONS: Readonly<Record<string, LiveHandler>> = {
  'live-signin': async (context) => {
    await signIn(context, form(context, 'signinEmail'), form(context, 'signinPassword'));
    // The password never stays in state after the attempt, whatever the answer.
    clearForm(context, ['signinPassword']);
    context.refresh();
  },

  'live-signout': async (context) => signOut(context),

  'live-reload': async (context) => {
    await loadSession(context);
    await loadPeopleScreen(context);
  },

  'live-invite': async (context) => {
    const email = form(context, 'inviteEmail');
    const roleId = form(context, 'inviteRole');
    const accepted = await invitePerson(context, email, roleId, []);
    if (accepted) {
      clearForm(context, ['inviteEmail', 'inviteRole']);
      context.refresh();
    }
  },

  'live-revoke-invite': async (context, arg) => revokeInvitation(context, arg),

  'live-role': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return changeRole(context, id, value);
  },

  'live-status': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return changeStatus(context, id, value);
  },

  'live-scope-tenant': async (context, arg) => changeScopes(context, arg, TENANT_SCOPE),

  'live-create-role': async (context) => {
    // No fallbacks: the control is disabled until a permission and a scope have
    // been chosen, so a default here would only ever paper over a rendering bug
    // by inventing a grant nobody picked.
    const created = await createRole(context, form(context, 'roleName'), '', [
      { permission: form(context, 'roleGrant'), scope: form(context, 'roleScope') },
    ]);
    if (created) {
      clearForm(context, ['roleName', 'roleGrant', 'roleScope']);
      context.refresh();
    }
  },

  'live-delete-role': async (context, arg) => deleteRole(context, arg),

  'live-create-team': async (context) => {
    const created = await createTeam(context, form(context, 'teamName'));
    if (created) {
      clearForm(context, ['teamName']);
      context.refresh();
    }
  },

  'live-archive-team': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return archiveTeam(context, id, value !== 'restore');
  },

  'live-remove-member': async (context, arg) => {
    const { id, value } = splitArg(arg);
    return removeTeamMember(context, id, value);
  },

  'live-rename-role': async (context, arg) => {
    // The grants are resent from the role the server reported, so the rename
    // is refused outright if this browser has never seen that role.
    const role = rowsOf(context.live.roles).find((entry) => entry.id === arg);
    if (role === undefined) {
      return false;
    }
    const renamed = await renameRole(context, role, form(context, roleNameField(arg)));
    if (renamed) {
      clearForm(context, [roleNameField(arg)]);
      context.refresh();
    }
    return renamed;
  },

  'live-team-add': async (context, arg) => {
    const membershipId = form(context, teamMemberField(arg));
    const added = await addTeamMember(context, arg, membershipId);
    if (added) {
      clearForm(context, [teamMemberField(arg)]);
      context.refresh();
    }
  },

  'live-offer-ownership': async (context, arg) => offerOwnership(context, arg),

  'live-ownership': async (context, arg) => {
    const { id, value } = splitArg(arg);
    if (value !== 'accept' && value !== 'decline' && value !== 'cancel') {
      return false;
    }
    return settleOwnership(context, id, value);
  },
};

/** Runs a `live-*` action, or reports that the name is not one. */
export function runLiveAction(context: LiveContext, name: string, arg: string): Promise<unknown> | null {
  const handler = LIVE_ACTIONS[name];
  return handler === undefined ? null : handler(context, arg);
}
